"""Fleet rows -> an ordered deck of HUD cards.

Pure by construction: the text sources arrive as callables, so the whole deck
is testable without tmux, a git worktree or a provider. The router supplies the
real ones.
"""

import re

from lumbergh.glasses import summarize

# Ordering is the wearer's priority, not the fleet's: anything wanting a human
# comes first, then anything alive, then anything finished, then corpses.
ATTENTION_FIRST = ("blocked", "error", "undelivered")
_RANK = dict.fromkeys(ATTENTION_FIRST, 0) | {"working": 1, "idle": 2, "dead": 3}

_OUTCOME_PREFIX = re.compile(r"^(DELIVERED|FAILED):\s*", re.IGNORECASE)
_LEADING_SHA = re.compile(r"^(?=[0-9a-f]*[0-9])([0-9a-f]{7,40})\b[\s:,-]*", re.IGNORECASE)
# ASCII, because the firmware font carries neither ✓ (U+2713) nor ✗ (U+2717) — verified
# against the same LVGL metrics the glasses use, where both measure zero advance. They
# were rendering as a blank on the lenses.
_MARK = {"delivered": "ok ", "failed": "FAIL "}


def clean_outcome(text: str) -> str:
    """An outcome line a wearer can act on, in 34 characters.

    `fleet.parse_outcome` hands back the worker's contracted final line verbatim,
    which usually opens with the delivering commit's SHA. Truncating that keeps the
    hash and throws away the sentence, so the marker becomes a glyph (the card's
    state column already says the session is idle) and a leading SHA is dropped —
    it is never the thing a glance needs.

    If removing the SHA leaves no prose, keep an abbreviated SHA (7 chars, git convention)
    instead of emitting a bare marker — the wearer needs to know which commit delivered.

    The SHA pattern requires at least one digit (a-f-only words like "defaced" are prose).
    """
    match = _OUTCOME_PREFIX.match(text or "")
    if not match:
        return text or ""

    after_marker = text[match.end() :].lstrip()
    sha_match = _LEADING_SHA.match(after_marker)

    if sha_match:
        # Found a SHA; extract prose after it
        body = after_marker[sha_match.end() :].lstrip()
        if body:
            # Prose wins: keep the mark and prose, drop the SHA
            return _MARK[match.group(1).lower()] + body
        # No prose, keep abbreviated SHA (first 7 chars)
        abbrev_sha = sha_match.group(1)[:7]
        return _MARK[match.group(1).lower()] + abbrev_sha
    # No SHA: return the text as-is if present, or just the mark if empty
    if after_marker:
        return _MARK[match.group(1).lower()] + after_marker
    return _MARK[match.group(1).lower()].rstrip()


_BOX_EDGE = re.compile(r"^[│┃|]\s?|\s?[│┃|]$")
_ONLY_PUNCTUATION = re.compile(r"^[\W_]+$")
_SPINNER = re.compile(r"^[✻✽✢✳✶·⋯⏺]\s")
_MENU_OPTION = re.compile(r"^[❯>]?\s*\d+\.\s")
# The status bar is the transcript's floor: the input box, the model/context readout
# and the background-agent tree all live below it, and none of them is ever a question.
_STATUS_BAR = re.compile(r"\d+(\.\d+)?k \(\d+%\)|\bauto mode on\b")
_RECAP_PREFIX = re.compile(r"^※\s*(recap:)?\s*", re.IGNORECASE)
_CHROME = (
    re.compile(r"^❯"),
    re.compile(r"^[⏵▶]"),
    re.compile(r"\bnew task\?.*\/clear"),
    re.compile(r"[↑↓]\s*\d+(\.\d+)?k tokens"),
    re.compile(r"^Update available!"),
    re.compile(r"esc to interrupt"),
)


def _is_chrome(line: str) -> bool:
    return (
        bool(_ONLY_PUNCTUATION.match(line))
        or bool(_SPINNER.match(line))
        or bool(_MENU_OPTION.match(line))
        or any(pattern.search(line) for pattern in _CHROME)
    )


def strip_chrome(text: str) -> str:
    """Drop TUI furniture from a block of text, keeping its prose and line breaks.

    ``clean_question`` picks one line out of a pane capture; this keeps every prose line
    of a whole turn, for the drill-in reader. Transcript text usually arrives clean
    already, but a turn quoting the pane back brings box rules and spinner frames with it.
    """
    kept = []
    for raw in (text or "").splitlines():
        line = _BOX_EDGE.sub("", raw).strip()
        if not line or _is_chrome(line) or _STATUS_BAR.search(line):
            continue
        kept.append(line)
    return "\n".join(kept).strip()


def clean_question(text: str) -> str:
    """The thing a blocked session is actually asking, in one line.

    A pane capture is mostly furniture — box rules, the input caret, the status
    bar, the spinner, the harness's ``※ recap`` block — and the question is a
    couple of lines buried in it. Truncating the raw capture spends the whole
    34-character budget on that furniture, which is the same defect
    ``clean_outcome`` fixed for idle cards.

    The last surviving prose line wins, because a permission dialog's numbered
    options are chrome and its question is the last real sentence above them,
    while a plain prompt's question is simply the newest thing on the pane. When
    only the recap survives, its opening line stands in; when nothing does, the
    line is empty — the state column still says ASKING, and an empty line is more
    honest than a spinner frame.
    """
    kept: list[str] = []
    recap = ""
    in_recap = False
    for raw in (text or "").splitlines():
        line = _BOX_EDGE.sub("", raw).strip()
        if not line:
            in_recap = False
            continue
        if _STATUS_BAR.search(line):
            break
        if line.startswith("※"):
            # The recap block is the harness summarizing the *last* chunk, never the
            # question, and only its first line is marked — so it is skipped as a unit,
            # up to the blank line that ends it.
            recap = recap or _RECAP_PREFIX.sub("", line)
            in_recap = True
            continue
        if in_recap or _is_chrome(line):
            continue
        kept.append(line)
    return kept[-1] if kept else recap


def sort_key(card: dict) -> tuple:
    # Longest-waiting first within a rank: a session blocked for 20 minutes is a
    # worse thing to leave sitting than one blocked for 20 seconds.
    return (_RANK.get(card["state"], 2), -(card["since"] or 0))


def _source_text(row: dict, question_of, activity_of) -> str:
    state = row["state"]
    if state in ATTENTION_FIRST:
        return clean_question(question_of(row["target"]) or "")
    if state == "working":
        return activity_of(row["target"]) or ""
    if state == "idle":
        outcome = row.get("outcome") or ""
        return clean_outcome(outcome)
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
            "parent": row.get("parent"),
            "line": "",
        }
        text = _source_text({**row, "target": target}, question_of, activity_of)
        if text:
            card["line"] = summarize.truncate_line(await line_of(text, summarize.fingerprint(text)))
        cards.append(card)
    cards.sort(key=sort_key)
    return tree_order([c for c in cards if c["state"] not in INACTIVE_STATES])


# A session that is gone is not something the wearer can act on, and on ten lines of
# glass it displaces one they can.
INACTIVE_STATES = {"dead", "orphan"}


def tree_order(cards: list[dict]) -> list[dict]:
    """Each worker directly under its overseer, attention order preserved among siblings.

    The HUD indents a worker under its parent, which only reads as a hierarchy if the two
    are adjacent — attention-first ordering alone can put them ten lines apart. A worker
    whose overseer is not on the board (filtered out, or never listed) is promoted to the
    top level rather than hidden under a parent that is not there.
    """
    names = {c["name"] for c in cards}
    children: dict[str, list[dict]] = {}
    roots = []
    for card in cards:
        parent = card.get("parent")
        if parent and parent in names:
            children.setdefault(parent, []).append(card)
        else:
            roots.append(card)
    ordered = []
    for root in roots:
        root["depth"] = 0
        ordered.append(root)
        for child in children.get(root["name"], []):
            child["depth"] = 1
            ordered.append(child)
    return ordered
