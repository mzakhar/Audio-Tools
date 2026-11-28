// record-take.js — pure pieces of "Record FM-1 to audio track": file name, clip
// fields, length -> end time, dialog input parsing, and the phase machine as data.
// record-flow.js is the shell that runs the effects.

export const MAX_TAKE_SECONDS = 600
export const BEATS_PER_BAR = 4

const pad = n => String(n).padStart(2, '0')

/** `fm1-<track>-<yyyymmdd-hhmmss>.wav`, always matching /^[\w.-]+\.wav$/i (what the Electron writer demands). */
export function takeFileName(trackName, date) {
  const slug = String(trackName ?? '').normalize('NFKD').replace(/[^\w]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'track'
  const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  return `fm1-${slug}-${stamp}.wav`
}

/** Audio clip timing for a take that starts at `startBeat`. bpm is the value frozen at record start. */
export function clipFields({ startBeat, frames, rate, bpm }) {
  return { startBeat, duration: frames / rate * bpm / 60, offset: 0, fadeIn: 0, fadeOut: 0 }
}

/** Audible ctx time the recording ends by length, or null for "until Stop". */
export function endTimeFor({ startTime, bars, bpm }) {
  return bars == null ? null : startTime + bars * BEATS_PER_BAR * 60 / bpm
}

/** Dialog strings -> { opts } or { error }. Start beat integer >= 0, bars blank or integer >= 1, tail 0..10 s. */
export function parseOptions({ startBeat = '', bars = '', tail = '', mute = false } = {}) {
  const num = s => (String(s).trim() === '' ? null : Number(s))
  const beat = num(startBeat) ?? 0
  if (!Number.isInteger(beat) || beat < 0) return { error: 'Start beat must be a whole number, 0 or more.' }
  const b = num(bars)
  if (b !== null && (!Number.isInteger(b) || b < 1)) return { error: 'Length must be a whole number of bars, or blank to record until Stop.' }
  const t = num(tail) ?? 2
  if (!Number.isFinite(t) || t < 0 || t > 10) return { error: 'Tail must be 0 to 10 seconds.' }
  return { opts: { startBeat: beat, bars: b, tail: t, mute: !!mute } }
}

// idle -> arming -> recording -> tail -> saving -> done | pending (save failed)
// cancel from arming/recording/tail -> idle; pending -> retry -> saving | discard -> idle
const NEXT = {
  idle: { start: 'arming' },
  arming: { armed: 'recording', fail: 'idle', cancel: 'idle' },
  recording: { stop: 'tail', cancel: 'idle' },
  tail: { finish: 'saving', cancel: 'idle' },
  saving: { saved: 'done', failed: 'pending', empty: 'idle' },
  pending: { retry: 'saving', discard: 'idle', saved: 'done' },
  done: { start: 'arming', reset: 'idle' },
}

/** Pure transition: an event that does not apply to the phase leaves it unchanged. */
export const nextPhase = (phase, event) => NEXT[phase]?.[event] ?? phase
export const isActive = phase => phase === 'arming' || phase === 'recording' || phase === 'tail' || phase === 'saving'
