// Pure LED pattern engine for the SMC-PAD user-mode mirror. No DOM, no clock.
// The driver owns time and the write budget; see specs/pads-view.md "LED vocabulary".

const OFF = [0, 0, 0];

// Precedence: no sound -> dark; muted -> blink-fast; wipe-armed/target -> blink-slow; else solid.
export function padPattern({ hasSound, muted, wipeArmed, target }) {
  if (!hasSound) return 'dark';
  if (muted) return 'blink-fast';
  if (wipeArmed || target) return 'blink-slow';
  return 'solid';
}

// Slow = 1 Hz, fast = 4 Hz, both 50% duty, on during the first half of each period.
export function ledOn(pattern, tMs) {
  switch (pattern) {
    case 'solid': return true;
    case 'blink-slow': return tMs % 1000 < 500;
    case 'blink-fast': return tMs % 250 < 125;
    default: return false;
  }
}

// pads: 16 pad-state objects (padPattern input); colours: 16 rgb arrays or null.
// A null colour is always off. Returns 16 rgb arrays.
// More than `maxFast` pads wanting the 4 Hz blink get the 1 Hz one instead: every blink
// edge is a burst of SysEx writes, and a fast chorus outruns the device.
export function ledFrame(pads, colours, tMs, maxFast = Infinity) {
  const patterns = pads.map(padPattern);
  const slowFast = patterns.filter(p => p === 'blink-fast').length > maxFast;
  return patterns.map((pattern, i) => {
    const rgb = colours[i];
    return rgb && ledOn(slowFast && pattern === 'blink-fast' ? 'blink-slow' : pattern, tMs) ? rgb : OFF;
  });
}

const same = (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];

// Only pads whose rgb changed. A missing prevFrame means everything is a change.
export function ledDiff(prevFrame, nextFrame) {
  const out = [];
  nextFrame.forEach((rgb, pad) => {
    const prev = prevFrame && prevFrame[pad];
    if (!prev || !same(prev, rgb)) out.push({ pad, rgb });
  });
  return out;
}

// Cap writes per tick. The list is rotated by `offset` before slicing so that when
// diffs exceed the cap, the pads left over this tick lead the next one: the caller
// adds the number it sent to `offset` each tick and no pad starves. Unsent diffs
// are re-found by the next ledDiff because the driver only records sent writes.
export function budget(diffs, maxWrites, offset = 0) {
  if (diffs.length <= maxWrites) return diffs;
  const n = diffs.length;
  const start = ((offset % n) + n) % n;
  return diffs.slice(start).concat(diffs.slice(0, start)).slice(0, maxWrites);
}
