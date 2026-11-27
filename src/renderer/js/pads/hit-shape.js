// hit-shape.js — PURE: Full and Ladder applied to one pad hit. app.js calls it
// in exactly one place, before noteOn, so every hit source (hardware, on-screen,
// repeat) is shaped the same way.

import { ladderHit } from './repeat.js'
import { padOf } from './profile.js'

/**
 * pads: { full, ladder }  source: last real hit { note, velocity } | null
 * hit: { note, velocity, repeat? }
 * -> { note, velocity, override, source }  (override = per-hit voice params, or undefined)
 * Ladder on: pad i plays the source at step i; the first hit after switching it on only seeds the source.
 * Ladder off: every non-repeat hit becomes the source.
 */
export function shapeHit({ full, ladder }, source, { note, velocity, repeat = false }) {
  let out = { note, velocity, override: undefined }
  let nextSource = source
  if (ladder) {
    const step = padOf(note)
    if (!source) nextSource = { note, velocity }
    else if (step != null) {
      const h = ladderHit(source, step, ladder)
      out = { note: h.note, velocity: h.velocity, override: h.params }
    }
  } else if (!repeat) nextSource = { note, velocity }
  if (full) out.velocity = 127
  return { ...out, source: nextSource }
}
