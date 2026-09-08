import asyncio

import pytest

from lumbergh.glasses import summarize


class FakeProvider:
    def __init__(self, reply="", delay=0.0, boom=False):
        self.reply = reply
        self.delay = delay
        self.boom = boom
        self.calls = 0

    async def complete(self, _prompt):
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
