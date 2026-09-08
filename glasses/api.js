// One place that knows where Lumbergh is.
//
// The page can be loaded two ways and they need different answers: served by Lumbergh
// (browser, or the `evenhub qr` sideload) where same-origin works, or from a packed
// .ehpk, where the Even app serves the bundle locally and a relative /api request goes
// nowhere. That second case is what "no link to lumbergh" was.

import { LUMBERGH_URL } from "./config.js";

const PROBE_TIMEOUT_MS = 4000;
let base = null;
let resolved = false;

/** Candidate bases, best first. Same-origin is only a candidate over http(s). */
function servedFromBundleServer() {
  // The Even app hosts a packed bundle on 127.0.0.1 at an ephemeral port. Lumbergh's own
  // dev ports (8420, 5420) are loopback too, so the port is what distinguishes them.
  const port = Number(location.port || 0);
  return /^(127\.0\.0\.1|localhost|\[::1\])$/.test(location.hostname) && port > 10000;
}

function candidates() {
  const list = [];
  const http = location.protocol === "http:" || location.protocol === "https:";
  if (http && !servedFromBundleServer()) list.push("");
  if (LUMBERGH_URL) list.push(LUMBERGH_URL.replace(/\/$/, ""));
  return list;
}

/**
 * Is Lumbergh actually behind this base?
 *
 * A 200 is not enough. The Even app serves a packed bundle from a local HTTP server that
 * answers unknown paths with its own index — so `/api/glasses/board` came back 200 with
 * HTML, same-origin was accepted, and every real request then failed on a JSON parse.
 * The board's own shape is the only honest test.
 */
async function reachable(candidate) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(`${candidate}/api/glasses/board?wait=false`, {
      cache: "no-store",
      signal: controller.signal,
    });
    if (!res.ok) return false;
    const body = await res.json();
    return Array.isArray(body?.cards);
  } catch {
    // Not JSON, not reachable, or timed out — all the same answer here.
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Settle on a base once, and keep it. Returns false when nothing answered — the caller
 * says so on the glass rather than retrying forever in silence.
 */
export async function resolveBase() {
  if (resolved && base !== null) return true;
  for (const candidate of candidates()) {
    if (await reachable(candidate)) {
      base = candidate;
      resolved = true;
      return true;
    }
  }
  resolved = false;
  return false;
}

export function apiUrl(path) {
  return `${base ?? ""}${path}`;
}

/** The STT socket, on whichever base answered — and wss:// whenever the base is https. */
export function socketUrl(path) {
  if (base) return `${base.replace(/^http/, "ws")}${path}`;
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${location.host}${path}`;
}

/**
 * Why the page cannot reach Lumbergh, in words that fit the glass.
 *
 * "cannot reach it" and "was never told where it is" are different problems with
 * different fixes, and a single message for both sent me chasing the wrong one.
 */
export function failureMessage() {
  if (!LUMBERGH_URL && servedFromBundleServer()) {
    return "no lumbergh url in this build";
  }
  const candidate = LUMBERGH_URL || location.host;
  let host = candidate;
  try {
    host = new URL(candidate).host;
  } catch {
    // Already a bare host, or something unparseable — either way it names the target.
  }
  return `no link to ${host || "lumbergh"}`;
}
