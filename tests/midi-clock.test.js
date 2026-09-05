import { describe, it, expect } from 'vitest'
import { audioTimeFor } from '../src/renderer/js/utils/midi-clock.js'

describe('audioTimeFor', () => {
  it('a stamp equal to now lands slack ahead of ctxTime', () => {
    expect(audioTimeFor(1000, 1000, 5)).toBeCloseTo(5.006, 10)
  })
  it('a stamp slightly before now still lands earlier if slack absorbs it', () => {
    expect(audioTimeFor(1000, 1004, 5)).toBeCloseTo(5.002, 10)
  })
  it('a stamp before now by more than slack clamps to ctxTime', () => {
    expect(audioTimeFor(1000, 1010, 5)).toBe(5)
  })
  it('never schedules before ctxTime even with a large negative offset', () => {
    expect(audioTimeFor(1000, 5000, 5)).toBe(5)
  })
  it('a stamp after now lands later', () => {
    expect(audioTimeFor(1020, 1000, 5)).toBeCloseTo(5.026, 10)
  })
  it('falls back to ctxTime + slack for non-finite input', () => {
    expect(audioTimeFor(NaN, 1000, 5)).toBeCloseTo(5.006, 10)
    expect(audioTimeFor(1000, NaN, 5)).toBeCloseTo(5.006, 10)
  })
  it('respects a custom slack', () => {
    expect(audioTimeFor(1000, 1000, 5, 0.01)).toBeCloseTo(5.01, 10)
  })
})
