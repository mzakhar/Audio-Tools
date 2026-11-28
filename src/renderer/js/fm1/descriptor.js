// descriptor.js — the FM-1 track instrument descriptor and the pure helpers the
// UI and the live/timeline adapters share. No DOM, no audio.
//   { type: 'fm1', firmwareHash: 'sha256:<hex>', deviceChannel: 0..15, mhz: 60..240 }
// `deviceChannel` is the channel the firmware listens on; it is NOT
// track.midiChannel, which is Synth's own input routing.

export const FM1_MHZ_CHOICES = [60, 80, 100, 120, 160, 200, 240]
export const FM1_DEFAULT_MHZ = 120

const clampInt = (value, lo, hi, fallback) => {
  const n = Math.round(Number(value))
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback
}

/** Canonical form: acquire() compares descriptors, so defaults and ranges are applied once, here. */
export function fm1Descriptor(instrument) {
  return {
    type: 'fm1',
    firmwareHash: instrument?.firmwareHash ?? null,
    deviceChannel: clampInt(instrument?.deviceChannel, 0, 15, 0),
    mhz: clampInt(instrument?.mhz, 60, 240, FM1_DEFAULT_MHZ)
  }
}

/** Instrument for an installed firmware record (firmware-store list()). */
export const fm1InstrumentFor = (record, keep = {}) => ({ ...keep, ...fm1Descriptor({ firmwareHash: record.id }) })

/** Pitch bend -1..1 as a full-range 14-bit message; 0 is the centre, 8192. */
export function bendBytes(channel, value) {
  const raw = clampInt(8192 + (Number(value) || 0) * 8191, 0, 16383, 8192)
  return [0xE0 | channel, raw & 0x7f, raw >> 7]
}

/** Mod wheel 0..1 as CC1. */
export const modBytes = (channel, value) => [0xB0 | channel, 1, clampInt((Number(value) || 0) * 127, 0, 127, 0)]

/** A firmware that cannot keep up live at this clock, or one the catalog flags as too slow. */
export function slowWarning(mhz, compat) {
  if (!compat) return null
  if (compat.minMhz && mhz < compat.minMhz) return `This firmware needs at least ${compat.minMhz} MHz to play live.`
  if (/too slow live/i.test(compat.note || '')) return 'Reported too slow to play live on the reference PC.'
  return null
}

export const FAILURE_TEXT = {
  'missing-firmware': 'The firmware for this track is not installed.',
  'boot-failed': 'The firmware did not start.',
  'wasm-failed': 'The emulator could not be loaded.',
  halted: 'The device stopped (the firmware crashed).'
}

export const failureText = reason => FAILURE_TEXT[reason] || `The device failed${reason ? ` (${reason})` : ''}.`
