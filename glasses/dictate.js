import { socketUrl } from "./api.js";
import { STT } from "./stt-config.js";
import { closeGlassesMic, lensActive, openGlassesMic } from "./lens.js";

const SILENCE_TAIL_MS = 800; // WhisperLive needs >=1s buffered before it finalises

export async function startDictation({ onPartial, onError }) {
  let stream,
    ctx,
    ws,
    node,
    cancelled = false,
    finalText = "",
    reported = false,
    // Declared with the rest so the setup failure path below can call teardown()
    // without tripping over the temporal dead zone.
    torndown = false;

  // The glasses' own 4-mic array, when we are running inside the Even app. Its WebView
  // refuses getUserMedia outright — which is what "no microphone" was — and this is the
  // better source anyway: the wearer talks to the glasses, not at the phone.
  const glasses = lensActive();
  if (!glasses) {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } });
    } catch {
      onError("no microphone");
      return null;
    }
  }

  // Constructing the socket can throw synchronously — a page not allowed to open it, or
  // an AudioContext the device won't give at 16 kHz. Both used to escape this function,
  // so `session` was never assigned, the HUD kept claiming it was listening, and the
  // microphone stayed live with nothing draining it. On the glasses there is no console,
  // so a silent lie about state is the worst available outcome.
  try {
    if (!glasses) ctx = new AudioContext({ sampleRate: 16000 });
    // Lumbergh proxies onward to WhisperLive rather than the page reaching it directly:
    // an HTTPS page may not open an insecure socket, and a packed bundle's own origin
    // has no server at all.
    ws = new WebSocket(socketUrl(STT.path));
    ws.binaryType = "arraybuffer";
  } catch (err) {
    teardown();
    reported = true;
    onError(`can't start: ${err?.name || "error"}`);
    return null;
  }

  ws.onopen = () => {
    ws.send(
      JSON.stringify({
        uid: crypto.randomUUID(),
        language: STT.language,
        task: "transcribe",
        model: STT.model,
        use_vad: STT.useVad,
        send_last_n_segments: 10,
        initial_prompt: STT.initialPrompt,
        hotwords: STT.hotwords,
      }),
    );
  };

  ws.onerror = () => {
    teardown();
    reported = true;
    onError("no link to whisper");
  };

  ws.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (!msg.segments) return;
    // The server re-sends its last N completed segments, so rebuild rather than append.
    finalText = msg.segments
      .map((s) => s.text)
      .join(" ")
      .trim();
    onPartial(finalText);
  };

  function teardown() {
    if (torndown) return;
    torndown = true;
    try {
      node?.disconnect();
    } catch {
      // Already disconnected or never connected — teardown proceeds either way.
    }
    if (glasses) {
      closeGlassesMic();
    }
    try {
      stream?.getTracks().forEach((t) => t.stop());
    } catch {
      // Track already stopped — fine.
    }
    try {
      ctx?.close();
    } catch {
      // Context already closed — fine.
    }
    try {
      ws.close();
    } catch {
      // Socket already closed or never opened — fine.
    }
  }

  if (glasses) {
    const opened = await openGlassesMic((buffer) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(buffer);
    });
    if (!opened) {
      teardown();
      if (!reported) onError("glasses mic refused");
      return null;
    }
  } else {
    try {
      await ctx.audioWorklet.addModule("./pcm-worklet.js");
    } catch {
      teardown();
      // A dead link aborts the worklet load too, in which case ws.onerror already
      // reported it — only speak up here if this failure got there first.
      if (!reported) onError("no link to whisper");
      return null;
    }
    node = new AudioWorkletNode(ctx, "pcm-tap");
    node.port.onmessage = (e) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(e.data);
    };
    ctx.createMediaStreamSource(stream).connect(node);
  }

  return {
    async commit() {
      if (cancelled) return "";
      // Let the tail of the last word reach the server before closing.
      await new Promise((r) => setTimeout(r, SILENCE_TAIL_MS));
      // A cancel() can land while the above await is asleep — re-check rather
      // than trusting the pre-await snapshot, or a cancelled dictation still ships.
      if (cancelled) return "";
      teardown();
      return finalText;
    },
    cancel() {
      cancelled = true;
      teardown();
    },
  };
}
