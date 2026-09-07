# Glasses HUD Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Supervise the Lumbergh fleet from Even Realities G2 glasses — glance at what each session is doing, and dictate a reply to one that is asking.

**Architecture:** A new `GET /api/glasses/board` endpoint wraps the existing fleet snapshot and returns one <=34-character line per session, compressed by a local LLM with a deterministic fallback. A dependency-free web page (the future G2 plugin) renders those as a swipeable deck and streams dictated audio straight to the existing WhisperLive server, posting the final text to the existing agent prompt endpoint.

**Tech Stack:** Python 3.11+, FastAPI, pytest; vanilla ES modules (no build step — the `evenhub` plugin shell wants plain web assets); WhisperLive over WebSocket; LiteLLM proxy via `OpenAICompatibleProvider`.

**Spec:** `docs/superpowers/specs/2026-09-07-glasses-hud-design.md`

## Global Constraints

- **Line budget: 34 characters.** The G2 renders 576x288 px monochrome per eye; every `line` field is hard-bounded at 34 chars. The constant lives in one place: `lumbergh.glasses.summarize.LINE_MAX`.
- **The HUD never waits on an LLM.** Summarization runs under a hard timeout and degrades to truncated raw text on any failure. It must never raise into a request.
- **The glasses must never ack the dashboard.** Do NOT call `routers.bill._mark_seen` from glasses code. It clears `session_attention` unseen flags, which are the *user's own dashboard overlay*; a background long poll calling it would silently mark sessions seen that the user never looked at. The glasses wake loop uses `_fleet_rows` + `_stamp_attention` only.
- **`_fleet_rows` is expensive** — it shells out to tmux and `git worktree list` per repo. Every call goes through `loop.run_in_executor`, never the event loop directly. Poll interval is human-scale (1.5s), matching `routers/bill.py`.
- **A card's display name and its prompt target are different fields.** `row["task"]` is what the wearer reads; `row["target"] or row["session"]` is what `POST /api/agent/sessions/{name}/prompt` needs. Never conflate them.
- **No frontend build step for the glasses client.** It is plain ES modules under `glasses/`, served by a static mount. It is deliberately not part of the Vite app.
- **Auth is deferred** by explicit decision ("prove it out then we lock it down"). The prototype relies on Tailscale reachability. Do not widen `/api/agent/*` beyond its documented localhost/token posture to make this work.
- Run `./lint.sh` before considering any task done.
- Do NOT run the E2E suites locally. `./test/e2e-vm.sh` is the only supported path.

## File Structure

| File | Responsibility |
|------|----------------|
| `backend/lumbergh/glasses/__init__.py` | Package marker |
| `backend/lumbergh/glasses/summarize.py` | One text -> one short line. Fingerprint cache, hard timeout, deterministic fallback. Knows nothing about fleets. |
| `backend/lumbergh/glasses/board.py` | Fleet rows -> ordered deck of HUD cards. Pure; takes its text sources as callables so it is testable without tmux. |
| `backend/lumbergh/routers/glasses.py` | HTTP surface: `GET /api/glasses/board`, with the long-poll wake loop. Wires board.py to the real fleet/pane/adapter sources. |
| `backend/lumbergh/main.py` | Register the router; mount `glasses/` static **before** `mount_frontend(app)` |
| `backend/lumbergh/tests/test_glasses_summarize.py` | Cache, bound, degradation |
| `backend/lumbergh/tests/test_glasses_board.py` | Line-source selection per state, deck ordering |
| `backend/lumbergh/tests/test_glasses_router.py` | Endpoint shape, wait behaviour, no-mark-seen |
| `glasses/index.html` | The 576x288 page: layout and mount points |
| `glasses/board.js` | Fetch/long-poll the board, expose cards |
| `glasses/deck.js` | Deck state machine: zero state, selection, stable ordering |
| `glasses/dictate.js` | Mic -> WhisperLive -> partials -> commit/cancel |
| `glasses/stt-config.js` | `initial_prompt` + `hotwords`, copied from the user's blurt config |
| `glasses/plugin/app.json` | `evenhub` plugin manifest (last task) |

---

### Task 1: Short-line summarizer

**Files:**
- Create: `backend/lumbergh/glasses/__init__.py`
- Create: `backend/lumbergh/glasses/summarize.py`
- Test: `backend/lumbergh/tests/test_glasses_summarize.py`

**Interfaces:**
- Consumes: `lumbergh.ai.providers.AIProvider` (has `async complete(prompt: str) -> str`)
- Produces:
  - `LINE_MAX: int = 34`
  - `def truncate_line(text: str, limit: int = LINE_MAX) -> str`
  - `def fingerprint(text: str) -> str`
  - `async def short_line(text: str, fp: str, provider: AIProvider | None, timeout: float = 2.0) -> str`
  - `def clear_cache() -> None`

- [ ] **Step 1: Write the failing tests**

```python
# backend/lumbergh/tests/test_glasses_summarize.py
import asyncio

import pytest

from lumbergh.glasses import summarize


class FakeProvider:
    def __init__(self, reply="", delay=0.0, boom=False):
        self.reply = reply
        self.delay = delay
        self.boom = boom
        self.calls = 0

    async def complete(self, prompt):
        self.calls += 1
        if self.delay:
            await asyncio.sleep(self.delay)
        if self.boom:
            raise RuntimeError("provider down")
        return self.reply


@pytest.fixture(autouse=True)
def _clean():
    summarize.clear_cache()
    yield
    summarize.clear_cache()


def test_truncate_line_respects_budget():
    assert summarize.truncate_line("x" * 100) == "x" * 33 + "…"
    assert summarize.truncate_line("short") == "short"


def test_truncate_line_collapses_whitespace():
    assert summarize.truncate_line("a\n  b\tc") == "a b c"


async def test_short_line_uses_provider():
    p = FakeProvider(reply="running the test suite")
    assert await summarize.short_line("blah blah", "fp1", p) == "running the test suite"


async def test_short_line_bounds_a_chatty_provider():
    p = FakeProvider(reply="a" * 200)
    assert len(await summarize.short_line("blah", "fp2", p)) == summarize.LINE_MAX


async def test_short_line_caches_by_fingerprint():
    p = FakeProvider(reply="cached")
    await summarize.short_line("text", "same-fp", p)
    await summarize.short_line("text", "same-fp", p)
    assert p.calls == 1


async def test_short_line_falls_back_on_error():
    p = FakeProvider(boom=True)
    out = await summarize.short_line("Ran the migration and it worked. Next up.", "fp3", p)
    assert out.startswith("Ran the migration")


async def test_short_line_falls_back_on_timeout():
    p = FakeProvider(reply="too late", delay=0.5)
    out = await summarize.short_line("Waiting on review", "fp4", p, timeout=0.01)
    assert out == "Waiting on review"


async def test_short_line_does_not_cache_a_fallback():
    p = FakeProvider(boom=True)
    await summarize.short_line("Some status text", "fp5", p)
    p.boom = False
    p.reply = "real summary"
    assert await summarize.short_line("Some status text", "fp5", p) == "real summary"


async def test_short_line_without_provider_is_the_fallback():
    assert await summarize.short_line("Doing a thing", "fp6", None) == "Doing a thing"


async def test_short_line_of_empty_text_is_empty():
    assert await summarize.short_line("   ", "fp7", FakeProvider(reply="nope")) == ""
```

Note: `backend/pyproject.toml` sets `asyncio_mode = "auto"`, so async tests need
no `@pytest.mark.asyncio` decorator. This holds for every task in this plan.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && uv run pytest lumbergh/tests/test_glasses_summarize.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'lumbergh.glasses'`

- [ ] **Step 3: Implement the module**

```python
# backend/lumbergh/glasses/__init__.py
"""The glasses HUD: a radically compressed view of the fleet for Even G2."""
```

```python
# backend/lumbergh/glasses/summarize.py
"""One line of text, small enough for a 576x288 monochrome HUD.

The HUD refreshes on every fleet change and most refreshes change nothing, so
lines are cached by a fingerprint of their source text. Summarization is a
best-effort embellishment on a deterministic truncation: a slow or broken
provider degrades the line, never the board.
"""

import asyncio
import hashlib
import logging

logger = logging.getLogger(__name__)

LINE_MAX = 34
_CACHE_LIMIT = 512
_cache: dict[str, str] = {}

_PROMPT = (
    "Compress this status into at most {limit} characters. "
    "Reply with the compressed text only — no quotes, no preamble, no trailing period. "
    "Keep identifiers, file names and commands verbatim.\n\n{text}"
)


def fingerprint(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8", "replace")).hexdigest()[:16]


def truncate_line(text: str, limit: int = LINE_MAX) -> str:
    flat = " ".join(text.split())
    if len(flat) <= limit:
        return flat
    return flat[: limit - 1] + "…"


def clear_cache() -> None:
    _cache.clear()


def _remember(fp: str, line: str) -> None:
    # A plain dict with a size ceiling: the board's working set is the live fleet,
    # so eviction order does not matter, only that it cannot grow without bound.
    if len(_cache) >= _CACHE_LIMIT:
        _cache.clear()
    _cache[fp] = line


async def short_line(text, fp, provider, timeout: float = 2.0) -> str:
    """A <=LINE_MAX line for ``text``, cached under ``fp``.

    Only a provider-produced line is cached. Caching a fallback would pin the
    degraded text for as long as the pane sat unchanged, which is exactly the
    situation in which the wearer most wants the real summary.
    """
    fallback = truncate_line(text)
    if not fallback:
        return ""
    cached = _cache.get(fp)
    if cached is not None:
        return cached
    if provider is None:
        return fallback
    try:
        raw = await asyncio.wait_for(
            provider.complete(_PROMPT.format(limit=LINE_MAX, text=text)),
            timeout=timeout,
        )
    except Exception:
        # Any failure degrades: timeout, HTTP error, a provider that returns junk.
        # asyncio.TimeoutError is an Exception subclass on 3.11+, so one clause covers it.
        logger.info("glasses: summarizer unavailable, using truncated text", exc_info=True)
        return fallback
    line = truncate_line(raw or "")
    if not line:
        return fallback
    _remember(fp, line)
    return line
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && uv run pytest lumbergh/tests/test_glasses_summarize.py -v`
Expected: PASS (10 tests)

- [ ] **Step 5: Lint and commit**

```bash
./lint.sh
git add backend/lumbergh/glasses/ backend/lumbergh/tests/test_glasses_summarize.py
git commit -m "feat(glasses): short-line summarizer with a deterministic fallback"
```

---

### Task 2: Board builder

**Files:**
- Create: `backend/lumbergh/glasses/board.py`
- Test: `backend/lumbergh/tests/test_glasses_board.py`

**Interfaces:**
- Consumes: `summarize.short_line`, `summarize.fingerprint`, `summarize.truncate_line`, `summarize.LINE_MAX`
- Produces:
  - `ATTENTION_FIRST: tuple[str, ...]`
  - `def sort_key(card: dict) -> tuple`
  - `async def build_deck(rows: list[dict], question_of, activity_of, line_of) -> list[dict]`
    - `question_of(target: str) -> str` — recent pane text for a blocked session
    - `activity_of(target: str) -> str` — last assistant turn for a working session
    - `line_of(text: str, fp: str) -> Awaitable[str]` — the summarizer, pre-bound to a provider
  - Card shape: `{"name": str, "target": str, "state": str, "since": int | None, "line": str, "needs": bool}`

- [ ] **Step 1: Write the failing tests**

```python
# backend/lumbergh/tests/test_glasses_board.py
import pytest

from lumbergh.glasses import board, summarize


def row(task, state, **kw):
    base = {
        "task": task,
        "session": task,
        "target": kw.pop("target", task),
        "state": state,
        "since": kw.pop("since", 10),
        "attention": kw.pop("attention", False),
        "outcome": kw.pop("outcome", None),
    }
    base.update(kw)
    return base


async def _deck(rows, questions=None, activities=None):
    questions = questions or {}
    activities = activities or {}
    return await board.build_deck(
        rows,
        question_of=lambda t: questions.get(t, ""),
        activity_of=lambda t: activities.get(t, ""),
        line_of=lambda text, fp: _identity(text),
    )


async def _identity(text):
    return summarize.truncate_line(text)


async def test_blocked_card_line_comes_from_the_question():
    deck = await _deck(
        [row("kb-1", "blocked")],
        questions={"kb-1": "Do you want to force-push to rc?"},
        activities={"kb-1": "should not be used"},
    )
    assert deck[0]["line"] == "Do you want to force-push to rc?"


async def test_working_card_line_comes_from_activity():
    deck = await _deck(
        [row("kb-1", "working")],
        questions={"kb-1": "should not be used"},
        activities={"kb-1": "Editing DiffViewer.tsx"},
    )
    assert deck[0]["line"] == "Editing DiffViewer.tsx"


async def test_idle_card_line_is_the_outcome():
    deck = await _deck([row("kb-1", "idle", outcome="DELIVERED: split the panes")])
    assert deck[0]["line"] == "DELIVERED: split the panes"


async def test_idle_card_without_an_outcome_has_no_line():
    deck = await _deck([row("kb-1", "idle")])
    assert deck[0]["line"] == ""


async def test_card_carries_display_name_and_prompt_target_separately():
    deck = await _deck([row("kb-1", "working", target="kb-1:0")])
    assert deck[0]["name"] == "kb-1"
    assert deck[0]["target"] == "kb-1:0"


async def test_needs_mirrors_the_stamped_attention_flag():
    deck = await _deck([row("kb-1", "blocked", attention=True)])
    assert deck[0]["needs"] is True


async def test_line_never_exceeds_the_budget():
    deck = await _deck(
        [row("kb-1", "working")], activities={"kb-1": "y" * 300}
    )
    assert len(deck[0]["line"]) <= summarize.LINE_MAX


async def test_deck_is_ordered_attention_then_working_then_idle_then_dead():
    rows = [
        row("d", "dead"),
        row("i", "idle"),
        row("w", "working"),
        row("b", "blocked"),
        row("e", "error"),
    ]
    deck = await _deck(rows)
    assert [c["name"] for c in deck][:2] == ["b", "e"] or [c["name"] for c in deck][:2] == ["e", "b"]
    assert [c["name"] for c in deck][2:] == ["w", "i", "d"]


async def test_ties_break_on_longest_waiting_first():
    deck = await _deck([row("new", "blocked", since=5), row("old", "blocked", since=900)])
    assert [c["name"] for c in deck] == ["old", "new"]


async def test_a_row_missing_a_target_is_skipped_not_fatal():
    deck = await _deck([row("ghost", "working", target=None, session=None)])
    assert deck == []
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && uv run pytest lumbergh/tests/test_glasses_board.py -v`
Expected: FAIL — `ImportError: cannot import name 'board'`

- [ ] **Step 3: Implement the module**

```python
# backend/lumbergh/glasses/board.py
"""Fleet rows -> an ordered deck of HUD cards.

Pure by construction: the text sources arrive as callables, so the whole deck
is testable without tmux, a git worktree or a provider. The router supplies the
real ones.
"""

from lumbergh.glasses import summarize

# Ordering is the wearer's priority, not the fleet's: anything wanting a human
# comes first, then anything alive, then anything finished, then corpses.
ATTENTION_FIRST = ("blocked", "error", "undelivered")
_RANK = {state: 0 for state in ATTENTION_FIRST} | {"working": 1, "idle": 2, "dead": 3}


def sort_key(card: dict) -> tuple:
    # Longest-waiting first within a rank: a session blocked for 20 minutes is a
    # worse thing to leave sitting than one blocked for 20 seconds.
    return (_RANK.get(card["state"], 2), -(card["since"] or 0))


def _source_text(row: dict, question_of, activity_of) -> str:
    state = row["state"]
    if state in ATTENTION_FIRST:
        return question_of(row["target"]) or ""
    if state == "working":
        return activity_of(row["target"]) or ""
    if state == "idle":
        return row.get("outcome") or ""
    return ""


async def build_deck(rows: list[dict], question_of, activity_of, line_of) -> list[dict]:
    cards = []
    for row in rows:
        target = row.get("target") or row.get("session")
        if not target:
            # A tracked task with no live session (never started, already reaped) has
            # nothing to render and nothing to prompt. The dashboard shows it; the HUD
            # has six lines and cannot afford it.
            continue
        card = {
            "name": row.get("task") or target,
            "target": target,
            "state": row["state"],
            "since": row.get("since"),
            "needs": bool(row.get("attention")),
            "line": "",
        }
        text = _source_text({**row, "target": target}, question_of, activity_of)
        if text:
            card["line"] = summarize.truncate_line(
                await line_of(text, summarize.fingerprint(text))
            )
        cards.append(card)
    cards.sort(key=sort_key)
    return cards
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && uv run pytest lumbergh/tests/test_glasses_board.py -v`
Expected: PASS (10 tests)

- [ ] **Step 5: Lint and commit**

```bash
./lint.sh
git add backend/lumbergh/glasses/board.py backend/lumbergh/tests/test_glasses_board.py
git commit -m "feat(glasses): build an attention-ordered deck of HUD cards from fleet rows"
```

---

### Task 3: The board endpoint

**Files:**
- Create: `backend/lumbergh/routers/glasses.py`
- Modify: `backend/lumbergh/main.py` (add `app.include_router(glasses_router.router)` alongside the others at lines 175-187)
- Test: `backend/lumbergh/tests/test_glasses_router.py`

**Interfaces:**
- Consumes: `board.build_deck`, `summarize.short_line`, `routers.bill._fleet_rows`, `routers.bill._stamp_attention`, `detect.regions.extract`, `activity.resolve.resolve_adapter`, `activity.resolve.session_meta`, `tmux_pty.capture_pane_text`, `idle_monitor.tmux_ref`, `ai.providers.get_provider`, `routers.settings.get_settings`
- Produces: `GET /api/glasses/board` -> `{"cards": [...], "woke": bool, "waited": float}`; query params `wait: bool = False`, `timeout: float = 300.0`

- [ ] **Step 1: Write the failing tests**

```python
# backend/lumbergh/tests/test_glasses_router.py
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import lumbergh.routers.glasses as glasses


@pytest.fixture
def rows():
    return [
        {
            "task": "kb-1",
            "session": "kb-1",
            "target": "kb-1",
            "state": "blocked",
            "since": 120,
            "attention": True,
            "outcome": None,
        },
        {
            "task": "kb-2",
            "session": "kb-2",
            "target": "kb-2",
            "state": "working",
            "since": 30,
            "attention": False,
            "outcome": None,
        },
    ]


@pytest.fixture
def client(monkeypatch, rows):
    monkeypatch.setattr(glasses, "_fleet_rows", lambda origin=None: rows)
    monkeypatch.setattr(glasses, "_stamp_attention", lambda r, viewer: r)
    monkeypatch.setattr(glasses, "_question_of", lambda t: "Do you want to push?")
    monkeypatch.setattr(glasses, "_activity_of", lambda t: "editing board.py")
    monkeypatch.setattr(glasses, "_provider", lambda: None)
    app = FastAPI()
    app.include_router(glasses.router)
    return TestClient(app)


def test_board_returns_cards_attention_first(client):
    body = client.get("/api/glasses/board").json()
    assert [c["name"] for c in body["cards"]] == ["kb-1", "kb-2"]
    assert body["cards"][0]["needs"] is True


def test_board_lines_are_state_appropriate(client):
    cards = client.get("/api/glasses/board").json()["cards"]
    assert cards[0]["line"] == "Do you want to push?"
    assert cards[1]["line"] == "editing board.py"


def test_board_lines_respect_the_budget(client):
    for card in client.get("/api/glasses/board").json()["cards"]:
        assert len(card["line"]) <= 34


def test_board_reports_whether_anything_needs_the_wearer(client):
    assert client.get("/api/glasses/board").json()["woke"] is True


def test_board_never_marks_sessions_seen(client, monkeypatch):
    """The dashboard's unseen overlay is the user's, not the HUD's."""
    import lumbergh.routers.bill as bill

    called = []
    monkeypatch.setattr(bill, "_mark_seen", lambda *a, **k: called.append(a))
    client.get("/api/glasses/board?wait=true&timeout=0")
    client.get("/api/glasses/board")
    assert called == []


def test_wait_returns_immediately_when_something_already_needs_attention(client):
    body = client.get("/api/glasses/board?wait=true&timeout=30").json()
    assert body["woke"] is True
    assert body["waited"] < 5


def test_wait_gives_up_at_the_timeout_when_all_is_quiet(client, rows):
    for r in rows:
        r["attention"] = False
        r["state"] = "working"
    body = client.get("/api/glasses/board?wait=true&timeout=0").json()
    assert body["woke"] is False
    assert body["cards"]
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && uv run pytest lumbergh/tests/test_glasses_router.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'lumbergh.routers.glasses'`

- [ ] **Step 3: Implement the router**

```python
# backend/lumbergh/routers/glasses.py
"""The HUD's only read: one request for the whole fleet, pre-shrunk.

Deliberately does NOT reuse `bill.wait_fleet`. That marks rows seen on the way
out, which clears `session_attention` — the user's own dashboard overlay. A pair
of glasses long-polling in a pocket must not ack sessions the user never opened,
so this wake loop stamps attention and stops there.
"""

import asyncio
import logging
import time
from pathlib import Path

from fastapi import APIRouter

from lumbergh.activity.resolve import resolve_adapter
from lumbergh.activity.resolve import session_meta as _meta
from lumbergh.detect import regions
from lumbergh.glasses import board, summarize
from lumbergh.idle_monitor import tmux_ref
from lumbergh.routers.bill import _fleet_rows, _stamp_attention
from lumbergh.tmux_pty import capture_pane_text

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/glasses")

VIEWER = "glasses"
_POLL_INTERVAL = 1.5
_MAX_WAIT_TIMEOUT = 300.0
_RECENT_LINES = 12


def _question_of(target: str) -> str:
    """The pane text a blocked session is blocking on."""
    try:
        lines = regions.extract("recent", capture_pane_text(tmux_ref(target)), "")
    except Exception:
        logger.info("glasses: could not read pane for %s", target, exc_info=True)
        return ""
    return " ".join(lines[-_RECENT_LINES:])


def _activity_of(target: str) -> str:
    """What a working session last said."""
    try:
        meta = _meta(target)
        cwd = Path(meta["workdir"]) if meta.get("workdir") else None
        adapter = resolve_adapter(target, cwd, meta.get("agent_provider"))
        if adapter is None:
            return ""
        for event in reversed(adapter.read_new()):
            if event.type == "assistant" and (event.text or "").strip():
                return event.text
        return ""
    except Exception:
        logger.info("glasses: could not read activity for %s", target, exc_info=True)
        return ""


def _provider():
    from lumbergh.ai.providers import get_provider
    from lumbergh.routers.settings import get_settings

    try:
        return get_provider(get_settings().get("ai", {}) or {})
    except Exception:
        logger.info("glasses: no usable AI provider, lines will be truncated", exc_info=True)
        return None


async def _deck() -> tuple[list[dict], bool]:
    loop = asyncio.get_running_loop()
    # `_fleet_rows` shells out to tmux and git per repo; never on the event loop.
    rows = _stamp_attention(await loop.run_in_executor(None, _fleet_rows, None), VIEWER)
    provider = _provider()

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

    cards = await board.build_deck(
        rows,
        question_of=lambda t: questions.get(t, ""),
        activity_of=lambda t: activities.get(t, ""),
        line_of=line_of,
    )
    return cards, any(c["needs"] for c in cards)


@router.get("/board")
async def get_board(wait: bool = False, timeout: float = 300.0):
    if not wait:
        cards, woke = await _deck()
        return {"cards": cards, "woke": woke, "waited": 0.0}

    timeout = min(max(timeout, 0.0), _MAX_WAIT_TIMEOUT)
    deadline = time.monotonic() + timeout
    start = time.monotonic()
    while True:
        cards, woke = await _deck()
        if woke or time.monotonic() >= deadline:
            return {"cards": cards, "woke": woke, "waited": round(time.monotonic() - start, 1)}
        await asyncio.sleep(_POLL_INTERVAL)
```

- [ ] **Step 4: Register the router**

In `backend/lumbergh/main.py`, alongside the existing imports of `bill` as `bill_router`, import the new router and register it with the others (after `app.include_router(bill_router.router)`, currently line 187):

```python
from lumbergh.routers import glasses as glasses_router

app.include_router(glasses_router.router)
```

Match the file's existing import style — check how `bill_router` and `worktrees_router` are imported and follow it exactly.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd backend && uv run pytest lumbergh/tests/test_glasses_router.py -v`
Expected: PASS (7 tests)

- [ ] **Step 6: Verify the whole backend suite still passes**

Run: `cd backend && uv run pytest`
Expected: PASS, no new failures

- [ ] **Step 7: Verify against real sessions**

With the backend already running (bootstrap.sh's tmux window — do NOT start a second one):

```bash
curl -s localhost:8420/api/glasses/board | python3 -m json.tool
```

Expected: one card per live session, `line` <= 34 chars, blocked sessions first. If a session's `line` is empty, note which and why before moving on.

- [ ] **Step 8: Lint and commit**

```bash
./lint.sh
git add backend/lumbergh/routers/glasses.py backend/lumbergh/main.py backend/lumbergh/tests/test_glasses_router.py
git commit -m "feat(glasses): GET /api/glasses/board with a wake long poll that never acks the dashboard"
```

---

### Task 4: The deck page, read-only

**Files:**
- Create: `glasses/index.html`, `glasses/main.js`, `glasses/board.js`, `glasses/deck.js`
- Modify: `backend/lumbergh/main.py` — mount the static dir **before** the `mount_frontend(app)` call at line 725
- Test: manual, in a desktop browser at 576x288

**Interfaces:**
- Consumes: `GET /api/glasses/board`
- Produces (ES module exports):
  - `board.js`: `async function fetchBoard({wait = false, timeout = 300} = {}) -> {cards, woke, waited}`
  - `deck.js`: `createDeck()` -> `{ update(cards), next(), prev(), rest(), current(), isQuiet(), pendingAttention(), size() }`

- [ ] **Step 1: Mount the page**

In `backend/lumbergh/main.py`, immediately before `mount_frontend(app)` (line 725) — the ordering matters, because `mount_frontend` registers a catch-all `@app.get("/{path:path}")` that would otherwise swallow this path:

```python
_glasses_dir = Path(__file__).parent.parent.parent / "glasses"
if _glasses_dir.is_dir():
    from starlette.staticfiles import StaticFiles

    app.mount("/glasses", StaticFiles(directory=str(_glasses_dir), html=True), name="glasses")
```

- [ ] **Step 2: Write the page**

`glasses/index.html` — 576x288 is the whole viewport. Monochrome green on black, one font, no images: the waveguide renders luminance only, so anything that is not high-contrast text is wasted.

```html
<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=576,height=288,initial-scale=1">
<title>Lumbergh HUD</title>
<style>
  :root { --fg: #7CFF9B; --dim: #2F6B3E; }
  html, body { margin: 0; background: #000; }
  body {
    width: 576px; height: 288px; overflow: hidden;
    color: var(--fg);
    font: 28px/1.35 "DejaVu Sans Mono", ui-monospace, monospace;
    padding: 16px; box-sizing: border-box;
  }
  #quiet { display: none; padding-top: 90px; text-align: center; color: var(--dim); }
  body.quiet #quiet { display: block; }
  body.quiet #card { display: none; }
  #head { display: flex; justify-content: space-between; }
  #state { letter-spacing: 2px; }
  hr { border: 0; border-top: 2px solid var(--dim); margin: 10px 0; }
  #line { min-height: 76px; }
  #hint { color: var(--dim); font-size: 22px; }
</style>
<div id="quiet">all quiet</div>
<div id="card">
  <div id="head"><span id="name"></span><span id="state"></span></div>
  <hr>
  <div id="line"></div>
  <div id="hint">press &#9656; reply&nbsp;&nbsp;&nbsp;swipe &#9656; next</div>
</div>
<script type="module" src="./main.js"></script>
```

- [ ] **Step 3: Write the board client**

```js
// glasses/board.js
export async function fetchBoard({ wait = false, timeout = 300 } = {}) {
  const qs = new URLSearchParams({ wait: String(wait), timeout: String(timeout) });
  const res = await fetch(`/api/glasses/board?${qs}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`board ${res.status}`);
  return res.json();
}
```

- [ ] **Step 4: Write the deck state machine**

```js
// glasses/deck.js

// Order comes from the server (attention first). The deck holds it still while the
// wearer is browsing: a card that reorders under a thumb mid-swipe means dictating
// into the wrong session, so a refresh only reorders when the wearer is at rest.
export function createDeck() {
  let cards = [];
  let index = 0;
  let browsing = false;
  let pending = 0;

  function keyOf(c) { return c.target; }

  return {
    update(next) {
      const currentKey = cards[index] ? keyOf(cards[index]) : null;
      if (browsing) {
        // Refresh the text of cards already on screen, but keep position and order.
        const byKey = new Map(next.map((c) => [keyOf(c), c]));
        cards = cards.map((c) => byKey.get(keyOf(c)) || c).filter((c) => byKey.has(keyOf(c)));
        pending = next.filter((c) => c.needs && !cards.some((k) => keyOf(k) === keyOf(c))).length;
        index = Math.min(index, Math.max(cards.length - 1, 0));
        return;
      }
      cards = next;
      pending = 0;
      const found = cards.findIndex((c) => keyOf(c) === currentKey);
      const needy = cards.findIndex((c) => c.needs);
      index = needy >= 0 ? needy : Math.max(found, 0);
    },
    next() { browsing = true; if (cards.length) index = (index + 1) % cards.length; },
    prev() { browsing = true; if (cards.length) index = (index - 1 + cards.length) % cards.length; },
    rest() { browsing = false; },
    current() { return cards[index] || null; },
    isQuiet() { return !browsing && !cards.some((c) => c.needs); },
    pendingAttention() { return pending; },
    size() { return cards.length; },
  };
}
```

- [ ] **Step 5: Wire it up**

```js
// glasses/main.js
import { fetchBoard } from "./board.js";
import { createDeck } from "./deck.js";

const deck = createDeck();
const el = {
  body: document.body,
  quiet: document.getElementById("quiet"),
  name: document.getElementById("name"),
  state: document.getElementById("state"),
  line: document.getElementById("line"),
};

function render() {
  const quiet = deck.isQuiet();
  el.body.classList.toggle("quiet", quiet);
  if (quiet) {
    const extra = deck.pendingAttention();
    el.quiet.textContent = extra ? `${extra} need you` : `all quiet · ${deck.size()} live`;
    return;
  }
  const card = deck.current();
  if (!card) return;
  el.name.textContent = card.name;
  el.state.textContent = card.state === "blocked" ? "ASKING" : card.state.toUpperCase();
  el.line.textContent = card.line || "—";
}

// The server holds the request open until something needs the wearer, so this loop
// costs one idle connection rather than a poll. A failure backs off and says so
// rather than leaving stale cards on screen looking live.
async function loop() {
  let backoff = 1000;
  for (;;) {
    try {
      const { cards } = await fetchBoard({ wait: true, timeout: 120 });
      deck.update(cards);
      render();
      backoff = 1000;
    } catch (err) {
      el.body.classList.add("quiet");
      el.quiet.textContent = "no link to lumbergh";
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 30000);
    }
  }
}

// Gestures are keys until the plugin shell maps the real ones (Task 6).
window.addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown" || e.key === "j") { deck.next(); render(); }
  if (e.key === "ArrowUp" || e.key === "k") { deck.prev(); render(); }
  if (e.key === "Escape") { deck.rest(); render(); }
});

loop();
```

- [ ] **Step 6: Verify in a browser**

Open `http://localhost:8420/glasses/` and resize the window to 576x288 (or use devtools device emulation at that size).

Expected:
- Every line fits without wrapping past the card and nothing scrolls.
- With no session blocked: the ambient "all quiet" line.
- Arrow keys cycle cards; Escape returns to rest and re-sorts.
- Stop the backend: within a couple of seconds it reads "no link to lumbergh", not stale cards.

- [ ] **Step 7: Lint and commit**

```bash
./lint.sh
git add glasses/ backend/lumbergh/main.py
git commit -m "feat(glasses): a 576x288 session deck that long-polls the board"
```

---

### Task 5: Dictation

**Files:**
- Create: `glasses/dictate.js`, `glasses/pcm-worklet.js`, `glasses/stt-config.js`
- Modify: `glasses/main.js`, `glasses/index.html`
- Test: manual, in a desktop browser with a microphone

**Interfaces:**
- Consumes: `ws://llmbox:9091` (WhisperLive), `POST /api/agent/sessions/{target}/prompt` with body `{"text": str}`
- Produces: `startDictation({ onPartial, onFinal, onError }) -> { commit(), cancel() }`

- [ ] **Step 1: Copy the tuned vocabulary**

Read the user's blurt config and copy the two strings verbatim — this is what makes "kubectl" and "Claude Code" decode correctly, and it is already tuned:

```bash
grep -A1 "initial_prompt\|hotwords" ~/.config/blurt/config.toml
```

```js
// glasses/stt-config.js
// Copied verbatim from ~/.config/blurt/config.toml. WhisperLive applies these at
// decode time, which is why this vocabulary is worth carrying rather than
// post-correcting: the words are recognised, not repaired.
export const STT = {
  host: "llmbox",
  port: 9091,
  model: "deepdml/faster-whisper-large-v3-turbo-ct2",
  language: "en",
  useVad: true,
  initialPrompt: "Technical dictation about software development. I use Claude and Claude Code daily, and deploy to cloud hosts behind Cloudflare. Other terms: GitHub, GitLab, kubectl, Kubernetes, Docker, Postgres, JSON, YAML, TOML, npm, PyPI, Python, TypeScript, Sherpa, FleetView, Obsidian, Jira, Grafana, Sentry, Tailscale, CapRover, systemd, Wayland, Hyprland, Omarchy, tmux, uv, gcloud, llmbox, blurt.",
  hotwords: "Claude,Claude Code,gcloud,kubectl,GitHub,GitLab,JSON,YAML,TOML,npm,PyPI,Postgres,Sherpa,FleetView,Obsidian,CapRover,Tailscale,Hyprland,Omarchy,llmbox,blurt",
};
```

- [ ] **Step 2: Write the dictation client**

The frame format is lifted from `~/src/personal/blurt/src/blurt/whisper_client.py`: a JSON config message first, then raw little-endian float32 PCM at 16 kHz. Browsers give Float32Array natively, so no conversion is needed — but the AudioContext must be created at 16000 Hz or WhisperLive decodes garbage.

```js
// glasses/dictate.js
import { STT } from "./stt-config.js";

const SILENCE_TAIL_MS = 800; // WhisperLive needs >=1s buffered before it finalises

export async function startDictation({ onPartial, onFinal, onError }) {
  let stream, ctx, ws, node, cancelled = false, finalText = "";

  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } });
  } catch (err) {
    onError("no microphone");
    return null;
  }

  ctx = new AudioContext({ sampleRate: 16000 });
  ws = new WebSocket(`ws://${STT.host}:${STT.port}`);
  ws.binaryType = "arraybuffer";

  ws.onopen = () => {
    ws.send(JSON.stringify({
      uid: crypto.randomUUID(),
      language: STT.language,
      task: "transcribe",
      model: STT.model,
      use_vad: STT.useVad,
      send_last_n_segments: 10,
      initial_prompt: STT.initialPrompt,
      hotwords: STT.hotwords,
    }));
  };

  ws.onerror = () => onError("no link to whisper");

  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (!msg.segments) return;
    // The server re-sends its last N completed segments, so rebuild rather than append.
    finalText = msg.segments.map((s) => s.text).join(" ").trim();
    onPartial(finalText);
  };

  await ctx.audioWorklet.addModule("./pcm-worklet.js");
  node = new AudioWorkletNode(ctx, "pcm-tap");
  node.port.onmessage = (e) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(e.data);
  };
  ctx.createMediaStreamSource(stream).connect(node);

  function teardown() {
    try { node.disconnect(); } catch {}
    try { stream.getTracks().forEach((t) => t.stop()); } catch {}
    try { ctx.close(); } catch {}
    try { ws.close(); } catch {}
  }

  return {
    async commit() {
      if (cancelled) return "";
      // Let the tail of the last word reach the server before closing.
      await new Promise((r) => setTimeout(r, SILENCE_TAIL_MS));
      teardown();
      onFinal(finalText);
      return finalText;
    },
    cancel() {
      cancelled = true;
      teardown();
    },
  };
}
```

```js
// glasses/pcm-worklet.js
// Ships 128-frame blocks straight out as float32 bytes. WhisperLive wants raw
// little-endian float32 at the context's 16 kHz, which is exactly what the render
// quantum already holds — no resampling, no int16 round trip.
class PcmTap extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0][0];
    if (ch) {
      // Copy once, then transfer that same buffer. Posting one array while
      // transferring a second, freshly-made one sends an already-detached buffer.
      const copy = new Float32Array(ch);
      this.port.postMessage(copy.buffer, [copy.buffer]);
    }
    return true;
  }
}
registerProcessor("pcm-tap", PcmTap);
```

- [ ] **Step 3: Wire press-to-dictate into the deck**

Add to `glasses/index.html`, inside `#card`, after `#line`:

```html
<div id="heard"></div>
```

and in `glasses/main.js`:

```js
import { startDictation } from "./dictate.js";

let session = null;

async function sendPrompt(target, text) {
  const res = await fetch(`/api/agent/sessions/${encodeURIComponent(target)}/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error(`prompt ${res.status}`);
}

async function press() {
  const card = deck.current();
  if (!card) return;

  if (session) {
    const text = await session.commit();
    session = null;
    if (!text) { el.heard.textContent = "heard nothing"; return; }
    // Show what is about to be sent for a beat. A misheard prompt landing in a live
    // agent is the one destructive act here, so nothing is fire-and-forget.
    el.heard.textContent = `▸ ${text}`;
    await new Promise((r) => setTimeout(r, 1200));
    try {
      await sendPrompt(card.target, text);
      el.heard.textContent = "sent";
    } catch (err) {
      if (String(err).includes("404")) {
        // The session went away while we were talking. Say so and drop the card
        // rather than offering a retry that can only fail the same way.
        el.heard.textContent = "session is gone";
        lastFailed = null;
        return;
      }
      // Keep the transcript: a retry should cost a press, not the whole sentence again.
      el.heard.textContent = "send failed — press to retry";
      lastFailed = { target: card.target, text };
    }
    return;
  }

  el.heard.textContent = "listening…";
  session = await startDictation({
    onPartial: (t) => { el.heard.textContent = t || "listening…"; },
    onFinal: () => {},
    onError: (m) => { el.heard.textContent = m; session = null; },
  });
}
```

Add `el.heard` to the element map, a `let lastFailed = null;` declaration, a `Enter`/`p` keybinding calling `press()`, and a `swipe down` / `Backspace` binding that calls `session.cancel()` when a session is live. When `lastFailed` is set and the wearer presses, retry that send instead of starting a new dictation.

- [ ] **Step 4: Verify end to end against a real session**

1. `curl -s localhost:8420/api/glasses/board` and pick an idle session's `target`.
2. Open `http://localhost:8420/glasses/`, arrow to that card, press Enter, and say something short and identifiable.
3. Expected: partials appear as you talk; a second press shows `▸ <text>`, then `sent`.
4. Confirm the text actually arrived: `lb read <target>` or the session's Lumbergh terminal.
5. Test the refusal path: point `STT.host` at a dead host and confirm it reads "no link to whisper" rather than silently swallowing speech.

Note: `getUserMedia` and `AudioWorklet` require a secure context. `localhost` counts; a Tailscale hostname over plain HTTP does not. If testing from the phone before the plugin shell exists, use the repo's `setup-https.sh`, or accept that step 5 of Task 6 is where this first works on-device.

- [ ] **Step 5: Lint and commit**

```bash
./lint.sh
git add glasses/
git commit -m "feat(glasses): dictate a prompt into a session via WhisperLive"
```

---

### Task 6: The G2 plugin shell

**Files:**
- Create: `glasses/plugin/app.json`
- Modify: `glasses/main.js` (map real gestures alongside the keys)
- Test: on device

**Interfaces:**
- Consumes: the Even G2 plugin SDK's display and input bridge
- Produces: a sideloadable `.ehpk`

- [ ] **Step 1: Read the platform docs before writing anything**

The SDK's exact bridge API is not pinned in this plan on purpose — it is the one moving part here. Read, in this order:
- https://hub.evenrealities.com/docs — the official plugin model, `evenhub pack`, and the dev portal's sideload flow
- https://github.com/pangoleen/awesome-even-realities-g2 — the community SDK reference (display and container model, input events, page lifecycle, packaging)
- https://github.com/fabioglimb/even-toolkit — pixel-accurate G2 text measurement, gesture helpers, and a design system, if it saves work

Record the actual gesture event names and display container constraints in this task before coding against them.

- [ ] **Step 2: Map gestures to the deck**

Keep the keyboard bindings — they are how this stays debuggable on a desktop. Add the real gestures alongside them, mapping to the same functions:

| Gesture | Action |
|---------|--------|
| swipe up | `deck.prev()` |
| swipe down | live dictation ? `cancel()` : `deck.next()` |
| press | `press()` (start / commit dictation) |
| double press | `deck.rest()` — back to attention order |

- [ ] **Step 3: Package and sideload**

```bash
cd glasses && evenhub pack plugin/app.json . -o lumbergh-hud.ehpk
```

Sideload via QR or a private build through the dev portal, per the docs read in Step 1.

- [ ] **Step 4: Verify on device**

- Ambient line is legible at a glance, outdoors, without focusing.
- 34 characters genuinely fits — if it does not, `LINE_MAX` is the single knob; change it in `summarize.py` and re-check the page.
- Swipe cycles the deck; a session that goes blocked while browsing does not move the card under your thumb.
- Dictation: press, speak, watch partials, press, confirm the text lands in the session.

- [ ] **Step 5: Commit**

```bash
git add glasses/
git commit -m "feat(glasses): package the HUD as a sideloadable G2 plugin"
```

---

### Task 7: Document it

**Files:**
- Modify: `CLAUDE.md` (a short section after "Logs")
- Modify: `docs/ROADMAP.md`

- [ ] **Step 1: Write the CLAUDE.md section**

Cover: what `/glasses` is, that it is plain ES modules with no build step and why, that `GET /api/glasses/board` is the only read, that `LINE_MAX` is the display budget knob, that the wake loop deliberately avoids `_mark_seen`, and that dictation depends on a reachable WhisperLive at `llmbox:9091`.

- [ ] **Step 2: Note the deferred work**

In `docs/ROADMAP.md`, record what the spec deferred so it does not evaporate: auth on the board endpoint (the prototype relies on Tailscale), gesture-based yes/no answering of permission dialogs, and HUD transcript scrollback.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md docs/ROADMAP.md
git commit -m "docs(glasses): how the HUD is put together and what it still owes"
```
