"""Text the HUD renders must use glyphs the G2 firmware font actually carries.

`@evenrealities/pretext` (vendored at `glasses/vendor/`) reproduces the firmware's LVGL
metrics, and a codepoint the font lacks measures zero advance — it renders as nothing on
the lenses. `✓` and `✗` shipped that way in `clean_outcome` before this test existed.

The font tables live in the vendored JS, so the authority is that file; this test pins
the specific characters this module emits, which is what regresses.
"""

from lumbergh.glasses import board

# Verified against glasses/vendor/pretext-0.1.4.js: each of these has a non-zero advance.
FONT_HAS = set(" abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789")
FONT_HAS |= set("-_.,:;!?'\"()[]{}/\\|@#$%^&*+=<>~`")
# Non-ASCII confirmed present: em dash, middot, ellipsis, filled circle.
FONT_HAS |= set("—·…●")


def _renderable(text: str) -> set[str]:
    return {ch for ch in text if ch not in FONT_HAS}


def test_outcome_marks_are_renderable():
    assert _renderable(board.clean_outcome("DELIVERED: split the panes")) == set()
    assert _renderable(board.clean_outcome("FAILED: could not reach the host")) == set()


def test_sha_only_outcome_is_renderable():
    line = board.clean_outcome("DELIVERED: ac6fe69ec284401b0c31c6e70b8efa218b6af63c")
    assert _renderable(line) == set()
    assert line == "ok ac6fe69"


def test_the_marks_themselves_are_ascii():
    """A glyph the font lacks measures zero advance and renders as a blank."""
    for mark in board._MARK.values():
        assert mark.isascii(), f"{mark!r} may not exist in the firmware font"
