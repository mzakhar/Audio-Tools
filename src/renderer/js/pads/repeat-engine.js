// repeat-engine.js — shell: Note Repeat. While Repeat and a pad are both held,
// the pad retriggers at `rate` on the loop player's beat grid (or free-running
// from the press when the loop is stopped). The grid maths is repeat.js; this
// only owns the 25 ms tick / 100 ms lookahead and the held-pad table.

import { repeatBeatsInWindow, pressureVelocity } from './repeat.js'

const TICK_MS = 25
const LOOKAHEAD = 0.1 // seconds

/**
 * getContext() -> { currentTime }; bpm(), swing(), rate() -> current values;
 * beatAt(ctxTime) -> loop beat, or null/undefined while the loop is stopped;
 * playHit(note, velocity, time); setTimer/clearTimer like setTimeout/clearTimeout.
 */
export function createRepeatEngine({
  getContext, bpm, swing = () => 0.5, rate, beatAt = null, playHit,
  setTimer = setTimeout, clearTimer = clearTimeout, nowMs = () => performance.now()
}) {
  const held = new Map() // note -> { vel, strikeMs, pressAt, from }
  let timer = null

  function tick() {
    timer = null
    if (!held.size) return
    const ctx = getContext()
    const now = ctx.currentTime
    const to = now + LOOKAHEAD
    const spb = 60 / bpm()
    const probe = beatAt?.(now)
    const gridded = probe != null
    for (const [note, h] of held) {
      let points
      if (gridded) {
        const b0 = beatAt(h.from), b1 = beatAt(to)
        points = repeatBeatsInWindow(b0, b1, { rate: rate(), swing: swing(), anchor: 0 })
          .map(b => h.from + (b - b0) * spb)
      } else {
        const toBeat = (to - h.pressAt) / spb
        const fromBeat = (h.from - h.pressAt) / spb
        points = repeatBeatsInWindow(fromBeat, toBeat, { rate: rate(), swing: swing(), anchor: 0 })
          .map(b => h.pressAt + b * spb)
      }
      for (const t of points) if (t > h.pressAt) playHit(note, h.vel, t)
      h.from = to
    }
    timer = setTimer(tick, TICK_MS)
  }

  const arm = () => { if (timer === null) timer = setTimer(tick, TICK_MS) }

  return {
    press(note, vel) {
      const at = getContext().currentTime
      held.set(note, { vel, strikeMs: nowMs(), pressAt: at, from: at })
      arm()
    },
    release(note) {
      held.delete(note)
      if (!held.size && timer !== null) { clearTimer(timer); timer = null }
    },
    /** Channel pressure: re-velocity every held pad (burst-gated after the strike). */
    pressure(value, tMs = nowMs()) {
      for (const h of held.values()) {
        h.vel = pressureVelocity(value, { sinceStrikeMs: tMs - h.strikeMs, strikeVelocity: h.vel })
      }
    },
    stop() {
      held.clear()
      if (timer !== null) { clearTimer(timer); timer = null }
    },
    isHeld: note => held.has(note)
  }
}
