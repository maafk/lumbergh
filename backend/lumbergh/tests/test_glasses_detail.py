"""The drill-in reader: recent turns for one session, chrome removed."""

import lumbergh.routers.glasses as glasses
from lumbergh.glasses import board


class Event:
    def __init__(self, kind, text=None, tool_name=None, tool_summary=None):
        self.type = kind
        self.text = text
        self.tool_name = tool_name
        self.tool_summary = tool_summary


class Adapter:
    def __init__(self, events):
        self._events = events

    def read_new(self):
        return self._events


def test_strip_chrome_keeps_prose_lines():
    assert board.strip_chrome("│ split the panes │\n│ tests pass │") == (
        "split the panes\ntests pass"
    )


def test_strip_chrome_drops_spinner_and_status_furniture():
    assert board.strip_chrome("✻ Worked for 14s · done\nreal answer\n↑ 12.4k tokens") == (
        "real answer"
    )


def test_strip_chrome_of_pure_furniture_is_empty():
    assert board.strip_chrome("✻ Baked for 32s · done 11:36 AM") == ""


def _turns(monkeypatch, events):
    monkeypatch.setattr(glasses, "_meta", lambda _n: {"workdir": "/w", "agent_provider": "claude"})
    monkeypatch.setattr(glasses, "resolve_adapter", lambda *_a, **_k: Adapter(events))
    return glasses._turns_of("s1", 40)


def test_turns_carry_who_said_what(monkeypatch):
    turns = _turns(
        monkeypatch,
        [Event("user_message", "run the tests"), Event("agent_message", "they pass")],
    )
    assert turns == [
        {"who": "you", "text": "run the tests"},
        {"who": "agent", "text": "they pass"},
    ]


def test_tool_calls_become_a_bare_marker(monkeypatch):
    """Measured: tool summaries averaged 842 chars vs 96 for prose, and outnumbered it 34:6.

    Even the name and a run count are more than a glance wants — the client draws a rule.
    """
    turns = _turns(
        monkeypatch,
        [Event("tool_call", tool_name="Bash", tool_summary="npx tsc --noEmit -p tsconfig.json")],
    )
    assert turns == [{"who": "tool"}]


def test_a_run_of_tool_calls_collapses_to_one_marker(monkeypatch):
    turns = _turns(
        monkeypatch,
        [Event("tool_call", tool_name=n) for n in ("Bash", "Bash", "Edit", "Read")],
    )
    assert turns == [{"who": "tool"}]


def test_prose_between_tool_runs_starts_a_new_marker(monkeypatch):
    turns = _turns(
        monkeypatch,
        [
            Event("tool_call", tool_name="Bash"),
            Event("agent_message", "tests pass"),
            Event("tool_call", tool_name="Bash"),
        ],
    )
    assert turns == [{"who": "tool"}, {"who": "agent", "text": "tests pass"}, {"who": "tool"}]


def test_tool_results_are_dropped(monkeypatch):
    """Their bodies are command output — noise on a 576x288 frame."""
    turns = _turns(monkeypatch, [Event("tool_result", "1220 passed"), Event("agent_message", "ok")])
    assert turns == [{"who": "agent", "text": "ok"}]


def test_empty_turns_are_dropped(monkeypatch):
    turns = _turns(
        monkeypatch, [Event("agent_message", "✻ Worked for 3s"), Event("agent_message", "real")]
    )
    assert turns == [{"who": "agent", "text": "real"}]


def test_a_session_with_no_adapter_reads_empty(monkeypatch):
    monkeypatch.setattr(glasses, "_meta", lambda _n: {"workdir": "/w"})
    monkeypatch.setattr(glasses, "resolve_adapter", lambda *_a, **_k: None)
    assert glasses._turns_of("s1", 40) == []


def test_a_broken_read_does_not_raise(monkeypatch):
    def boom(*_a, **_k):
        raise RuntimeError("transcript on fire")

    monkeypatch.setattr(glasses, "_meta", lambda _n: {"workdir": "/w"})
    monkeypatch.setattr(glasses, "resolve_adapter", boom)
    assert glasses._turns_of("s1", 40) == []


def test_only_the_last_n_turns_are_returned(monkeypatch):
    events = [Event("agent_message", f"turn {i}") for i in range(50)]
    monkeypatch.setattr(glasses, "_meta", lambda _n: {"workdir": "/w", "agent_provider": "claude"})
    monkeypatch.setattr(glasses, "resolve_adapter", lambda *_a, **_k: Adapter(events))
    turns = glasses._turns_of("s1", 5)
    assert [t["text"] for t in turns] == [f"turn {i}" for i in range(45, 50)]
