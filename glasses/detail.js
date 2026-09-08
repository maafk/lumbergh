// The drill-in reader.
//
// The board's line per session is built for a glance and says almost nothing — "running
// tests" tells the wearer neither what happened nor what is next. This is where the
// agent's own words are, scrolled a line at a time so you can move back and forth
// through time.
//
// The whole frame is content. No header, no hint, no position counter: on 576x288 every
// line spent on furniture is a line of the answer not shown.
//
// Wrapping is measured, not estimated. `@evenrealities/pretext` reproduces the LVGL
// metrics the firmware itself uses, which matters because the font is proportional: a
// character count is wrong by roughly 60% (52 average glyphs per line, not 32) and
// nothing on a 576x288 frame can afford that.

import { getTextWidth, measureTextWrap } from "./vendor/pretext-0.1.4.js";

const FRAME_W = 576;
const FRAME_H = 288;

// Derived from the real font rather than assumed: one line measures 27px, so ten fit.
const LINE_H = measureTextWrap("x", FRAME_W).height || 27;
export const ROWS = Math.max(1, Math.floor(FRAME_H / LINE_H));
const STEP = Math.max(1, Math.floor(ROWS / 2));

/** Break text into lines that genuinely fit the frame, by pixel width. */
export function wrapToFrame(text, maxWidth = FRAME_W) {
  const lines = [];
  for (const paragraph of String(text ?? "").split("\n")) {
    if (!paragraph.trim()) {
      lines.push("");
      continue;
    }
    let line = "";
    for (const word of paragraph.trim().split(/\s+/)) {
      const candidate = line ? `${line} ${word}` : word;
      if (getTextWidth(candidate) <= maxWidth) {
        line = candidate;
        continue;
      }
      if (line) lines.push(line);
      line = word;
      // A single word wider than the frame still has to break somewhere; walk it down
      // by glyph rather than guessing a character count.
      while (getTextWidth(line) > maxWidth && line.length > 1) {
        let cut = line.length - 1;
        while (cut > 1 && getTextWidth(line.slice(0, cut)) > maxWidth) cut--;
        lines.push(line.slice(0, cut));
        line = line.slice(cut);
      }
    }
    if (line) lines.push(line);
  }
  return lines;
}

/** A rule marking "something ran here", as wide as the frame allows. */
function toolRule(label = " tool call ") {
  const dash = getTextWidth("-");
  const room = FRAME_W - getTextWidth(label);
  const each = Math.max(3, Math.floor(room / dash / 2));
  const side = "-".repeat(each);
  return `${side}${label}${side}`;
}

/**
 * Turns -> one flat list of frame-width lines, oldest first.
 *
 * A blank line separates consecutive prose turns, but never sits next to a tool rule:
 * the rule is already a visual break, and padding it costs two of the ten lines on the
 * glass to say nothing.
 */
export function linesFor(turns) {
  const lines = [];
  let previous = null;
  for (const turn of turns ?? []) {
    if (turn.who === "tool") {
      lines.push(toolRule());
      previous = "tool";
      continue;
    }
    if (previous && previous !== "tool") lines.push("");
    const text = turn.who === "agent" ? turn.text : `${turn.who}: ${turn.text}`;
    lines.push(...wrapToFrame(text));
    previous = turn.who;
  }
  return lines.length ? lines : ["nothing to read yet"];
}

export function createReader() {
  let lines = [];
  let top = 0;
  let target = null;

  const maxTop = () => Math.max(0, lines.length - ROWS);

  return {
    /** Enter at the newest text: the wearer wants what just happened, then history. */
    open(sessionTarget, turns) {
      target = sessionTarget;
      lines = linesFor(turns);
      top = maxTop();
    },
    close() {
      lines = [];
      target = null;
      top = 0;
    },
    isOpen() {
      return Boolean(target);
    },
    target() {
      return target;
    },
    // Half a frame per swipe, in the deck's direction sense: up goes back, down forward.
    // A whole frame loses the sentence you were mid-way through; a single line is too
    // slow to cross a long transcript. Half keeps enough overlap to stay oriented.
    older() {
      top = Math.max(0, top - STEP);
    },
    newer() {
      top = Math.min(maxTop(), top + STEP);
    },
    /** Fresh turns for the same session, keeping the wearer's place. */
    refresh(turns) {
      const wasAtNewest = top >= maxTop();
      lines = linesFor(turns);
      top = wasAtNewest ? maxTop() : Math.min(top, maxTop());
    },
    /**
     * The visible window. `reserve` gives lines back to the caller — the reader hands one
     * to the transcript while the microphone is open.
     */
    visibleLines(reserve = 0) {
      return lines.slice(top, top + Math.max(1, ROWS - reserve));
    },
    page() {
      return this.visibleLines().join("\n");
    },
    position() {
      return { top, total: lines.length, rows: ROWS };
    },
  };
}
