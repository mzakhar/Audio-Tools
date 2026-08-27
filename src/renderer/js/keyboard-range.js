/**
 * keyboard-range.js
 * Pure: which slice of the MIDI range the on-screen keys show.
 * Whole octaves only — a partial shift would land every black key on the wrong
 * white-key boundary, so the window moves in twelves or not at all.
 */

export const MIDI_MIN = 0
export const MIDI_MAX = 127

/** The window that contains `note`, shifted from { start, end } in whole octaves. */
export function windowForNote(start, end, note) {
  if (note >= start && note <= end) return { start, end }
  const octaves = note < start
    ? -Math.ceil((start - note) / 12)
    :  Math.ceil((note - end) / 12)
  return shiftWindow(start, end, octaves)
}

/** Move the window by whole octaves, clamped to the MIDI range. */
export function shiftWindow(start, end, octaves) {
  const span = end - start
  let next = start + octaves * 12
  // ponytail: clamping in whole octaves means the last few notes (127 against a
  // 25-key window) sit just outside the reachable window. Widen the window
  // before you break octave alignment.
  while (next < MIDI_MIN) next += 12
  while (next + span > MIDI_MAX) next -= 12
  return { start: next, end: next + span }
}
