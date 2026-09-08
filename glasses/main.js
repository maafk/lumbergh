import { apiUrl, failureMessage, resolveBase } from "./api.js";
import { fetchBoard } from "./board.js";
import { createDeck } from "./deck.js";
import { startDictation } from "./dictate.js";
import { createReader } from "./detail.js";
import { initLens, quitLens, renderLens } from "./lens.js";
import { bindTouch } from "./touch.js";

const deck = createDeck();
const reader = createReader();

// The stage is a fixed 576x288 — the lens frame — scaled to whatever viewport it lands
// in. Done in script rather than CSS because scale() needs a unitless ratio, which calc()
// cannot produce from viewport units.
const stage = document.getElementById("stage");
function fitStage() {
  const scale = Math.min(window.innerWidth / 576, window.innerHeight / 288);
  stage.style.transform = `scale(${scale})`;
}
fitStage();
window.addEventListener("resize", fitStage);
window.addEventListener("orientationchange", fitStage);

const el = {
  body: document.body,
  read: document.getElementById("read"),
  dictation: document.getElementById("dictation"),
};

let session = null;
let sessionCard = null; // {target, name} pinned when dictation started — never re-read at commit time

// What the dictation line currently says. Held here rather than read back out of the
// DOM, because the reader has no DOM element for it and the lenses are the surface that
// matters — a held-down temple with nothing on the glass is indistinguishable from a
// dead microphone.
let heardText = "";

// One view object drives both surfaces: the DOM (the phone-side preview, and the desktop
// debugging path) and the lenses. Deriving them separately is how the two would drift.
// The default view is the whole board: one line per session, the frame holds ten. The
// old one-card-at-a-time view spent nine lines saying nothing, and needed an ambient
// screen and a browsing-stability apparatus to make up for it.
const LIST_ROWS = 10;
// The selection sits here, always. Scrolling a window and letting the cursor wander
// inside it means hunting for it after every swipe; a fixed row means the eye never
// moves and the list travels underneath.
const CURSOR_ROW = Math.floor(LIST_ROWS / 2);

function listLines() {
  const cards = deck.all();
  if (!cards.length) return ["no sessions"];
  const cursor = deck.index();
  const lines = [];
  for (let offset = -CURSOR_ROW; offset < LIST_ROWS - CURSOR_ROW; offset++) {
    // The list is a ring: it wraps in both directions and repeats, so a swipe never
    // hits an end and the selection never has to leave the centre.
    const card = cards[(((cursor + offset) % cards.length) + cards.length) % cards.length];
    const here = offset === 0;
    const state = card.state === "blocked" ? "asking" : card.state;
    // A worker is indented under its overseer; the board orders them adjacently so the
    // indent reads as a hierarchy rather than as decoration.
    const indent = "  ".repeat(card.depth ?? 0);
    lines.push(`${here ? ">" : " "}${card.needs ? "!" : " "} ${indent}${card.name} · ${state}`);
  }
  return lines;
}

function render() {
  if (reader.isOpen()) {
    // The page keeps all ten lines; the dictation line floats over it in its own
    // bordered box rather than being appended to the text.
    const page = reader.visibleLines().join("\n");
    el.read.textContent = page;
    el.body.classList.toggle("dictating", Boolean(heardText));
    el.dictation.textContent = heardText;
    renderLens({ reading: true, text: page, heard: heardText });
    return;
  }
  const text = listLines().join("\n");
  el.read.textContent = text;
  el.body.classList.toggle("dictating", Boolean(heardText));
  el.dictation.textContent = heardText;
  renderLens({ text, heard: heardText });
}

// The dictation line changes far more often than the board does — every partial
// transcript — and it must reach the lenses, not just the phone preview. Routed through
// one setter that re-renders, so no mode can forget to show it: the previous version
// patched a cached view and skipped the push entirely when the fleet was quiet.
function setHeard(textContent) {
  heardText = textContent;
  // render() puts it on both surfaces — the dictation box here and on the lenses. It
  // used to also write a card element that no longer exists, which threw and aborted
  // whatever called it.
  render();
}

const HEARD_NAME_MAX = 18;
function abbreviate(name) {
  return name.length > HEARD_NAME_MAX ? `${name.slice(0, HEARD_NAME_MAX - 1)}…` : name;
}

async function sendPrompt(target, text) {
  const res = await fetch(apiUrl(`/api/agent/sessions/${encodeURIComponent(target)}/prompt`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error(`prompt ${res.status}`);
}

// What was dictated and is waiting on the wearer to send or discard. Nothing leaves
// this state on a timer: a misheard prompt landing in a live agent is the one
// destructive act here, and 1200ms to notice was never a review — it was a reflex test.
let pending = null;

function reviewLine() {
  if (!pending) return "";
  const action = pending.failed ? "send failed  tap retry" : "tap send  2x cancel";
  return `${abbreviate(pending.name)}: ${pending.text}\n${action}`;
}

function cancelPending() {
  if (!pending) return false;
  pending = null;
  setHeard("");
  return true;
}

async function sendPending() {
  if (!pending) return;
  const { target, name, text } = pending;
  try {
    await sendPrompt(target, text);
    pending = null;
    setHeard("sent");
  } catch (err) {
    if (String(err).includes("404")) {
      // The session went away while we were talking. Say so and drop it rather than
      // offering a retry that can only fail the same way.
      pending = null;
      setHeard("session is gone");
      return;
    }
    // Keep the transcript: a retry should cost a tap, not the whole sentence again.
    pending = { target, name, text, failed: true };
    setHeard(reviewLine());
  }
}

// `press` is fired un-awaited from the keyboard and from the G2 bridge, and it
// awaits getUserMedia — seconds, on the first permission prompt. A second press in
// that window would start a second dictation, retarget `sessionCard` and orphan the
// first microphone stream with no path to teardown. That is the "spoken prompt
// reaches the wrong agent" failure, so overlapping presses are dropped outright.
// This is a guard against overlapping async work, not a key-repeat debounce.
let busy = false;
async function press() {
  if (busy) return;
  busy = true;
  try {
    await pressOnce();
  } catch (err) {
    // Anything that escapes pressOnce would otherwise leave whatever line was last
    // rendered ("listening…") standing as if it were still true.
    session = null;
    setHeard(`failed: ${err?.name || "error"}`);
  } finally {
    busy = false;
  }
}

async function fetchTurns(target) {
  try {
    const res = await fetch(apiUrl(`/api/glasses/sessions/${encodeURIComponent(target)}/detail`), {
      cache: "no-store",
    });
    if (res.ok) return (await res.json()).turns ?? [];
  } catch {
    // Offline or the session went away — the caller keeps whatever it already had
    // rather than blanking the page the wearer is mid-way through reading.
  }
  return null;
}

// A session's transcript grows without its board state changing, so the board's long
// poll never wakes for it — the reader needs its own. Human-scale: the wearer is reading,
// not watching a log stream, and each poll is a transcript read on the host.
const READER_POLL_MS = 2500;
let readerTimer = null;

function stopFollowing() {
  clearInterval(readerTimer);
  readerTimer = null;
}

function startFollowing() {
  stopFollowing();
  readerTimer = setInterval(async () => {
    if (!reader.isOpen()) {
      stopFollowing();
      return;
    }
    const turns = await fetchTurns(reader.target());
    if (!turns || !reader.isOpen()) return;
    // `refresh` keeps the wearer's place, or sticks to the newest if that is where they
    // already were — so new output arrives without yanking the page mid-sentence.
    reader.refresh(turns.length ? turns : [{ who: "agent", text: "nothing to read" }]);
    render();
  }, READER_POLL_MS);
}

async function openReader() {
  const card = deck.current();
  if (!card) return;
  const turns = await fetchTurns(card.target);
  reader.open(card.target, turns?.length ? turns : [{ who: "agent", text: "nothing to read" }]);
  startFollowing();
  render();
}

// Releasing the temple stops recording and puts the words up for review. It does not
// send: the wearer decides, having read what would be typed.
async function pressOnce() {
  if (session) {
    const text = await session.commit();
    session = null;
    if (!text) {
      setHeard("heard nothing");
      return;
    }
    // Held against the card dictation started on, never wherever the wearer has since
    // browsed to — and shown, so the destination is reviewed along with the words.
    pending = { target: sessionCard.target, name: sessionCard.name, text };
    setHeard(reviewLine());
    return;
  }

  const card = deck.current();
  if (!card) return;

  sessionCard = { target: card.target, name: card.name };
  setHeard(`● ${abbreviate(card.name)}: listening…`);
  session = await startDictation({
    onPartial: (t) => {
      setHeard(`● ${abbreviate(sessionCard.name)}: ${t || "listening…"}`);
    },
    onError: (m) => {
      setHeard(m);
      session = null;
    },
  });
}

// The server holds a *waiting* request open until something needs the wearer, so
// once primed this loop costs one idle connection rather than a poll. But that
// same hold-open behaviour would leave the very first screen blank for up to the
// full timeout on a quiet fleet, so the very first fetch — and the first one
// after a link failure — is non-waiting and returns immediately.
async function loop() {
  let backoff = 1000;
  let wait = false;
  for (;;) {
    try {
      // Which base answers depends on how the page was loaded — served by Lumbergh, or
      // from a packed bundle with no server behind its own origin.
      if (!(await resolveBase())) throw new Error("unreachable");
      const { cards } = await fetchBoard(wait ? { wait: true, timeout: 120 } : { wait: false });
      deck.update(cards);
      render();
      backoff = 1000;
      wait = true;
    } catch {
      const message = failureMessage();
      el.read.textContent = message;
      renderLens({ text: message });
      wait = false;
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 30000);
    }
  }
}

// "sent" / "heard nothing" belong to the card they happened on; leaving them up under
// the next card's name reads as that session's status. A live dictation or a retry
// still owed keeps its text — both name their own destination.
function clearHeard() {
  if (!session && !pending) setHeard("");
}

function goNext() {
  deck.next();
  clearHeard();
  render();
}
function goPrev() {
  deck.prev();
  clearHeard();
  render();
}
function goRest() {
  deck.rest();
  clearHeard();
  render();
}

// Shared by the Backspace key and the swipe-down gesture: cancel whatever
// dictation is live (an open recording, or a prompt still in its confirm
// beat) and report whether there was anything to cancel.
function cancelDictation() {
  if (session) {
    session.cancel();
    session = null;
    setHeard("");
    return true;
  }
  // Words waiting on a decision are the other thing a cancel means.
  return cancelPending();
}

window.addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown" || e.key === "j") down();
  if (e.key === "ArrowUp" || e.key === "k") up();
  if (e.key === "Escape") back();
  if (e.key === "Enter") tap();
  if (e.key === "p") press();
  if (e.key === "Backspace") cancelDictation();
});

// The lenses. Resolves false in a plain browser, where the DOM page is the whole story.
// Tap drills in, swipe moves — through the deck outside the reader, through time
// inside it. Double press is the way back out, and holding the temple talks.
function up() {
  if (reader.isOpen()) {
    reader.older();
    render();
    return;
  }
  goPrev();
}

function down() {
  if (cancelDictation()) return;
  if (reader.isOpen()) {
    reader.newer();
    render();
    return;
  }
  goNext();
}

// Double press is "out of here": out of a pending send, then out of the reader, then out
// of the app. One gesture, one meaning, at every depth.
async function back() {
  if (cancelPending()) return;
  if (reader.isOpen()) {
    stopFollowing();
    reader.close();
    render();
    return;
  }
  // At the root there is nothing left to back out of but the plugin itself. In a plain
  // browser there is nothing to quit, so the cursor resets instead.
  if (!(await quitLens())) goRest();
}

function tap() {
  // Words awaiting a decision own the tap: sending is the thing the wearer is there to
  // do, and it must not depend on remembering a second, rarer gesture.
  if (pending) {
    sendPending();
    return;
  }
  if (reader.isOpen()) return;
  openReader();
}

initLens({
  onSwipeUp: up,
  onSwipeDown: down,
  onPress: tap,
  onDoublePress: back,
  // Push to talk: hold the temple to speak, release to send. Closer to how a radio
  // works than tap-to-start/tap-to-commit, and it cannot leave the mic open by
  // forgetting the second tap.
  // Dictation belongs to the reader, where the wearer can see what they are replying
  // to. Holding the temple on the list would be talking into a name.
  onHoldStart: () => {
    if (reader.isOpen() && !session) press();
  },
  onHoldEnd: () => {
    if (session) press();
  },
});

// The phone browser has no keyboard, which left the HUD watchable but not drivable
// there. Same four actions as the G2, off touch instead. No-op on a desktop browser.
bindTouch(document.body, {
  onSwipeUp: up,
  onSwipeDown: down,
  onPress: tap,
  onDoublePress: back,
});

// ?debug=1 renders what this WebView actually exposes instead of the deck. The Even app
// gives no console, so a probe you can read on screen is the only way to find out whether
// a host bridge is reachable without the npm SDK — and what it is called.
if (new URLSearchParams(location.search).has("debug")) {
  const candidate = window.EvenAppBridge ?? window.evenAppBridge ?? null;
  const members = (o) => {
    const out = new Set();
    for (let p = o; p && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
      Object.getOwnPropertyNames(p).forEach((k) => out.add(k));
    }
    return [...out];
  };
  const report = {
    matchingGlobals: Object.keys(window).filter((k) =>
      /^(even|bridge|hub|glass)|(?:EvenApp|EvenHub|Bridge)/.test(k),
    ),
    webkitHandlers: Object.keys(window.webkit?.messageHandlers ?? {}),
    bridgeFound: Boolean(candidate),
    bridgeType: typeof candidate,
    bridgeMembers: candidate ? members(candidate) : [],
    allGlobalsCount: Object.keys(window).length,
    nonStandardGlobals: Object.keys(window)
      .filter(
        (k) => !(k in globalThis.constructor.prototype) && /^[A-Za-z_$]/.test(k) && k.length < 40,
      )
      .slice(0, 400),
    // Where the page was actually loaded from. A packed .ehpk serves it from a local
    // origin, where a relative /api fetch has no server behind it — which is exactly
    // how "no link to lumbergh" happens.
    href: location.href,
    origin: location.origin,
    protocol: location.protocol,
    host: location.host,
    ua: navigator.userAgent,
    viewport: `${window.innerWidth}x${window.innerHeight}`,
  };
  // Reported rather than only displayed: the frame clips long output, and reading it
  // off a phone screen is how transcription errors get into a diagnosis.
  fetch(apiUrl("/api/glasses/probe"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(report),
  }).catch(() => {});
  // Escapes the fixed stage so nothing is cut off, and scrolls.
  stage.remove();
  const pre = document.createElement("pre");
  pre.style.cssText =
    "position:fixed;inset:0;margin:0;padding:10px;overflow:auto;color:#7cff9b;" +
    "background:#000;font:12px/1.35 ui-monospace,monospace;white-space:pre-wrap;word-break:break-all";
  pre.textContent = "sent to backend log\n\n" + JSON.stringify(report, null, 2);
  document.body.appendChild(pre);
} else {
  loop();
}
