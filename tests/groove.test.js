import { describe, it, expect } from 'vitest'
import { GROOVE_STEPS, SNAP_GRIDS, snapGroove, swingOffset, gridPoint, snap } from '../src/renderer/js/pads/groove.js'

describe('snapGroove', () => {
  it('clamps and snaps to steps', () => {
    expect(snapGroove(0.1)).toBe(0.5)
    expect(snapGroove(0.9)).toBe(0.75)
    expect(snapGroove(0.67)).toBe(0.66)
    expect(GROOVE_STEPS).toContain(snapGroove(0.6))
  })
  it('fine rounds to 0.01', () => {
    expect(snapGroove(0.6149, true)).toBe(0.61)
    expect(snapGroove(0.3, true)).toBe(0.5)
  })
})

describe('swingOffset', () => {
  it('even points never move; odd shift by (swing-0.5)*eighth', () => {
    expect(swingOffset(0, 0.66)).toBe(0)
    expect(swingOffset(2, 0.66)).toBe(0)
    expect(swingOffset(1, 0.66)).toBeCloseTo(0.08, 9)
    expect(swingOffset(1, 0.5)).toBe(0)
    expect(swingOffset(-1, 0.66)).toBeCloseTo(0.08, 9)
  })
  it('second 16th lands at 0.33 at 66%', () => {
    expect(0.25 + swingOffset(1, 0.66)).toBeCloseTo(0.33, 9)
  })
})

describe('gridPoint', () => {
  it('straight grid', () => {
    expect(gridPoint(0.3)).toBe(0.25)
    expect(gridPoint(0.4)).toBe(0.5)
  })
  it('swung grid moves odd points later', () => {
    expect(gridPoint(0.3, 0.25, 0.66)).toBe(0.33)
    expect(gridPoint(0.5, 0.25, 0.66)).toBe(0.5)
    expect(gridPoint(0.2, 0.25, 0.66)).toBe(0.33)
  })
  it('triplet grid', () => {
    expect(gridPoint(0.35, SNAP_GRIDS['1/8T'])).toBeCloseTo(1 / 3, 9)
    expect(gridPoint(0.6, SNAP_GRIDS['1/8T'])).toBeCloseTo(2 / 3, 9)
  })
})

describe('snap', () => {
  it('strength 0 / 0.5 / 1', () => {
    expect(snap(0.3, { strength: 0 })).toBe(0.3)
    expect(snap(0.3, { strength: 0.5 })).toBe(0.275)
    expect(snap(0.3, { strength: 1 })).toBe(0.25)
  })
  it('no float drift', () => {
    expect(snap(0.1 + 0.2, { strength: 1, grid: 0.25 })).toBe(0.25)
    expect(snap(0.3, { grid: 0.25, swing: 0.66 })).toBe(0.33)
  })
  it('snaps to loop end value (wrap is loop-record job)', () => {
    expect(snap(7.95, { grid: 0.25 })).toBe(8)
  })
})
