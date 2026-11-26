import { describe, it, expect } from 'vitest'
import { withAlpha, trackToken, ARRANGE_TOKENS, canvasFont } from '../src/renderer/js/components/canvas-colors.js'

describe('withAlpha', () => {
  it('parses #rrggbb and #rgb', () => {
    expect(withAlpha('#2f6fdb', 0.5)).toBe('rgba(47, 111, 219, 0.5)')
    expect(withAlpha('#f00', 1)).toBe('rgba(255, 0, 0, 1)')
  })
  it('multiplies existing alpha for #rrggbbaa and rgba()', () => {
    expect(withAlpha('#ff000080', 0.5)).toBe('rgba(255, 0, 0, 0.251)')
    expect(withAlpha('rgba(0, 0, 0, 0.5)', 0.5)).toBe('rgba(0, 0, 0, 0.25)')
  })
  it('passes through what it cannot parse', () => {
    expect(withAlpha('', 0.5)).toBe('')
    expect(withAlpha('rebeccapurple', 0.5)).toBe('rebeccapurple')
    expect(withAlpha(undefined, 0.5)).toBe('')
  })
})

describe('tokens', () => {
  it('trackToken cycles 1..8', () => {
    expect(trackToken(0)).toBe('track-1')
    expect(trackToken(7)).toBe('track-8')
    expect(trackToken(8)).toBe('track-1')
    expect(trackToken(-1)).toBe('track-8')
  })
  it('ARRANGE_TOKENS lists all track colours', () => {
    expect(ARRANGE_TOKENS).toContain('track-8')
    expect(ARRANGE_TOKENS).toContain('canvas-playhead')
  })
  it('canvasFont', () => {
    expect(canvasFont(10, 'Foo')).toBe('10px Foo')
    expect(canvasFont(10, '', '600')).toBe('600 10px sans-serif')
  })
})
