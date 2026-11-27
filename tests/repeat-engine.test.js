import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRepeatEngine } from '../src/renderer/js/pads/repeat-engine.js'

describe('repeat engine', () => {
  const ctx = { currentTime: 0 }
  let hits
  beforeEach(() => { vi.useFakeTimers(); ctx.currentTime = 0; hits = [] })
  afterEach(() => vi.useRealTimers())
  const advance = ms => { for (let t = 0; t < ms; t += 25) { vi.advanceTimersByTime(25); ctx.currentTime += 0.025 } }
  const make = (extra = {}) => createRepeatEngine({
    getContext: () => ctx, bpm: () => 120, rate: () => 0.25, swing: () => 0.5,
    playHit: (n, v, t) => hits.push({ n, v, t }), ...extra
  })

  it('free-running: retriggers every rate from the press, not at the press', () => {
    const e = make()
    e.press(36, 100)
    advance(1100)
    const times = hits.map(h => h.t)
    expect(times[0]).toBeCloseTo(0.125, 5) // 0.25 beat at 120 bpm
    expect(times[1]).toBeCloseTo(0.25, 5)
    expect(hits.every(h => h.n === 36 && h.v === 100)).toBe(true)
    e.stop()
  })

  it('release stops the timer', () => {
    const e = make()
    e.press(36, 100)
    advance(300)
    e.release(36)
    const n = hits.length
    advance(500)
    expect(hits.length).toBe(n)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('gridded: lands on the loop beat grid', () => {
    ctx.currentTime = 0.1
    const e = make({ beatAt: t => t * 2 }) // 120 bpm
    e.press(38, 90)
    advance(500)
    expect(hits.length).toBeGreaterThan(0)
    for (const h of hits) expect((h.t * 2 / 0.25) % 1).toBeCloseTo(0, 5)
    e.stop()
  })

  it('pressure after the burst gate changes velocity; inside it does not', () => {
    const e = make({ nowMs: () => 1000 })
    e.press(36, 100)
    e.pressure(0, 1010)
    advance(150)
    expect(hits[0].v).toBe(100)
    e.pressure(0, 1100)
    advance(300)
    expect(hits.at(-1).v).toBe(30)
    e.stop()
  })
})
