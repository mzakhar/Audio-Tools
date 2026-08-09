import { describe, expect, it, vi } from 'vitest'
import { renderPanel } from '../src/renderer/js/components/rack-panel.js'
import { ModuleBrowser } from '../src/renderer/js/components/module-browser.js'

describe('rack panel', () => {
  it('renders registry controls and labelled jacks', () => {
    const panel = renderPanel({ id: 'v1', type: 'vco', params: {} })
    expect(panel.querySelector('[aria-label="VCO V/OCT input"]')).toBeTruthy()
    expect(panel.querySelectorAll('input, select').length).toBeGreaterThan(0)
  })

  it('sends selected module from browser and hides unavailable worklets', () => {
    const root = document.createElement('div'), pick = vi.fn()
    new ModuleBrowser(root, { hasWorklet: () => false, onPick: pick })
    root.querySelector('button').click()
    expect(pick).toHaveBeenCalled()
    expect(root.textContent).not.toContain('FOLD')
  })
})
