// Ships 128-frame blocks straight out as float32 bytes. WhisperLive wants raw
// little-endian float32 at the context's 16 kHz, which is exactly what the render
// quantum already holds — no resampling, no int16 round trip.
class PcmTap extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0][0];
    if (ch) {
      // Copy once, then transfer that same buffer. Posting one array while
      // transferring a second, freshly-made one sends an already-detached buffer.
      const copy = new Float32Array(ch);
      this.port.postMessage(copy.buffer, [copy.buffer]);
    }
    return true;
  }
}
registerProcessor("pcm-tap", PcmTap);
