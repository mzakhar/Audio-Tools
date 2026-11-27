import { describe, it, expect } from 'vitest'
import { applyKnob, knobLabel, KNOB_ROLES } from '../src/renderer/js/pads/knob-roles.js'

const slot = { voice: 'bd', params: {} }
const ctx = { pads: { groove: 0.5, repeatRate: '1/16', snapStrength: 1 }, bpm: 120, slot, note: 36 }

describe('knob roles', () => {
  it('has 8 roles', () => expect(KNOB_ROLES).toHaveLength(8))
  it('groove steps through detents and clamps', () => {
    expect(applyKnob(0, 1, ctx)).toEqual([{ type: 'pads', patch: { groove: 0.54 } }])
    expect(applyKnob(0, -1, ctx)[0].patch.groove).toBe(0.5)
    expect(applyKnob(0, 99, ctx)[0].patch.groove).toBe(0.75)
  })
  it('repeat rate walks REPEAT_RATES order', () => {
    expect(applyKnob(1, 1, ctx)[0].patch.repeatRate).toBe('1/16T')
    expect(applyKnob(1, -1, ctx)[0].patch.repeatRate).toBe('1/8T')
  })
  it('snap strength steps 0.05, clamped', () => {
    expect(applyKnob(6, -1, ctx)[0].patch.snapStrength).toBe(0.95)
    expect(applyKnob(6, 1, ctx)[0].patch.snapStrength).toBe(1)
  })
  it('bpm clamps 40-240', () => {
    expect(applyKnob(7, 1, ctx)).toEqual([{ type: 'bpm', bpm: 121 }])
    expect(applyKnob(7, -999, ctx)[0].bpm).toBe(40)
  })
  it('slot roles emit slot effects, none without a slot', () => {
    expect(applyKnob(2, 1, ctx)).toEqual([{ type: 'slot', note: 36, params: { tuneSt: 1 } }])
    expect(applyKnob(2, 99, ctx)[0].params.tuneSt).toBe(24)
    expect(applyKnob(3, 1, ctx)[0].params.decayMul).toBe(1.05)
    expect(applyKnob(4, -1, ctx)[0].params.filterMul).toBeCloseTo(0.952, 3)
    expect(applyKnob(5, 1, ctx)[0].params.level).toBe(1.05)
    expect(applyKnob(2, 1, { ...ctx, slot: null })).toEqual([])
  })
  it('zero delta is a no-op', () => expect(applyKnob(0, 0, ctx)).toEqual([]))
  it('labels', () => {
    expect([0, 1, 2, 3, 6, 7].map(i => knobLabel(i, ctx))).toEqual(['50%', '1/16', '0 st', '100%', '100%', '120'])
    expect(knobLabel(2, { ...ctx, slot: { params: { tuneSt: 2 } } })).toBe('+2 st')
    expect(knobLabel(4, { ...ctx, slot: null })).toBe('—')
  })
})
