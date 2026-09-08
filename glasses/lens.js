// The glasses themselves.
//
// The Even app's WebView runs this page's JS and renders its DOM — but only on the
// phone. The lenses are a separate display: they show what is pushed to them as
// positioned containers over BLE, and never the DOM. So everything the wearer actually
// sees comes from here.
//
// Coordinates are the real 576x288 lens frame, matching index.html's stage one for one,
// so the phone preview and the lenses show the same layout. Firmware limits: at most 8
// text containers, containerTotalNum 1..12, text brightness 0..4.

import { apiUrl } from "./api.js";
import {
  AudioInputSource,
  CreateStartUpPageContainer,
  OsEventTypeList,
  RebuildPageContainer,
  TextContainerProperty,
  waitForEvenAppBridge,
} from "./vendor/even_hub_sdk-0.0.15.js";

const BRIGHT = 4;

// Stable ids: a rebuild replaces content in place, so the same slot keeps the same id
// rather than the lenses being torn down and re-created on every board change.
// Two slots are all that render now: the page (list or reader) and the dictation box
// floating over it.
const SLOT = { LINE: 1, HEARD: 2 };

function text(containerID, name, x, y, w, h, content, brightness = BRIGHT, capture = 0) {
  return new TextContainerProperty({
    containerID,
    containerName: name,
    xPosition: x,
    yPosition: y,
    width: w,
    height: h,
    content,
    textColor: brightness,
    // Is_event_capture: a container has to opt in before the firmware routes input
    // through it. Exactly one does, so a tap has a single unambiguous target.
    isEventCapture: capture,
    zOrderIndex: containerID,
  });
}

// The dictation box: a bordered container over the page while the microphone is open,
// or while dictated words wait on a decision.
const BOX = { x: 24, y: 180, w: 528, h: 90, border: 2, pad: 8 };
export const BOX_TEXT_WIDTH = BOX.w - 2 * (BOX.border + BOX.pad);

const LINE_H = 27;

// A container has no background or fill, and the firmware does not clear what a higher
// z-order covers — stacking the box over text drew both on top of each other and was
// unreadable on the glasses. So the rows the box occupies are blanked in the page
// beneath it, leaving the box the only thing on that stretch of glass.
const BOX_FIRST_ROW = Math.floor(BOX.y / LINE_H);
const BOX_LAST_ROW = Math.ceil((BOX.y + BOX.h) / LINE_H) - 1;

function clearBehindBox(pageText) {
  const lines = pageText.split("\n");
  // The blank rows have to exist even when the page is shorter than the box's top.
  while (lines.length <= BOX_LAST_ROW) lines.push("");
  for (let i = BOX_FIRST_ROW; i <= BOX_LAST_ROW; i++) lines[i] = "";
  return lines.join("\n");
}

/** The page — the session list, or the reader — plus the dictation box when it is up. */
function pageContainers(view) {
  const body = view.heard ? clearBehindBox(view.text || "") : view.text || "";
  const page = text(SLOT.LINE, "page", 0, 0, 576, 288, body, BRIGHT, 1);
  page.paddingLength = 0;
  page.zOrderIndex = 1;
  if (!view.heard) return [page];

  const box = text(SLOT.HEARD, "dictation", BOX.x, BOX.y, BOX.w, BOX.h, view.heard, BRIGHT, 0);
  box.borderWidth = BOX.border;
  box.borderRadius = 6;
  box.paddingLength = BOX.pad;
  // Above the page, so the firmware draws it last.
  box.zOrderIndex = 2;
  return [page, box];
}

// There is no console in the Even app's WebView, so the only way to find out what the
// temple actually sends is to have the page say so. Capped and deduplicated by shape:
// enough to identify the event vocabulary, not a telemetry stream.
const reported = new Set();
function reportEvent(event) {
  const shape = [
    event?.sysEvent ? `sys:${event.sysEvent.eventType}` : "",
    event?.textEvent ? `text:${event.textEvent.eventType}` : "",
    event?.listEvent ? `list:${event.listEvent.eventType}` : "",
    event?.audioEvent ? "audio" : "",
    Object.keys(event ?? {}).join("+"),
  ].join("|");
  if (reported.has(shape) || reported.size > 24) return;
  reported.add(shape);
  fetch(apiUrl("/api/glasses/probe"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ lensEvent: shape, keys: Object.keys(event ?? {}) }),
  }).catch(() => {});
}

/**
 * Close the plugin and hand the glasses back.
 *
 * `exitMode: 0` exits immediately rather than raising the host's own confirm layer —
 * a double press is already deliberate, and a confirmation the wearer has to dismiss
 * on a 576x288 frame is worse than the accident it guards against.
 *
 * Returns false in a plain browser, where there is nothing to quit.
 */
export async function quitLens() {
  if (!bridge) return false;
  try {
    await closeGlassesMic();
    await bridge.shutDownPageContainer(0);
    return true;
  } catch {
    return false;
  }
}

/** True once the bridge is up, i.e. we are running inside the Even app. */
export function lensActive() {
  return Boolean(bridge);
}

/**
 * Normalise a PCM frame from the host into signed 16-bit samples.
 *
 * The payload survives a JSON hop, so it arrives as a Uint8Array, a plain number[], or
 * base64 depending on host version — all three are the same little-endian int16 bytes.
 */
function toInt16(pcm) {
  let bytes;
  if (typeof pcm === "string") {
    const raw = atob(pcm);
    bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  } else if (pcm instanceof Uint8Array) {
    bytes = pcm;
  } else if (Array.isArray(pcm)) {
    bytes = new Uint8Array(pcm);
  } else {
    return null;
  }
  // An odd trailing byte would shift every subsequent sample by one, turning speech
  // into noise, so the frame is truncated to whole samples.
  const usable = bytes.byteLength - (bytes.byteLength % 2);
  return new Int16Array(bytes.buffer, bytes.byteOffset, usable / 2);
}

let audioSink = null;

/**
 * Open the glasses microphone. Frames reach `onFloat32` as WhisperLive wants them:
 * little-endian float32 at 16 kHz, the rate the G2's array captures at.
 */
export async function openGlassesMic(onFloat32) {
  if (!bridge) return false;
  audioSink = onFloat32;
  try {
    return await bridge.audioControl(true, AudioInputSource.Glasses);
  } catch {
    audioSink = null;
    return false;
  }
}

export async function closeGlassesMic() {
  audioSink = null;
  if (!bridge) return;
  try {
    await bridge.audioControl(false);
  } catch {
    // Already closed, or the host is gone — nothing left to release here.
  }
}

let bridge = null;
let created = false;
let lastPushed = "";

/**
 * Wire the glasses up. Resolves false in a plain browser (desktop dev, or the phone
 * browser outside the Even app), where there is no bridge and the DOM page is the whole
 * story — the caller carries on unchanged.
 */
export async function initLens({
  onSwipeUp,
  onSwipeDown,
  onPress,
  onDoublePress,
  onHoldStart,
  onHoldEnd,
} = {}) {
  if (typeof window === "undefined" || !window.flutter_inappwebview) return false;
  try {
    bridge = await waitForEvenAppBridge();
  } catch {
    return false;
  }
  if (!bridge) return false;

  // A bridge method, not a window event — an earlier version listened on window and so
  // never received anything. Returns an unsubscribe, unused: this lives for the page.
  bridge.onEvenHubEvent((event) => {
    reportEvent(event);
    const type =
      event?.sysEvent?.eventType ?? event?.textEvent?.eventType ?? event?.listEvent?.eventType;
    if (event?.audioEvent) {
      const samples = audioSink && toInt16(event.audioEvent.audioPcm);
      if (samples) {
        const f32 = new Float32Array(samples.length);
        for (let i = 0; i < samples.length; i++) f32[i] = samples[i] / 32768;
        audioSink(f32.buffer);
      }
      return;
    }
    if (type === OsEventTypeList.IMU_DATA_REPORT) return;

    // CLICK_EVENT is 0, which the host's JSON decoding sometimes drops to undefined.
    if (type === OsEventTypeList.CLICK_EVENT || type === undefined) onPress?.();
    else if (type === OsEventTypeList.DOUBLE_CLICK_EVENT) onDoublePress?.();
    else if (type === OsEventTypeList.SCROLL_TOP_EVENT) onSwipeUp?.();
    else if (type === OsEventTypeList.SCROLL_BOTTOM_EVENT) onSwipeDown?.();
    else if (type === OsEventTypeList.LONG_PRESS_EVENT) onHoldStart?.();
    else if (type === OsEventTypeList.LONG_PRESS_RELEASE_EVENT) onHoldEnd?.();
  });

  return true;
}

/**
 * Push a view to the lenses. Unchanged content is dropped rather than re-sent: this runs
 * on every board poll and every partial transcript, and each push is a BLE round trip.
 */
export async function renderLens(view) {
  if (!bridge) return;
  const containers = pageContainers(view);
  const key = JSON.stringify(containers.map((c) => [c.containerID, c.content, c.textColor]));
  if (key === lastPushed) return;
  lastPushed = key;

  try {
    if (!created) {
      // Required once per app launch, before any rebuild will be accepted.
      await bridge.createStartUpPageContainer(
        new CreateStartUpPageContainer({
          containerTotalNum: containers.length,
          textObject: containers,
        }),
      );
      created = true;
      return;
    }
    await bridge.rebuildPageContainer(
      new RebuildPageContainer({
        containerTotalNum: containers.length,
        textObject: containers,
      }),
    );
  } catch {
    // A refused push must not take the page with it — the phone view stays usable and
    // the next change tries again.
    lastPushed = "";
  }
}
