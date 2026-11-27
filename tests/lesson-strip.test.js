import { describe, it, expect } from 'vitest'
import { ghostRects, markRects, biasPos, biasText } from '../src/renderer/js/pads/lesson-strip.js'

const geo = { loopBeats: 8, w: 800, h: 176 } // rowH = 10

describe('lesson-strip', () => {
  it('ghostRects uses drawStrip beat/row math', () => {
    const [r] = ghostRects([{ pad: 2, beat: 4 }], geo)
    expect(r).toEqual({ x: 400, y: 176 - 3 * 10 + 1, w: 3, h: 8, pad: 2 })
  })
  it('ghostRects drops pads outside bank A', () => {
    expect(ghostRects([{ pad: 16, beat: 0 }, { pad: -1, beat: 0 }], geo)).toEqual([])
    expect(ghostRects(null, geo)).toEqual([])
  })
  it('markRects wraps absolute beats and centres', () => {
    const [r] = markRects([{ pad: 0, beat: 10, mark: 'good' }], geo)
    expect(r).toMatchObject({ x: 200 - 2, y: 167, w: 5, mark: 'good' })
  })
  it('biasPos clamps', () => {
    expect(biasPos(0)).toBe(0.5)
    expect(biasPos(-500)).toBe(0)
    expect(biasPos(500)).toBe(1)
    expect(biasPos(45)).toBe(0.75)
  })
  it('biasText', () => {
    expect(biasText(12.4)).toBe('+12 ms late')
    expect(biasText(-8)).toBe('-8 ms early')
    expect(biasText(2.9)).toBe('on time')
    expect(biasText(-2)).toBe('on time')
  })
})
