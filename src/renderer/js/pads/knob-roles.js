// PURE knob role table: what each of the 8 encoders does, as effect descriptors.
import { GROOVE_STEPS } from './groove.js'
import { REPEAT_RATES } from './repeat.js'

export const KNOB_ROLES = ['groove', 'repeatRate', 'tune', 'decay', 'filter', 'level', 'snapStrength', 'bpm']

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
const r3 = v => Math.round(v * 1000) / 1000
const RATES = Object.keys(REPEAT_RATES)
const RATE_DEFAULT = '1/16'
// multiplicative roles: [params key, default, lo, hi]
const MUL = { decay: ['decayMul', 1, 0.25, 2], filter: ['filterMul', 1, 0.2, 1.5], level: ['level', 1, 0.05, 1.5] }

const nearest = (list, v) => list.reduce((best, s, i) => (Math.abs(s - v) < Math.abs(list[best] - v) ? i : best), 0)

/** delta = signed detents. Returns effect descriptors (empty when nothing to change). */
export function applyKnob(index, delta, { pads = {}, bpm = 120, slot = null, note = null } = {}) {
  const role = KNOB_ROLES[index]
  if (!role || !delta) return []
  const dir = Math.sign(delta)
  const n = Math.abs(Math.round(delta))
  switch (role) {
    case 'groove': {
      const i = clamp(nearest(GROOVE_STEPS, pads.groove ?? 0.5) + dir * n, 0, GROOVE_STEPS.length - 1)
      return [{ type: 'pads', patch: { groove: GROOVE_STEPS[i] } }]
    }
    case 'repeatRate': {
      const i = clamp(RATES.indexOf(pads.repeatRate ?? RATE_DEFAULT) + dir * n, 0, RATES.length - 1)
      return [{ type: 'pads', patch: { repeatRate: RATES[i] } }]
    }
    case 'snapStrength':
      return [{ type: 'pads', patch: { snapStrength: r3(clamp((pads.snapStrength ?? 1) + dir * n * 0.05, 0, 1)) } }]
    case 'bpm':
      return [{ type: 'bpm', bpm: clamp(Math.round(bpm + dir * n), 40, 240) }]
    case 'tune': {
      if (!slot || note == null) return []
      return [{ type: 'slot', note, params: { tuneSt: clamp(Math.round((slot.params?.tuneSt ?? 0) + dir * n), -24, 24) } }]
    }
    default: {
      if (!slot || note == null) return []
      const [key, def, lo, hi] = MUL[role]
      const v = clamp(r3((slot.params?.[key] ?? def) * 1.05 ** (dir * n)), lo, hi)
      return [{ type: 'slot', note, params: { [key]: v } }]
    }
  }
}

/** Short readout for the on-screen knob twin. */
export function knobLabel(index, { pads = {}, bpm = 120, slot = null } = {}) {
  const role = KNOB_ROLES[index]
  const pct = v => `${Math.round(v * 100)}%`
  switch (role) {
    case 'groove': return pct(pads.groove ?? 0.5)
    case 'repeatRate': return pads.repeatRate ?? RATE_DEFAULT
    case 'snapStrength': return pct(pads.snapStrength ?? 1)
    case 'bpm': return String(Math.round(bpm))
    case 'tune': {
      if (!slot) return '—'
      const t = slot.params?.tuneSt ?? 0
      return `${t > 0 ? '+' : ''}${t} st`
    }
    case 'decay': case 'filter': case 'level': {
      if (!slot) return '—'
      const [key, def] = MUL[role]
      return pct(slot.params?.[key] ?? def)
    }
    default: return ''
  }
}
