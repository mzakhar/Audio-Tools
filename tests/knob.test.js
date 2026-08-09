import { describe, expect, it } from 'vitest'
import { knobAngle } from '../src/renderer/js/components/knob.js'

describe('knobAngle', () => {
  it('sweeps 270 degrees centred on twelve o clock', () => {
    expect(knobAngle(0, 0, 10)).toBe(-135)
    expect(knobAngle(5, 0, 10)).toBe(0)
    expect(knobAngle(10, 0, 10)).toBe(135)
  })

  it('clamps outside the range instead of overspinning', () => {
    expect(knobAngle(-4, 0, 10)).toBe(-135)
    expect(knobAngle(99, 0, 10)).toBe(135)
  })

  it('handles a bipolar range and a degenerate one', () => {
    expect(knobAngle(0, -2, 2)).toBe(0)
    expect(knobAngle(-2, -2, 2)).toBe(-135)
    expect(knobAngle(1, 5, 5)).toBe(-135) // max === min: park it, never divide by zero
  })
})
