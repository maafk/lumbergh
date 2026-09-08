// Touch adapter — the phone browser's controls.
//
// The HUD shipped keyboard-only, which made it read-only on the device it is most
// used from: you can watch the fleet on a phone but not drive it. This maps the same
// four actions the G2 gesture adapter drives onto touch, so both surfaces share one
// set of handlers and the keyboard path stays exactly as it is for desktop debugging.
//
// Deliberately not debounced, unlike gestures.js. That cooldown exists because the
// G2's scroll-boundary events can re-fire for one physical swipe; touchend fires once
// per finger lift, and press()'s own re-entrancy guard already covers a double-tap
// landing on the dictation toggle. Debouncing here would only swallow deliberate input.

// Below this, a touch is a tap rather than a swipe. Comfortably larger than the jitter
// of a finger resting on glass, small enough that a short flick still registers.
const SWIPE_MIN_PX = 30;
// A swipe is vertical if it is mostly vertical: a diagonal drag should still page the
// deck rather than being discarded for not being perfectly straight.
const VERTICAL_BIAS = 1.2;
const DOUBLE_TAP_MS = 300;

export function bindTouch(target, { onSwipeUp, onSwipeDown, onPress, onDoublePress }) {
  if (!target || typeof target.addEventListener !== "function") return false;
  if (typeof window === "undefined" || !("ontouchstart" in window)) return false;

  let startX = 0;
  let startY = 0;
  let lastTapAt = 0;
  let pendingTap = null;

  target.addEventListener(
    "touchstart",
    (e) => {
      const t = e.changedTouches[0];
      startX = t.clientX;
      startY = t.clientY;
    },
    { passive: true },
  );

  target.addEventListener(
    "touchend",
    (e) => {
      const t = e.changedTouches[0];
      const dx = t.clientX - startX;
      const dy = t.clientY - startY;

      if (Math.abs(dy) >= SWIPE_MIN_PX && Math.abs(dy) > Math.abs(dx) * VERTICAL_BIAS) {
        // The page is a fixed 576x288 with nothing scrollable, so claiming the
        // gesture costs no native behaviour and stops a swipe becoming a page drag.
        e.preventDefault();
        if (dy < 0) onSwipeUp?.();
        else onSwipeDown?.();
        return;
      }

      if (Math.abs(dx) >= SWIPE_MIN_PX || Math.abs(dy) >= SWIPE_MIN_PX) return;

      e.preventDefault();
      const now = Date.now();
      if (now - lastTapAt < DOUBLE_TAP_MS) {
        // The second tap of a double retracts the first: a double-tap means "back to
        // attention order", never that plus a stray dictation toggle.
        clearTimeout(pendingTap);
        pendingTap = null;
        lastTapAt = 0;
        onDoublePress?.();
        return;
      }
      lastTapAt = now;
      pendingTap = setTimeout(() => {
        pendingTap = null;
        onPress?.();
      }, DOUBLE_TAP_MS);
    },
    { passive: false },
  );

  return true;
}
