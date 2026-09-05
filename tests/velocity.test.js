import { describe, it, expect } from 'vitest'
import { velocityGain } from '../src/renderer/js/utils/velocity.js'

describe('velocityGain', () => {
  it('velocity 0 is silent', () => {
    expect(velocityGain(0)).toBe(0)
  })
  it('max velocity is full gain', () => {
    expect(velocityGain(127)).toBeCloseTo(1, 10)
  })
  it('a soft hit sits above the linear floor', () => {
    expect(velocityGain(45)).toBeGreaterThan(45 / 127)
  })
  it('clamps out-of-range velocity into 0-127', () => {
    expect(velocityGain(200)).toBe(velocityGain(127))
    expect(velocityGain(-10)).toBe(0)
  })
  it('non-finite input treats value as 0', () => {
    expect(velocityGain(NaN)).toBe(0)
    expect(velocityGain(undefined)).toBe(0)
  })
  it('is monotonically increasing with velocity', () => {
    let prev = -1
    for (const v of [0, 20, 45, 64, 90, 110, 127]) {
      const g = velocityGain(v)
      expect(g).toBeGreaterThan(prev)
      prev = g
    }
  })
})
