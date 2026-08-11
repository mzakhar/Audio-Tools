// Pure core for MARBLE — the Marbles-lite gate and CV generator.
//
// Everything stochastic in the module routes through here, so a seeded
// `random` makes a rack bounce reproducible and the déjà-vu loop testable.

import { clampCv } from '../utils/cv.js'

export const MAX_LOOP = 16
// X outputs span ±2 octaves at full spread. Wider is unmusical once the value
// is quantized, and the attenuverter on the receiving jack can always widen it.
export const X_RANGE = 0.2

const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v) || 0

// ─── Déjà vu ───────────────────────────────────────────────────────────────

// One draw against the loop buffer. `amount` is the probability the stored
// value survives:
//   0  → every clock draws a new value and overwrites the slot
//   1  → the slot is returned verbatim, so `history.length` values repeat
//   .5 → the loop plays, with a new value substituted into it about half the
//        time — the useful middle
//
// Two draws are consumed whatever `amount` says (the decision, then the
// candidate) so a seeded sequence stays aligned when the knob moves. Returns a
// fresh history; nothing is mutated.
export function dejaVuValue(history, index, amount, random = Math.random) {
  const source = Array.isArray(history) ? history : []
  const len = Math.max(1, source.length)
  const at = ((Math.round(index) % len) + len) % len
  const roll = random()
  const fresh = random()
  const stored = source[at]
  const next = source.slice()
  next.length = len
  next[at] = stored !== undefined && roll < clamp01(amount) ? stored : fresh
  return { value: next[at], history: next }
}

// Grow or shrink the loop buffer. New slots are holes, so they read as "no
// stored value" and draw fresh on their first pass.
export function resizeLoop(history, length) {
  const len = Math.max(1, Math.min(MAX_LOOP, Math.round(length) || 1))
  const next = (Array.isArray(history) ? history : []).slice(0, len)
  next.length = len
  return next
}

// ─── Gates ─────────────────────────────────────────────────────────────────

// Tent weights over the three T outputs. BIAS slides the density from T1 (0)
// through T2 (.5) to T3 (1); JITTER widens each tent until all three are
// equally likely. A floor keeps every output occasionally alive.
export function gateWeights(bias, jitter) {
  const b = clamp01(bias)
  const width = 0.3 + clamp01(jitter) * 1.2
  return [0, 0.5, 1].map(p => Math.min(1, Math.max(0.02, 1 - Math.abs(p - b) / width)))
}

// One clock of independent coin flips — one draw per output, hit or not.
export function gateDistribution(bias, jitter, random = Math.random) {
  return gateWeights(bias, jitter).map(p => random() < p)
}

// The three T outputs for one clock, shaped by MODE. `ratchet` asks the module
// for a second T3 gate half a clock later.
//
//   coin    — three independent flips from gateDistribution
//   divmult — T2 every clock, T1 divided by 2..4 (BIAS), T3 doubled
//   drums   — a kick / snare / hat relationship on a 16 count, BIAS thinning
//             the hats and JITTER deciding the off-beat fills
//
// The coin flips are always drawn so the seeded sequence does not shift when
// MODE changes.
export function gatePattern(mode, step, bias, jitter, random = Math.random) {
  const [c1, c2, c3] = gateDistribution(bias, jitter, random)
  const s = ((Math.round(step) % 16) + 16) % 16
  if (mode === 'divmult') {
    const div = 2 + Math.round(clamp01(bias) * 2)
    return { t1: s % div === 0, t2: true, t3: true, ratchet: true }
  }
  if (mode === 'drums') {
    return { t1: s % 8 === 0 || (s === 14 && c1), t2: s % 8 === 4, t3: s % 2 === 0 || c3, ratchet: false }
  }
  return { t1: c1, t2: c2, t3: c3, ratchet: false }
}

// ─── X voltages ────────────────────────────────────────────────────────────

// A stored 0..1 draw becomes a pitch CV: BIAS is the centre of the
// distribution, SPREAD its width. Storing the raw unit rather than the volt is
// what lets BIAS and SPREAD reshape a locked loop without rewriting it.
export function xVoltage(unit, spread, bias) {
  const centre = (clamp01(bias) * 2 - 1) * X_RANGE
  return clampCv(centre + (clamp01(unit) * 2 - 1) * clamp01(spread) * X_RANGE)
}

// STEPS crossfades between the smooth voltage and its quantized neighbour
// rather than switching at a threshold, so the knob sweeps from glide to grid.
export function xValue(unit, spread, bias, steps = 0, quantize = v => v) {
  const raw = xVoltage(unit, spread, bias)
  return raw + (quantize(raw) - raw) * clamp01(steps)
}
