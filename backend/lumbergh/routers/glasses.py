"""The HUD's only read: one request for the whole fleet, pre-shrunk.

Deliberately does NOT reuse `bill.wait_fleet`. That marks rows seen on the way
out, which clears `session_attention` — the user's own dashboard overlay. A pair
of glasses long-polling in a pocket must not ack sessions the user never opened,
so this wake loop stamps attention and stops there.

Attention is `fleet.ATTENTION_STATES` over every row, not Bill's viewer-scoped
`_stamp_attention` and not `fleet.needs_attention`. The glasses are the user's
view of the *whole* fleet, not a node in Bill's overseer/worker tree — no session
has an overseer named "glasses", so a viewer-scoped stamp is empty by
construction. But the dashboard's own predicate is too broad in the other
direction: it counts idle+unseen, and `unseen` is true of every session the user
ever left mid-thought, so the HUD would wake on ten quiet sessions and never go
dark. Idle is not asking. Idle sessions stay in the deck, browsable, with their
outcome line; they just never wake the wearer.
"""

import asyncio
import contextlib
import json
import logging
import time
from pathlib import Path

from fastapi import APIRouter, WebSocket
from websockets.asyncio.client import connect as ws_connect

from lumbergh import fleet
from lumbergh.activity.resolve import resolve_adapter
from lumbergh.activity.resolve import session_meta as _meta
from lumbergh.detect import regions
from lumbergh.glasses import board, summarize
from lumbergh.idle_monitor import tmux_ref
from lumbergh.routers.bill import _fleet_rows
from lumbergh.tmux_pty import capture_pane_text

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/glasses")

_POLL_INTERVAL = 1.5
_MAX_WAIT_TIMEOUT = 300.0
_QUESTION_REGION = "recent_lines(12)"


def _question_of(target: str) -> str:
    """The pane text a blocked session is blocking on."""
    try:
        lines = regions.extract(_QUESTION_REGION, capture_pane_text(tmux_ref(target)), "")
    except Exception:
        logger.info("glasses: could not read pane for %s", target, exc_info=True)
        return ""
    return "\n".join(lines)


def _activity_of(target: str) -> str:
    """What a working session last said."""
    try:
        meta = _meta(target)
        cwd = Path(meta["workdir"]) if meta.get("workdir") else None
        adapter = resolve_adapter(target, cwd, meta.get("agent_provider"))
        if adapter is None:
            return ""
        for event in reversed(adapter.read_new()):
            if event.type == "agent_message" and (event.text or "").strip():
                return event.text or ""
        return ""
    except Exception:
        logger.info("glasses: could not read activity for %s", target, exc_info=True)
        return ""


def _provider():
    """The summarizer's own provider, deliberately not the dashboard's.

    The dashboard's AI provider is whatever the user picked for commit messages —
    on this machine `claude_cli`, which the design rules out for a view that
    refreshes on every fleet change. Unconfigured means no provider at all: lines
    stay deterministic, which is a working HUD rather than a stalled one.
    """
    from lumbergh.ai.providers import OpenAICompatibleProvider
    from lumbergh.routers.settings import get_settings

    try:
        cfg = ((get_settings().get("glasses") or {}).get("summarizer")) or {}
    except Exception:
        logger.info("glasses: could not read settings; lines stay deterministic", exc_info=True)
        return None
    base_url = cfg.get("baseUrl") or ""
    if not base_url:
        return None
    return OpenAICompatibleProvider(
        base_url=base_url,
        api_key=cfg.get("apiKey") or "",
        model=cfg.get("model") or "default",
    )


async def _rows(with_outcome: bool) -> list[dict]:
    """The fleet, each row stamped with whether it needs the wearer.

    ``with_outcome`` mirrors ``bill._fleet_rows``' own split: reading each
    worker's contracted final line is a transcript read per session, so it is
    only worth paying for on the snapshot actually handed back, never on every
    iteration of a continuously-held poll. Attention never depends on the
    outcome text, so this flag cannot change whether the wearer wakes.
    """
    loop = asyncio.get_running_loop()
    # `_fleet_rows` shells out to tmux and git per repo; never on the event loop.
    rows = await loop.run_in_executor(None, _fleet_rows, None, with_outcome)
    for row in rows:
        row["attention"] = row["state"] in fleet.ATTENTION_STATES
    return rows


def _woke(rows: list[dict]) -> bool:
    return any(row["attention"] for row in rows)


async def _deck(rows: list[dict]) -> list[dict]:
    """The rows rendered as cards, one summarized line each.

    Only ever called for a snapshot that is actually returned: a pane capture per
    attention row, a transcript read per working row, a settings read and a
    summarization pass are all far too expensive to repeat on a 1.5s poll.
    """
    loop = asyncio.get_running_loop()
    provider = await loop.run_in_executor(None, _provider)

    async def line_of(text: str, fp: str) -> str:
        return await summarize.short_line(text, fp, provider)

    questions, activities = {}, {}
    for row in rows:
        target = row.get("target") or row.get("session")
        if not target:
            continue
        if row["state"] in board.ATTENTION_FIRST:
            questions[target] = await loop.run_in_executor(None, _question_of, target)
        elif row["state"] == "working":
            activities[target] = await loop.run_in_executor(None, _activity_of, target)

    return await board.build_deck(
        rows,
        question_of=lambda t: questions.get(t, ""),
        activity_of=lambda t: activities.get(t, ""),
        line_of=line_of,
    )


@router.get("/board")
async def get_board(wait: bool = False, timeout: float = 300.0):
    if not wait:
        rows = await _rows(with_outcome=True)
        return {"cards": await _deck(rows), "woke": _woke(rows), "waited": 0.0}

    timeout = min(max(timeout, 0.0), _MAX_WAIT_TIMEOUT)
    deadline = time.monotonic() + timeout
    start = time.monotonic()
    while True:
        rows = await _rows(with_outcome=False)
        if _woke(rows) or time.monotonic() >= deadline:
            # Outcomes are read once, on the way out, rather than on every poll —
            # see `_rows`.
            rows = await _rows(with_outcome=True)
            return {
                "cards": await _deck(rows),
                "woke": _woke(rows),
                "waited": round(time.monotonic() - start, 1),
            }
        await asyncio.sleep(_POLL_INTERVAL)


# WhisperLive speaks plain ws:// and terminates no TLS of its own. The HUD, however,
# is served over HTTPS on the tailnet, and a browser refuses an insecure socket from
# a secure page — so a direct ws:// from the page is blocked as mixed content. These
# defaults match the user's blurt setup; override them under settings["glasses"]["stt"].
_STT_DEFAULT_HOST = "llmbox"
_STT_DEFAULT_PORT = 9091
_STT_MAX_FRAME = 2**24


def _stt_target() -> tuple[str, int]:
    from lumbergh.routers.settings import get_settings

    try:
        cfg = ((get_settings().get("glasses") or {}).get("stt")) or {}
    except Exception:
        logger.info("glasses: could not read STT settings; using defaults", exc_info=True)
        cfg = {}
    try:
        port = int(cfg.get("port") or _STT_DEFAULT_PORT)
    except (TypeError, ValueError):
        port = _STT_DEFAULT_PORT
    return cfg.get("host") or _STT_DEFAULT_HOST, port


async def _pump_to_upstream(client: WebSocket, upstream) -> None:
    """Client -> WhisperLive, preserving frame type.

    The frame type is load-bearing both ways: the handshake is a JSON *text* frame and
    the audio that follows is *binary* float32. Collapsing either into the other makes
    WhisperLive discard the stream silently.
    """
    while True:
        message = await client.receive()
        if message["type"] == "websocket.disconnect":
            return
        data = message.get("bytes")
        if data is None:
            data = message.get("text")
        if data is not None:
            await upstream.send(data)


async def _pump_to_client(client: WebSocket, upstream) -> None:
    async for frame in upstream:
        if isinstance(frame, bytes):
            await client.send_bytes(frame)
        else:
            await client.send_text(frame)


@router.get("/sessions/{name}/detail")
async def detail(name: str, last: int = 40):
    """Recent turns for one session, so the wearer can read back through time.

    The board's one line per session is built for a glance and deliberately says almost
    nothing; this is the drill-in. Tool calls collapse to their name — on a 576x288 lens
    frame their bodies are noise, and it is the agent's own words the wearer came for.
    """
    loop = asyncio.get_running_loop()
    return {"session": name, "turns": await loop.run_in_executor(None, _turns_of, name, last)}


_SPEAKER = {"user_message": "you", "agent_message": "agent", "thinking": "thinking"}


def _turns_of(target: str, last: int) -> list[dict]:
    try:
        meta = _meta(target)
        cwd = Path(meta["workdir"]) if meta.get("workdir") else None
        adapter = resolve_adapter(target, cwd, meta.get("agent_provider"))
        if adapter is None:
            return []
        events = adapter.read_new()
    except Exception:
        logger.info("glasses: could not read turns for %s", target, exc_info=True)
        return []

    turns: list[dict] = []
    for event in events:
        if event.type == "tool_call":
            # A marker, carrying nothing. Measured on a real session: tool summaries
            # averaged 842 characters against 96 for the agent's prose and outnumbered it
            # 34 to 6, so their bodies buried the words the wearer opened the reader to
            # read. Even the tool's name and a run count are more than a glance wants —
            # that something ran is the whole signal. The client draws it as a rule,
            # sized to the frame, so the width belongs to the renderer not to this.
            if not (turns and turns[-1]["who"] == "tool"):
                turns.append({"who": "tool"})
            continue
        who = _SPEAKER.get(event.type)
        if who is None:
            continue
        text = board.strip_chrome(event.text or "")
        if text:
            turns.append({"who": who, "text": text})
    return turns[-max(1, min(last, 200)) :]


@router.post("/probe")
async def probe(payload: dict):
    """Diagnostics from inside the Even app's WebView, which has no console.

    The HUD renders on the phone but the glasses show only what is pushed through the
    SDK's container API, so working out what that WebView actually exposes has to happen
    from inside it. The page cannot show much — it is a clipped 576x288 frame — so it
    reports here and the answer is read out of the log instead.
    """
    body = json.dumps(payload, indent=2, default=str)
    # A terminal pane truncates a long line, so the full report goes to a file and the
    # log carries only a pointer to it.
    path = Path.home() / ".config" / "lumbergh" / "glasses-probe.json"
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        # Appended, not overwritten: a sequence of events is the interesting part, and
        # each report is small.
        with path.open("a") as fh:
            fh.write(body + "\n")
    except OSError:
        logger.info("glasses probe (unwritable, inline): %s", body[:2000])
        return {"logged": True, "path": None}
    logger.info("glasses probe written to %s (%d bytes)", path, len(body))
    return {"logged": True, "path": str(path)}


@router.websocket("/stt")
async def stt_proxy(websocket: WebSocket):
    """Same-origin bridge to WhisperLive, so dictation works from an HTTPS page.

    The browser speaks wss:// to Lumbergh on the page's own origin; Lumbergh speaks
    plain ws:// onward. This also means the STT host is configured server-side rather
    than baked into a page the glasses load.
    """
    host, port = _stt_target()
    await websocket.accept()
    try:
        async with ws_connect(f"ws://{host}:{port}", max_size=_STT_MAX_FRAME) as upstream:
            tasks = {
                asyncio.create_task(_pump_to_upstream(websocket, upstream)),
                asyncio.create_task(_pump_to_client(websocket, upstream)),
            }
            # Either side hanging up ends the session; the survivor is cancelled rather
            # than left pumping into a closed socket.
            _, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            for task in pending:
                task.cancel()
            for task in pending:
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await task
    except Exception:
        logger.info("glasses: STT proxy to %s:%s failed", host, port, exc_info=True)
    with contextlib.suppress(Exception):
        await websocket.close()
