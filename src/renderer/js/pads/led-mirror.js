// led-mirror.js — shell: every 125 ms, diff the pad LED pattern frame against
// what the device last acknowledged and send at most 4 pad colour writes.
// Pure parts: led-patterns.js. Writes go to working memory only; the save
// command is never built (see smc-pad-link.js). User-preset mode only.

import { ledFrame, ledDiff, budget } from './led-patterns.js'

const TICK_MS = 125
const MAX_WRITES = 4 // pads per tick: 32 pad writes/s

/**
 * link: { paint(colours16) -> Promise<bool>, isUserMode() }
 * colours() -> 16 rgb|null (null array = no kit, mirror idle); patterns() -> 16 padPattern inputs.
 */
export function createLedMirror({ link, colours, patterns, now = () => Date.now(), setTimer = setInterval, clearTimer = clearInterval }) {
  let prev = null
  let offset = 0
  let busy = false
  let timer = null

  const frameNow = () => {
    const c = colours()
    return c ? ledFrame(patterns(), c, now()) : null
  }

  async function tick() {
    if (busy || !link.isUserMode()) return
    const frame = frameNow()
    if (!frame) return
    const sent = budget(ledDiff(prev, frame), MAX_WRITES, offset)
    if (!sent.length) return
    busy = true
    try {
      const write = Array(16).fill(null)
      for (const { pad, rgb } of sent) write[pad] = rgb
      if (await link.paint(write)) {
        prev = prev ? [...prev] : Array(16).fill(null)
        for (const { pad, rgb } of sent) prev[pad] = rgb
        offset += sent.length
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
