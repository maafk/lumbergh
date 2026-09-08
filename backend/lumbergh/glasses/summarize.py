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
