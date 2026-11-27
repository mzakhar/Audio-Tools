// sample-drop.js — PURE helpers for dropping audio files on the Pads view.
// The shell (app.js) reads the file, decodes it and dispatches what these return.

import { SeedKit, SetKitSlot } from '../store/ProjectStore.js'

export const MAX_FILE_BYTES = 25 * 1024 * 1024
export const MAX_PAD_SEC = 60     // one pad: longer files are clipped to this
export const MAX_SLICE_SEC = 30   // slicing: longer files are refused
const AUDIO_EXT = /\.(wav|mp3|flac|ogg|oga|aiff?|m4a|aac|opus)$/i

/** Size and type gate before any decoding. -> { ok: true } | { ok: false, reason } */
export function checkSampleFile(file) {
  if (!file || !(file.size > 0)) return { ok: false, reason: 'Empty file' }
  if (file.size > MAX_FILE_BYTES) return { ok: false, reason: 'File too big (max 25 MB)' }
  const audio = /^audio\//.test(file.type || '') || AUDIO_EXT.test(file.name || '')
  return audio ? { ok: true } : { ok: false, reason: 'Not an audio file' }
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
