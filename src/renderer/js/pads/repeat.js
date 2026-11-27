// Pure Note Repeat / Ladder math. Units: beats; velocity 0..127.
import { swingOffset } from './groove.js'

export const REPEAT_RATES = { '1/4': 1, '1/8': 0.5, '1/8T': 1 / 3, '1/16': 0.25, '1/16T': 1 / 6, '1/32': 0.125, '1/32T': 1 / 12 }

const r9 = (x) => Math.round(x * 1e9) / 1e9

/** Swung grid points anchor + k*rate (k>=0) falling in [fromBeat, toBeat). */
export function repeatBeatsInWindow(fromBeat, toBeat, { rate, swing = 0.5, anchor = 0 }) {
  const out = []
  // start one step early: swing can push an earlier odd point into the window
  for (let k = Math.max(0, Math.floor((fromBeat - anchor) / rate) - 1); ; k++) {
    const nominal = anchor + k * rate
    if (nominal >= toBeat) break
    const p = r9(nominal + swingOffset(k, swing, rate))
    if (p >= fromBeat && p < toBeat) out.push(p)
  }
  return out
}

/** Strike velocity inside the burst gate or without pressure; else pressure scaled to 30..127. */
export function pressureVelocity(pressure, { sinceStrikeMs, strikeVelocity, gateMs = 40 }) {
  if (pressure == null || sinceStrikeMs < gateMs) return strikeVelocity
  const v = Math.round(30 + (Math.min(127, Math.max(0, pressure)) / 127) * 97)
  return Math.min(127, Math.max(30, v))
}

/** Ladder: spread one source over 16 steps by one parameter. */
export function ladderHit(source, step, param) {
  const hit = { note: source.note, velocity: source.velocity, params: {} }
  if (param === 'velocity') hit.velocity = Math.round(8 + step * (119 / 15))
  else if (param === 'tune') hit.params.tuneSt = step - 8
  else if (param === 'decay') hit.params.decayMul = 0.25 + step * (1.75 / 15)
  else if (param === 'filter') hit.params.filterMul = 0.2 + step * (0.8 / 15)
  return hit
}
