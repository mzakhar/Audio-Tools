// kit.js — PURE kit data: which 909 voice answers each GM percussion note.
// No DOM, no audio. kit-voices.js turns a kit into sound.

import { INSTRUMENTS } from '../drums/tr909-kit.js'

const DEFAULTS = Object.fromEntries(INSTRUMENTS.map(inst => [inst.id, inst.params]))

// `params` overrides the 909 defaults for that voice. `group` + `open`: a
// non-open hit in a group chokes the sounding open hit (hat 42/44 cut 46).
const slot = (voice, params = {}, group, open) => ({ voice, params, ...(group ? { group } : {}), ...(open ? { open } : {}) })

const MAIN = {
  36: slot('bd'),
  37: slot('rs'),
  38: slot('sd'),
  39: slot('cp'),
  40: slot('sd', { tune: 0.62, snappy: 0.9 }),
  41: slot('lt'),
  42: slot('ch', {}, 'hat'),
  43: slot('lt', { tune: 0.5 }),
  44: slot('ch', { decay: 0.06 }, 'hat'),
  45: slot('mt'),
  46: slot('oh', {}, 'hat', true),
  47: slot('mt', { tune: 0.64 }),
  48: slot('ht'),
  49: slot('cr'),
  50: slot('ht', { tune: 0.8 }),
  51: slot('rd')
}

// GM notes without a voice of their own play the nearest slot.
const ALIASES = { 35: 36, 52: 49, 53: 51, 54: 37, 55: 49, 57: 49, 58: 39, 59: 51 }

export const KITS = {
  'default-909': {
    id: 'default-909',
    name: 'Drum Kit',
    slots: {
      ...MAIN,
      ...Object.fromEntries(Object.entries(ALIASES).map(([note, to]) => [note, { ...MAIN[to], aliasOf: to }])),
      56: slot('rs', { tone: 0.85 })
    }
  }
}

/** A pad that plays a region (seconds) of a stored user sample. */
export const sampleSlot = ({ sampleId, name, start, end }) => ({ voice: 'sample', sampleId, name, start, end })

/** 16 slots for pads 0..15 (notes 36..51) from slicer regions given in sample indexes. */
export function sliceSlots(regions, sampleRate, { sampleId, name }) {
  return Object.fromEntries(regions.map((r, i) => [36 + i, sampleSlot({ sampleId, name: `${name} ${i + 1}`, start: r.start / sampleRate, end: r.end / sampleRate })]))
}

/** Short pad label: 909 voice upper-case, sample name cut to 8, '—' when empty. */
export function slotLabel(slotDef) {
  if (!slotDef) return '—'
  return slotDef.voice === 'sample' ? String(slotDef.name || 'sample').slice(0, 8) : slotDef.voice.toUpperCase()
}

export const DEFAULT_KIT_ID = 'default-909'

/** Kit for an id, or null — an unknown kit is silent, like a missing pack. */
export function kitFor(kitId, kits) {
  return kits?.[kitId] ?? KITS[kitId] ?? null
}

/** Full param set for a slot: the 909 defaults under the slot's overrides. */
export function slotParams(slotDef) {
  return { ...DEFAULTS[slotDef.voice], ...slotDef.params }
}

/**
 * Harder hits ring longer, brighter and (at the top) accented. Gain is the
 * voice's own velocity input. Returns fresh params; never mutates.
 */
export function velocityTimbre(vel01, params) {
  const v = Math.min(1, Math.max(0, vel01))
  const out = { ...params }
  if (out.decay != null) out.decay *= 0.6 + 0.6 * v
  if (out.tone != null) out.tone *= 0.7 + 0.5 * v
  return { params: out, accent: v >= 0.9 }
}

// Device RGB bytes for the pad LEDs, by voice family. White is left out: the
// SMC-PAD flashes white on a hit by itself.
const VOICE_RGB = {
  bd: [255, 0, 0],
  sd: [255, 80, 0],
  rs: [160, 0, 255],
  cp: [160, 0, 255],
  ch: [255, 200, 0],
  oh: [255, 200, 0],
  lt: [0, 255, 0],
  mt: [0, 255, 120],
  ht: [0, 200, 255],
  cr: [0, 60, 255],
  rd: [0, 60, 255],
  sample: [255, 0, 140]
}

/** Colour of each of the 16 pads (pad i plays note 36 + i); null where a pad has no voice. */
export function padColours(kit) {
  return Array.from({ length: 16 }, (_, i) => VOICE_RGB[kit.slots[36 + i]?.voice] ?? null)
}
