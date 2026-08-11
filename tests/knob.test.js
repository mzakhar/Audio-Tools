import { describe, expect, it } from 'vitest'
import { knobAngle, decimalsFor, snap, renderKnob } from '../src/renderer/js/components/knob.js'

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

describe('value rounding', () => {
  it('reads the precision off the step', () => {
    expect([1, 0.1, 0.01, 0.001].map(decimalsFor)).toEqual([0, 1, 2, 3])
    expect(decimalsFor(undefined)).toBe(0)
    expect(decimalsFor(0.000001)).toBe(3)   // capped: no knob needs more
  })

  it('kills the float noise that step arithmetic produces', () => {
    // 0.1 * 3 and 0.29 + 0.01 are the two that showed up in the caption.
    expect(snap(0.30000000000000004, 0.01)).toBe(0.3)
    expect(snap(0.1 + 0.2, 0.1)).toBe(0.3)
    expect(snap(0.07 * 3, 0.01)).toBe(0.21)
    // toFixed rounds the stored double, and 2.675 is really 2.67499…, so this
    // lands on 2.67. Correct, and worth pinning so nobody "fixes" it.
    expect(snap(2.675, 0.01)).toBe(2.67)
  })

  it('drops trailing zeros rather than padding to the step', () => {
    expect(String(snap(0.5, 0.01))).toBe('0.5')
    expect(String(snap(3, 0.1))).toBe('3')
  })

  it('keeps precision a fine step actually needs', () => {
    expect(snap(0.05, 0.01)).toBe(0.05)   // not rounded away to 0.1
  })
})

describe('keyboard control', () => {
  const build = (over = {}) => {
    const param = { key: 'k', label: 'CUTOFF', min: 0, max: 1, step: 0.01, ...over }
    const input = document.createElement('input')
    Object.assign(input, { type: 'range', min: param.min, max: param.max, step: param.step, value: 0.5 })
    const el = renderKnob(param, input)
    document.body.append(el)
    return { el, input, cap: el.querySelector('.knob-cap') }
  }

  it('shows the reading while focused and the label when not', () => {
    const { input, cap } = build()
    expect(cap.textContent).toBe('CUTOFF')
    input.focus()
    expect(cap.textContent).toBe('0.5')
    input.blur()
    expect(cap.textContent).toBe('CUTOFF')
  })

  // The arrow keys are the native range input's own behaviour — the knob only
  // has to keep the dial in step with the value they change.
  it('repaints the dial when the value changes under it', () => {
    const { el, input } = build()
    const dial = el.querySelector('.knob-dial')
    input.value = 1
    input.dispatchEvent(new Event('input', { bubbles: true }))
    expect(dial.style.getPropertyValue('--angle')).toBe('135deg')
  })

  it('takes focus when the dial is grabbed, so the arrow keys land on it', () => {
    const { el, input } = build()
    el.querySelector('.knob-dial').dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true }))
    expect(document.activeElement).toBe(input)
  })
})
