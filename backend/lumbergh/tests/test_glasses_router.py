import ast
import inspect
from pathlib import Path

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
    monkeypatch.setattr(glasses, "_fleet_rows", lambda origin=None, with_outcome=False: rows)  # noqa: ARG005
    monkeypatch.setattr(glasses, "_question_of", lambda t: "Do you want to push?")  # noqa: ARG005
    monkeypatch.setattr(glasses, "_activity_of", lambda t: "editing board.py")  # noqa: ARG005
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
    monkeypatch.setattr(bill, "_mark_seen", lambda *a, **k: called.append(a))  # noqa: ARG005
    client.get("/api/glasses/board?wait=true&timeout=0")
    client.get("/api/glasses/board")
    assert called == []


def test_glasses_borrows_only_the_row_builder_from_bill():
    """The unseen overlay is the user's, so the HUD takes exactly one thing from Bill:
    the row builder. Anything else in that module can ack the dashboard on the way out,
    which is why this asserts on the import graph rather than on a patched attribute.
    """
    import lumbergh.routers.bill as bill

    tree = ast.parse(Path(glasses.__file__).read_text())
    borrowed = {
        alias.name
        for node in ast.walk(tree)
        if isinstance(node, ast.ImportFrom) and node.module == "lumbergh.routers.bill"
        for alias in node.names
    }
    assert borrowed == {"_fleet_rows"}
    assert "_mark_seen" not in inspect.getsource(bill._fleet_rows)


def _client_over(rows, monkeypatch):
    """A board client with attention left to the real predicate, nothing stubbed out."""
    monkeypatch.setattr(glasses, "_fleet_rows", lambda origin=None, with_outcome=False: rows)  # noqa: ARG005
    monkeypatch.setattr(glasses, "_question_of", lambda t: "Do you want to push?")  # noqa: ARG005
    monkeypatch.setattr(glasses, "_activity_of", lambda t: "editing board.py")  # noqa: ARG005
    monkeypatch.setattr(glasses, "_provider", lambda: None)
    app = FastAPI()
    app.include_router(glasses.router)
    return TestClient(app)


def _row(task, state, **kw):
    base = {
        "task": task,
        "session": task,
        "target": task,
        "state": state,
        "since": 90,
        "role": "worker",
        "parent": None,
        "outcome": None,
    }
    base.update(kw)
    return base


def test_a_blocked_session_with_no_overseer_wakes_the_wearer(monkeypatch):
    """Scoping attention the way Bill does — to the direct reports of a viewer named
    "glasses" — makes this row invisible, because no session has such an overseer. The
    glasses are the user's view of the whole fleet, so the wake is the fleet's states.
    """
    body = _client_over([_row("solo", "blocked")], monkeypatch).get("/api/glasses/board").json()
    assert body["cards"][0]["needs"] is True
    assert body["woke"] is True


def test_an_idle_session_left_unseen_never_wakes_the_wearer(monkeypatch):
    """Idle is not asking.

    ``fleet.needs_attention`` counts idle+unseen, but ``unseen`` is the user's own
    dashboard overlay — true of every session they ever left mid-thought. Waking on it
    had ten of twelve quiet sessions claiming the wearer, so the HUD could never go
    dark. The card still shows, browsable, with its outcome line; it just does not nag.
    """
    rows = [_row("done", "idle", unseen=True, outcome="DELIVERED: split the panes")]
    body = _client_over(rows, monkeypatch).get("/api/glasses/board?wait=true&timeout=0").json()
    assert body["woke"] is False
    assert body["cards"][0]["needs"] is False
    assert body["cards"][0]["line"] == "ok split the panes"


def test_a_quiet_fleet_never_wakes_the_wearer(monkeypatch):
    rows = [_row("busy", "working", since=10)]
    body = _client_over(rows, monkeypatch).get("/api/glasses/board?wait=true&timeout=0").json()
    assert body["woke"] is False
    assert body["cards"][0]["needs"] is False


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


def test_idle_card_shows_its_outcome(monkeypatch):
    """Mirrors the real `_fleet_rows(origin, with_outcome)` contract: outcome text
    is only attached when `with_outcome` is True, exactly like `bill._fleet_rows`.
    A stub that ignores `with_outcome` would pass this test with the outcome
    wired to nothing, so the two rows must actually differ.
    """

    def fake_fleet_rows(origin=None, with_outcome=False):  # noqa: ARG001
        return [
            {
                "task": "kb-3",
                "session": "kb-3",
                "target": "kb-3",
                "state": "idle",
                "since": 5,
                "attention": False,
                "outcome": "Fixed the flaky test" if with_outcome else None,
            }
        ]

    monkeypatch.setattr(glasses, "_fleet_rows", fake_fleet_rows)
    monkeypatch.setattr(glasses, "_provider", lambda: None)
    app = FastAPI()
    app.include_router(glasses.router)
    client = TestClient(app)

    body = client.get("/api/glasses/board").json()

    assert body["cards"][0]["line"] == "Fixed the flaky test"


def test_provider_is_none_when_the_glasses_summarizer_is_unconfigured(monkeypatch):
    import lumbergh.routers.settings as settings_mod

    monkeypatch.setattr(settings_mod, "get_settings", lambda: {"ai": {"provider": "claude_cli"}})
    assert glasses._provider() is None


def test_provider_never_inherits_the_dashboard_provider(monkeypatch):
    """The dashboard's claude_cli is explicitly disqualified for a per-refresh view."""
    import lumbergh.routers.settings as settings_mod

    monkeypatch.setattr(
        settings_mod,
        "get_settings",
        lambda: {"ai": {"provider": "claude_cli", "providers": {"claude_cli": {"model": "haiku"}}}},
    )
    provider = glasses._provider()
    assert provider is None


def test_provider_uses_the_configured_glasses_endpoint(monkeypatch):
    import lumbergh.routers.settings as settings_mod

    monkeypatch.setattr(
        settings_mod,
        "get_settings",
        lambda: {
            "glasses": {"summarizer": {"baseUrl": "http://llmbox:11434/v1", "model": "qwen3.5:4b"}}
        },
    )
    provider = glasses._provider()
    assert provider is not None
    assert provider.base_url == "http://llmbox:11434/v1"
    assert provider.model == "qwen3.5:4b"
