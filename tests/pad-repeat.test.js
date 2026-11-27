import { describe, it, expect } from 'vitest'
import { REPEAT_RATES, repeatBeatsInWindow, pressureVelocity, ladderHit } from '../src/renderer/js/pads/repeat.js'

describe('repeatBeatsInWindow', () => {
  it('straight 1/8 from anchor', () => {
    expect(repeatBeatsInWindow(0, 2, { rate: 0.5 })).toEqual([0, 0.5, 1, 1.5])
  })
  it('swing delays odd points', () => {
    expect(repeatBeatsInWindow(0, 1, { rate: 0.5, swing: 0.75 })).toEqual([0, 0.75])
  })
  it('swung point pushed past window edge lands in the next window', () => {
    expect(repeatBeatsInWindow(0.5, 1, { rate: 0.5, swing: 0.75 })).toEqual([0.75])
    expect(repeatBeatsInWindow(0.5, 0.7, { rate: 0.5, swing: 0.75 })).toEqual([])
  })
  it('anchor offsets and nothing before anchor', () => {
    expect(repeatBeatsInWindow(0, 2, { rate: 1, anchor: 0.5 })).toEqual([0.5, 1.5])
  })
  it('triplet', () => {
    const r = repeatBeatsInWindow(0, 1, { rate: REPEAT_RATES['1/8T'] })
    expect(r.length).toBe(3)
    expect(r[1]).toBeCloseTo(1 / 3, 6)
  })
  it('half-open window', () => {
    expect(repeatBeatsInWindow(0.5, 1, { rate: 0.5 })).toEqual([0.5])
  })
})

describe('pressureVelocity', () => {
  it('gate and null keep strike velocity', () => {
    expect(pressureVelocity(100, { sinceStrikeMs: 10, strikeVelocity: 80 })).toBe(80)
    expect(pressureVelocity(null, { sinceStrikeMs: 500, strikeVelocity: 80 })).toBe(80)
  })
  it('scales 30..127', () => {
    expect(pressureVelocity(0, { sinceStrikeMs: 100, strikeVelocity: 80 })).toBe(30)
    expect(pressureVelocity(127, { sinceStrikeMs: 100, strikeVelocity: 80 })).toBe(127)
    expect(pressureVelocity(500, { sinceStrikeMs: 100, strikeVelocity: 80 })).toBe(127)
  })
})

describe('ladderHit', () => {
  const src = { note: 40, velocity: 100 }
  it('velocity', () => {
    expect(ladderHit(src, 0, 'velocity').velocity).toBe(8)
    expect(ladderHit(src, 15, 'velocity').velocity).toBe(127)
    expect(ladderHit(src, 8, 'velocity').velocity).toBe(Math.round(8 + 8 * (119 / 15)))
  })
  it('tune', () => {
    expect([0, 8, 15].map((s) => ladderHit(src, s, 'tune').params.tune)).toEqual([-8, 0, 7])
    expect(ladderHit(src, 0, 'tune').velocity).toBe(100)
  })
  it('decay', () => {
    expect(ladderHit(src, 0, 'decay').params.decayMul).toBeCloseTo(0.25)
    expect(ladderHit(src, 15, 'decay').params.decayMul).toBeCloseTo(2)
    expect(ladderHit(src, 8, 'decay').velocity).toBe(100)
  })
  it('filter', () => {
    expect(ladderHit(src, 0, 'filter').params.filterMul).toBeCloseTo(0.2)
    expect(ladderHit(src, 15, 'filter').params.filterMul).toBeCloseTo(1)
    expect(ladderHit(src, 8, 'filter').note).toBe(40)
  })
})
