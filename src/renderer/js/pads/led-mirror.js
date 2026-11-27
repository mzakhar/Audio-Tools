// led-mirror.js — shell: every 125 ms, diff the pad LED pattern frame against
// what the device last acknowledged and let the link send at most 8 SysEx writes
// (a pad is up to 8 writes, one per bank record). Fast blink is capped at 4 pads.
// Pure parts: led-patterns.js. Writes go to working memory only; the save
// command is never built (see smc-pad-link.js). User-preset mode only.

import { ledFrame, ledDiff } from './led-patterns.js'

const TICK_MS = 125
const MAX_WRITES = 8 // SysEx writes per tick: 64/s
const MAX_FAST = 4   // pads at the 4 Hz blink; more blink at 1 Hz

/**
 * link: { paint(colours16, maxWrites) -> Promise<pad[] acknowledged | false>, isUserMode() }
 * colours() -> 16 rgb|null (null array = no kit, mirror idle); patterns() -> 16 padPattern inputs.
 */
export function createLedMirror({ link, colours, patterns, now = () => Date.now(), setTimer = setInterval, clearTimer = clearInterval }) {
  let prev = null
  let busy = false
  let timer = null

  const frameNow = () => {
    const c = colours()
    return c ? ledFrame(patterns(), c, now(), MAX_FAST) : null
  }

  async function tick() {
    if (busy || !link.isUserMode()) return
    const frame = frameNow()
    if (!frame) return
    const diff = ledDiff(prev, frame)
    if (!diff.length) return
    busy = true
    try {
      const write = Array(16).fill(null)
      for (const { pad, rgb } of diff) write[pad] = rgb
      // prev advances only for pads the device acknowledged; the rest are found again next tick.
      const acked = await link.paint(write, MAX_WRITES)
      if (Array.isArray(acked) && acked.length) {
        prev = prev ? [...prev] : Array(16).fill(null)
        for (const pad of acked) prev[pad] = write[pad]
      }
    } finally { busy = false }
  }

  return {
    start() { if (timer === null) timer = setTimer(tick, TICK_MS) },
    stop() { if (timer !== null) { clearTimer(timer); timer = null } },
    /** Colours for link.refresh(): what the mirror shows now, recorded as sent so the next tick does not repeat it. */
    snapshot() {
      const frame = frameNow()
      if (frame) prev = frame
      return frame
    },
    tick
  }
}
