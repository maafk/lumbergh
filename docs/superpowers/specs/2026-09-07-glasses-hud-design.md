# Glasses HUD — supervising Lumbergh from Even Realities G2

## Purpose

Supervise the fleet away from a desk. Two jobs, in the user's words: see at a
glance whether a session is working or sitting there, and when one is asking for
something, dictate a reply and keep it going.

Terminal mode fails on these glasses for the same reason a raw transcript would:
576x288 monochrome pixels and five gestures cannot carry a Claude Code TUI. The
HUD needs a purpose-built, radically compressed view — not a smaller terminal.

## Platform constraints

Facts that shape every decision below, from the Even G2 developer docs:

- A plugin is **a web app that runs on the phone**. The glasses render its output
  and capture input; no code executes on the glasses.
- Display: 576x288 px per eye, monochrome green, 16 levels. Realistically ~6
  lines of ~34 characters at a glanceable size.
- Input: touchpad press, double press, swipe up, swipe down, tap-then-long-press-
  and-release, on either temple or the R1 ring.
- Microphone: 4-mic array, single stream, 16 kHz PCM. **The SDK exposes no
  speech-to-text** — the app supplies its own.
- Distribution: sideload by QR or private build; `evenhub pack` for packaging.

Two pieces of the user's existing infrastructure remove most of the work:

- **WhisperLive at `llmbox:9091`**, already serving `blurt` — a plain WebSocket
  taking float32 PCM and returning streaming partials, with an `initial_prompt`
  and `hotwords` list already tuned for Claude Code vocabulary.
- **A LiteLLM proxy** exposing local models (Qwen3-8B), reachable as an
  OpenAI-compatible endpoint.
- The phone is on the same Tailnet as the Lumbergh host, so the client reaches
  the backend directly. The cloud tunnel is not involved.

## What already exists in Lumbergh

This feature is mostly assembly. The substrate:

- `GET /api/bill/fleet` (`routers/bill.py`) returns the board — `task`, `state`,
  `since`, `needs`, `outcome`, `context` per session.
- `GET /api/bill/fleet/wait` blocks until a direct report needs action, via
  `fleet.needs_attention()` / `ATTENTION_STATES` / `unseen`. This is the wake
  signal; the client needs no polling loop.
- `detect/manifests/claude.toml` classifies *why* a session is blocked
  (`permission_dialog`, `folder_trust_prompt`, …), and
  `detect/regions.extract("recent", …)` yields the question text.
- The `activity/` adapters produce structured `ConversationEvent`s, with
  `tool_result` bodies already collapsed.
- `POST /api/agent/sessions/{name}/prompt` sends text to a session.
- `ai/providers.py` has `OpenAICompatibleProvider`, which is how the LiteLLM
  proxy is reached — no new AI plumbing.

## Architecture

Three units with one responsibility each.

```
G2 glasses ──BLE──> phone plugin (web app)
                      │  ├── ws://llmbox:9091        (dictation, direct)
                      │  └── https://<tailnet>/api/glasses/board  (read)
                      └────> POST /api/agent/sessions/{name}/prompt (send)
```

### 1. Board endpoint — `GET /api/glasses/board`

The client's only read. One request returns the whole fleet pre-shrunk for the
HUD. Per session:

| field   | meaning |
|---------|---------|
| `name`  | session name |
| `state` | `blocked` / `working` / `idle` / `dead` |
| `since` | seconds in that state |
| `line`  | one line, <= 34 chars, of what it is doing or asking |
| `needs` | whether this session needs the viewer now |

`line`'s source depends on state, because the honest answer differs:

- `blocked` — the compressed question from `regions.extract("recent", …)`.
- `working` — a compressed summary of the last assistant turn from the activity
  adapter.
- `idle` — the parsed `outcome` if there is one, else empty.

An optional `wait` parameter delegates to the same machinery behind
`fleet/wait`, so the client holds one open request and the HUD stays dark until
something actually happens. The endpoint wraps `_fleet_rows()` rather than
reimplementing the board.

It is served from the normal authenticated surface. `/api/agent/*` stays
localhost-and-token as documented; this endpoint does not widen it.

### 2. Line summarizer

Takes text plus a fingerprint, returns one short line. Caches by fingerprint, so
an unchanged pane never re-summarizes — the board is fetched continuously and
most fetches change nothing.

Reaches Qwen3-8B through `OpenAICompatibleProvider` against the LiteLLM proxy,
under a hard timeout. **On timeout or provider error the line degrades to a
truncated first sentence of the raw text.** The HUD never waits on an LLM and
never renders an error where a status line belongs. `claude -p` is deliberately
not used here: too slow and too expensive for a view that refreshes on every
fleet change.

### 3. The client — a session deck

One view model. An ordered deck of session cards, attention-first (`blocked` and
`unseen` before `working` before `idle`), rebuilt on each board fetch.

- **Zero state** renders a single ambient line (`all quiet · 3 working`).
- **A wake** selects the card that is asking.
- **Swipe up/down** cycles the whole deck, working sessions included, so the
  fleet can be browsed and not merely answered.
- **Press** starts dictation into the current card's session.

Card order is stable while the user is browsing: a background state change must
not yank a card out from under a thumb. Newly arriving attention shows as a
marker on the ambient line, never as a jump.

```
  kb-51508              ASKING
 ──────────────────────────────
  wants to force-push to rc

  press ▸ reply    swipe ▸ skip
```

### Dictation loop

Entirely client-side; frame format lifted from `blurt/whisper_client.py`.

1. **Press** — open `ws://llmbox:9091`, stream mic PCM as float32.
2. Partials render live on the HUD, so a mishearing is visible while it happens.
3. **Press again** — commit. This matches the tap-to-start / tap-to-commit
   muscle memory the user already has from `blurt`.
4. **Swipe down** — cancel, send nothing.
5. On commit the final text renders for a beat, then `POST`s to
   `/api/agent/sessions/{name}/prompt`.

The existing `initial_prompt` and `hotwords` are reused verbatim; they are what
makes "kubectl" and "Claude Code" decode correctly. A misheard prompt landing in
a live agent is the one genuinely destructive operation in this design, which is
why nothing is fire-and-forget.

## Error handling

- **Board unreachable** (off Tailnet, backend down) — the HUD says so on the
  ambient line and retries with backoff. It never renders stale state as live.
- **Summarizer unavailable** — degrades to truncated raw text, per above.
- **WhisperLive unreachable** — dictation refuses to start and says so, rather
  than swallowing speech into a dead socket.
- **Prompt POST fails** — the transcript is retained on the card so a retry
  costs a press, not re-dictating the whole thing.
- **Session disappears mid-dictation** — commit is refused with the reason; the
  deck rebuilds without that card.

## Testing

- Board endpoint: unit tests over fixture fleet rows and fixture panes — one per
  state, asserting `line` source selection and the 34-char bound.
- Summarizer: fingerprint cache hit/miss, and the degradation path (timeout and
  error both yield truncated raw text, never an exception).
- Client: the deck is developed as a 576x288 page drivable in a desktop browser
  against live sessions. Ordering and stability-while-browsing are testable
  there without hardware.
- The `evenhub` plugin shell is wrapped last and is the only step that needs the
  glasses.

E2E tests run only via `./test/e2e-vm.sh`, per project convention.

## Build order

1. Board endpoint (`GET /api/glasses/board`) plus tests, fixture-driven.
2. Line summarizer plus tests, including degradation.
3. Browser client at 576x288 — deck, gestures mapped to keys, read path.
4. Dictation against WhisperLive, still in the browser.
5. `evenhub` plugin shell; sideload by QR; verify on device.

## Deferred, deliberately

Recorded so they do not evaporate:

- **Auth.** The prototype leans on Tailscale reachability. Before this outlives
  the prototype the board endpoint needs its own token and the exposure surface
  needs a review. The user's call: "prove it out then we lock it down."
- **Gesture-based yes/no answering** of permission dialogs. Voice is the only
  input path for now — one path, no ambiguity.
- **Transcript scrollback** on the HUD. The board's one line per session is the
  whole read model.
- **Notification/attention push** to the phone. The long poll covers it.
