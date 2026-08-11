import { describe, expect, it, vi } from 'vitest'
import { applyTheme, savedTheme } from '../src/renderer/js/theme.js'

describe('theme', () => {
  it('applies and persists valid themes', () => {
    const root = document.documentElement
    const changed = vi.fn()
    window.addEventListener('themechange', changed, { once: true })

    expect(applyTheme('light')).toBe('light')
    expect(root.dataset.theme).toBe('light')
    expect(savedTheme()).toBe('light')
    expect(changed).toHaveBeenCalledWith(expect.objectContaining({ detail: { theme: 'light' } }))
  })

  it('falls back to dark for unknown themes', () => {
    expect(applyTheme('neon')).toBe('dark')
    expect(savedTheme()).toBe('dark')
  })

  it('restores a saved light theme', () => {
    localStorage.setItem('synth_theme', 'light')
    expect(savedTheme()).toBe('light')
    expect(applyTheme(savedTheme())).toBe('light')
    expect(document.documentElement.dataset.theme).toBe('light')
  })

  it('applies and restores the rainbow theme', () => {
    localStorage.setItem('synth_theme', 'rainbow')
    expect(savedTheme()).toBe('rainbow')
    expect(applyTheme(savedTheme())).toBe('rainbow')
    expect(document.documentElement.dataset.theme).toBe('rainbow')
  })
})
