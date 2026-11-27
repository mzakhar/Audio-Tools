// sample-drop.js — PURE helpers for dropping audio files on the Pads view.
// The shell (app.js) reads the file, decodes it and dispatches what these return.

import { SeedKit, SetKitSlot } from '../store/ProjectStore.js'

export const MAX_FILE_BYTES = 25 * 1024 * 1024
export const MAX_PAD_SEC = 60     // one pad: longer files are clipped to this
export const MAX_SLICE_SEC = 30   // slicing: longer files are refused
export const MAX_PAD_BYTES = 10 * 1024 * 1024 // one pad: bigger files are refused before decoding
export const MIN_SLICES = 16, MIN_SLICE_MS = 30, MIN_PAD_MS = 10
const AUDIO_EXT = /\.(wav|mp3|flac|ogg|oga|aiff?|m4a|aac|opus)$/i

/** Size and type gate before any decoding. -> { ok: true } | { ok: false, reason } */
export function checkSampleFile(file, { maxBytes = MAX_FILE_BYTES } = {}) {
  if (!file || !(file.size > 0)) return { ok: false, reason: 'Empty file' }
  if (file.size > maxBytes) return { ok: false, reason: `File too big (max ${Math.round(maxBytes / 1048576)} MB)` }
  const audio = /^audio\//.test(file.type || '') || AUDIO_EXT.test(file.name || '')
  return audio ? { ok: true } : { ok: false, reason: 'Not an audio file' }
}

/** Toast text when the trimmed audio is too short to use, else null. mode: 'slice' | 'pad'. */
export function tooShort(trimmedSamples, sampleRate, mode) {
  const ms = mode === 'slice' ? MIN_SLICES * MIN_SLICE_MS : MIN_PAD_MS
  return trimmedSamples < sampleRate * ms / 1000 ? (mode === 'slice' ? 'Too short to slice' : 'Too short to use') : null
}

/** Seconds a whole-file pad plays: the trimmed tail, capped. */
export const padEndSec = (trimmedSamples, sampleRate) => Math.min(trimmedSamples / sampleRate, MAX_PAD_SEC)

/** Commands that put `slots` ({ note: slot }) into the kit; copies a code-only kit into the project first. */
export function slotCommands(kitId, kit, kitInProject, slots) {
  return [
    ...(kitInProject ? [] : [SeedKit(kitId, kit)]),
    ...Object.entries(slots).map(([note, slot]) => SetKitSlot(kitId, Number(note), slot)),
  ]
}

/** Pad indexes (0..15, any bank) whose slot is a sample. */
export function samplePadsOf(kit) {
  const pads = new Set()
  for (const [note, slot] of Object.entries(kit?.slots ?? {})) {
    const p = Number(note) - 36
    if (slot?.voice === 'sample' && p >= 0 && p < 16) pads.add(p)
  }
  return pads
}
