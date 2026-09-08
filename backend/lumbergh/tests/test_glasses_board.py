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
        line_of=lambda text, fp: _identity(text),  # noqa: ARG005
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
    assert deck[0]["line"] == "ok split the panes"


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
    deck = await _deck([row("kb-1", "working")], activities={"kb-1": "y" * 300})
    assert len(deck[0]["line"]) <= summarize.LINE_MAX


async def test_deck_is_ordered_attention_then_working_then_idle():
    rows = [
        row("d", "dead"),
        row("i", "idle"),
        row("w", "working"),
        row("b", "blocked"),
        row("e", "error"),
    ]
    deck = await _deck(rows)
    names = [c["name"] for c in deck]
    assert names[:2] == ["b", "e"] or names[:2] == ["e", "b"]
    # `d` is absent by design: a dead session is not listed at all.
    assert names[2:] == ["w", "i"]


async def test_ties_break_on_longest_waiting_first():
    deck = await _deck([row("new", "blocked", since=5), row("old", "blocked", since=900)])
    assert [c["name"] for c in deck] == ["old", "new"]


async def test_a_row_missing_a_target_is_skipped_not_fatal():
    deck = await _deck([row("ghost", "working", target=None, session=None)])
    assert deck == []


def test_clean_outcome_drops_the_delivering_sha():
    assert (
        board.clean_outcome("DELIVERED: ac6fe69ec284401b0c31c6f8 split the resizable panes")
        == "ok split the resizable panes"
    )


def test_clean_outcome_marks_a_failure():
    assert board.clean_outcome("FAILED: could not reach the test host") == (
        "FAIL could not reach the test host"
    )


def test_clean_outcome_keeps_prose_that_has_no_sha():
    assert board.clean_outcome("DELIVERED: split the panes") == "ok split the panes"


def test_clean_outcome_leaves_a_non_outcome_line_alone():
    assert board.clean_outcome("editing board.py") == "editing board.py"


def test_clean_outcome_of_empty_is_empty():
    assert board.clean_outcome("") == ""


async def test_idle_card_line_is_the_cleaned_outcome():
    deck = await _deck(
        [row("kb-1", "idle", outcome="DELIVERED: ac6fe69ec284401b0c31c6f8 split the panes")]
    )
    assert deck[0]["line"] == "ok split the panes"


def test_clean_outcome_keeps_abbreviated_sha_when_no_prose():
    assert (
        board.clean_outcome("DELIVERED: ac6fe69ec284401b0c31c6e70b8efa218b6af63c") == "ok ac6fe69"
    )


def test_clean_outcome_keeps_abbreviated_sha_on_failure():
    assert board.clean_outcome("FAILED: ac6fe69ec284401b0c31c6e70b8efa218b6af63c") == (
        "FAIL ac6fe69"
    )


def test_clean_outcome_preserves_prose_starting_with_hex_word_without_digit():
    assert board.clean_outcome("DELIVERED: defaced the old banner") == "ok defaced the old banner"


def test_clean_outcome_preserves_prose_starting_with_another_hex_word_without_digit():
    assert board.clean_outcome("DELIVERED: effaced typo in README") == "ok effaced typo in README"


def test_clean_outcome_of_bare_marker_with_no_body():
    assert board.clean_outcome("DELIVERED:") == "ok"


AIO_PANE = """  I added.

✻ Worked for 14s · done 10:19 AM

※ recap: Goal was killing in-cab web's false "location denied" banner; that's built, tested, and shipped as PR #1908 with
  all three review notes fixed. Next action is waiting on srgcap's re-requested review, then merge once green.
                                                                                 new task? /clear to save 231.5k tokens
─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
❯
─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  supply_and_dispatch_aio | 231k (23%) Opus 5 (1M context)                                                          /rc
  ⏵⏵ auto mode on (shift+tab to cycle) · PR #1908 · ← 3 agents"""

PORT_PANE = """
✻ Baked for 32s · done 11:36 AM

※ recap: We're working David's and Chris's feedback into Port; the storage delete/edit/undo
  feature is built and live on dev at f690a4a6, all gates green. Next: you look at it on
  dev, then tell me whether to promote to prod.
                                                     new task? /clear to save 281k tokens
───────────────────────────────────────────────────────────────────────────────────────────
❯
───────────────────────────────────────────────────────────────────────────────────────────
  port | 279k (28%) Opus 5                                                            /rc
  ⏵⏵ auto mode on (shift+tab to cycle) · ← 3 agents"""

PERMISSION_DIALOG = """╭────────────────────────────────────────────────╮
│ Edit file                                      │
│                                                │
│ Do you want to make this edit to board.py?     │
│ ❯ 1. Yes                                       │
│   2. Yes, allow all edits during this session  │
│   3. No, and tell Claude what to do differently│
╰────────────────────────────────────────────────╯"""


def test_clean_question_keeps_the_question_not_the_menu():
    assert board.clean_question(PERMISSION_DIALOG) == "Do you want to make this edit to board.py?"


def test_clean_question_drops_the_spinner_and_the_status_bar():
    assert board.clean_question(AIO_PANE) == "I added."


def test_clean_question_falls_back_to_the_recap_when_nothing_else_survives():
    assert board.clean_question(PORT_PANE).startswith("We're working David's and Chris's")


def test_clean_question_of_pure_chrome_is_empty():
    assert board.clean_question("❯\n─────────\n  ⏵⏵ auto mode on (shift+tab to cycle)") == ""


def test_clean_question_of_empty_is_empty():
    assert board.clean_question("") == ""


async def test_blocked_card_line_is_the_cleaned_question():
    deck = await _deck([row("kb-1", "blocked")], questions={"kb-1": PERMISSION_DIALOG})
    assert deck[0]["line"] == "Do you want to make this edit to …"


def test_dead_sessions_are_not_listed():
    """A session that is gone displaces one the wearer could act on."""
    cards = board.tree_order(
        [
            {"name": "a", "state": "idle", "parent": None},
            {"name": "b", "state": "working", "parent": None},
        ]
    )
    assert [c["name"] for c in cards] == ["a", "b"]


def test_workers_follow_their_overseer():
    cards = board.tree_order(
        [
            {"name": "aio", "state": "idle", "parent": None},
            {"name": "other", "state": "idle", "parent": None},
            {"name": "psp-fix", "state": "idle", "parent": "aio"},
        ]
    )
    assert [c["name"] for c in cards] == ["aio", "psp-fix", "other"]
    assert [c["depth"] for c in cards] == [0, 1, 0]


def test_a_worker_whose_overseer_is_absent_is_promoted():
    """Better at the top level than hidden under a parent that is not on the board."""
    cards = board.tree_order([{"name": "psp-fix", "state": "idle", "parent": "reaped"}])
    assert [c["name"] for c in cards] == ["psp-fix"]
    assert cards[0]["depth"] == 0


def test_sibling_order_is_preserved():
    cards = board.tree_order(
        [
            {"name": "aio", "state": "idle", "parent": None},
            {"name": "second", "state": "idle", "parent": "aio"},
            {"name": "first", "state": "blocked", "parent": "aio"},
        ]
    )
    assert [c["name"] for c in cards] == ["aio", "second", "first"]


async def test_the_deck_drops_inactive_sessions():
    deck = await _deck([row("gone", "dead"), row("live", "working")])
    assert [c["name"] for c in deck] == ["live"]
