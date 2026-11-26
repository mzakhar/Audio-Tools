// velocity-curve.js — PURE per-device velocity shaping, applied where a hit is
// played (live), never to stored notes. A pad that tops out at 109 should still
// be able to play the whole dynamic range.

const SHAPES = {
  linear: x => x,
  soft: x => x ** 0.6,
  hard: x => x ** 1.6,
  compress: x => 0.5 + 0.5 * x
}

const IDENTITY = { inMax: 127, curve: 'linear' }

/** vel 0..127 in, 0..127 int out. 0 means the hit is dropped. */
export function applyVelocityCurve(vel, { threshold = 0, inMax = 127, curve = 'linear', full = false } = {}) {
  if (!(vel > 0) || vel < threshold) return 0
  if (full) return 127
  const x = Math.min(1, Math.max(0, vel / inMax))
  const shape = SHAPES[curve] || SHAPES.linear
  return Math.min(127, Math.max(1, Math.round(shape(x) * 127)))
}

/** Curve config for a MIDI input name. Phase 1: code defaults, no UI. */
export function curveForDevice(inputName) {
  // SMC-PAD tops out near 109-110, which velocityGain read as ~0.94.
  if (/smc-pad/i.test(inputName || '')) return { threshold: 0, inMax: 110, curve: 'linear' }
  return IDENTITY
}
