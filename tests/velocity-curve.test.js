import { describe, it, expect } from 'vitest'
import { applyVelocityCurve, curveForDevice } from '../src/renderer/js/pads/velocity-curve.js'

describe('applyVelocityCurve', () => {
  it('is the identity for default config', () => {
    for (const v of [1, 2, 64, 100, 127]) expect(applyVelocityCurve(v)).toBe(v)
  })

  it('drops zero and below-threshold hits', () => {
    expect(applyVelocityCurve(0)).toBe(0)
    expect(applyVelocityCurve(9, { threshold: 10 })).toBe(0)
    expect(applyVelocityCurve(10, { threshold: 10 })).toBeGreaterThan(0)
  })

  it('full sends 127 for any accepted hit', () => {
    expect(applyVelocityCurve(12, { full: true, threshold: 10 })).toBe(127)
    expect(applyVelocityCurve(9, { full: true, threshold: 10 })).toBe(0)
  })

  it('shapes: soft raises, hard lowers, compress lifts the floor', () => {
    expect(applyVelocityCurve(64, { curve: 'soft' })).toBeGreaterThan(64)
    expect(applyVelocityCurve(64, { curve: 'hard' })).toBeLessThan(64)
    expect(applyVelocityCurve(10, { curve: 'compress' })).toBeGreaterThan(60)
  })

  it('inMax rescales and clamps, always >= 1 for an accepted hit', () => {
    expect(applyVelocityCurve(110, { inMax: 110 })).toBe(127)
    expect(applyVelocityCurve(127, { inMax: 110 })).toBe(127)
    expect(applyVelocityCurve(1, { curve: 'hard' })).toBeGreaterThanOrEqual(1)
  })
})

describe('curveForDevice', () => {
  it('stretches the SMC-PAD top end, case-insensitively', () => {
    expect(applyVelocityCurve(109, curveForDevice('M-Vave smc-pad'))).toBeGreaterThanOrEqual(125)
  })

  it('leaves other devices alone', () => {
    expect(applyVelocityCurve(90, curveForDevice('Keystation'))).toBe(90)
    expect(applyVelocityCurve(90, curveForDevice(undefined))).toBe(90)
  })
})
