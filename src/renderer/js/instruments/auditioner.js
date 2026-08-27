// auditioner.js — the one place a sound is previewed. At most one instrument
// is alive at a time and it is built by the same factory that plays for real,
// so an audition can never sound different from the assignment.

import { instrumentFor } from '../midi/live-instrument.js'

export function createAuditioner({ ensureAudio, buildDeps, holdMs = 1400 }) {
  let live = null
  let token = null
  let timer = null
  let pitch = 60

  function stop() {
    if (timer) { clearTimeout(timer); timer = null }
    token = null
    if (live) {
      try { live.noteOff(pitch) } catch (err) {}
      try { live.dispose() } catch (err) {}
    }
    live = null
  }

  async function play(instrument, options = {}) {
    stop()
    const mine = token = {}
    pitch = options.pitch ?? 60
    const velocity = options.velocity ?? 100
    await ensureAudio()
    const inst = instrumentFor(instrument, buildDeps())
    if (!inst) return false
    if (token !== mine) { try { inst.dispose() } catch (err) {} ; return false }
    live = inst
    try { await inst.preload?.(pitch, velocity) } catch (err) {}
    // ponytail: sample-store has no cancellation — a superseded decode still
    // completes and warms the cache. Only the voice is suppressed.
    if (token !== mine) return false
    inst.noteOn(pitch, velocity)
    timer = setTimeout(stop, holdMs)
    return true
  }

  return { play, stop }
}
