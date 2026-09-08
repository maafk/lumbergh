"""The HUD's assets must revalidate: you cannot hard-reload a pair of glasses."""

from fastapi.testclient import TestClient

from lumbergh.main import app

client = TestClient(app)


def test_the_hud_page_is_not_heuristically_cacheable():
    r = client.get("/glasses/")
    assert r.status_code == 200
    assert r.headers.get("cache-control") == "no-cache"


def test_the_hud_modules_are_not_heuristically_cacheable():
    """A stale module is how a corrected WebSocket URL failed to reach the glasses."""
    r = client.get("/glasses/dictate.js")
    assert r.status_code == 200
    assert r.headers.get("cache-control") == "no-cache"


def test_revalidation_is_still_cheap():
    """no-cache forbids blind reuse, not a 304 — the etag must survive."""
    first = client.get("/glasses/deck.js")
    etag = first.headers["etag"]
    again = client.get("/glasses/deck.js", headers={"If-None-Match": etag})
    assert again.status_code == 304
