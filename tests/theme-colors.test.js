import { describe, it, expect, vi } from 'vitest'
import { readThemeColors, onThemeChange } from '../src/renderer/js/ui/theme-colors.js'

describe('readThemeColors', () => {
  it('reads and trims each token from a style object', () => {
    const style = { getPropertyValue: name => ({ '--canvas-bg': ' #111 ', '--canvas-playhead': '#f60' })[name] ?? '' }
    expect(readThemeColors(['canvas-bg', 'canvas-playhead', 'missing'], style))
      .toEqual({ 'canvas-bg': '#111', 'canvas-playhead': '#f60', missing: '' })
  })

  it('onThemeChange subscribes and unsubscribes', () => {
    const fn = vi.fn()
    const off = onThemeChange(fn)
    window.dispatchEvent(new CustomEvent('themechange'))
    off()
    window.dispatchEvent(new CustomEvent('themechange'))
    expect(fn).toHaveBeenCalledTimes(1)
  })
})
