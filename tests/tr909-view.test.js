import { describe, it, expect, vi } from 'vitest'
vi.mock('../src/renderer/js/audio-engine.js', () => ({
  default: { init: vi.fn(), getContext: () => null, getMasterInput: () => null }
}))
import { Tr909View } from '../src/renderer/js/components/tr909-view.js'
import { INSTRUMENTS } from '../src/renderer/js/drums/tr909-kit.js'

function mount() {
  const root = document.createElement('div')
  const view = new Tr909View(root, { ensureAudio: async () => {} })
  view.showAllLanes = true
  view.render()
  return { root, view }
}

describe('909 editor layout', () => {
  it('stacks the drum grid bottom-up, BD on the bottom row', () => {
    const { root, view } = mount()
    const labels = [...root.querySelectorAll('.tr909-all-lanes .tr909-grid-label')].map(el => el.textContent)
    expect(labels).toEqual([...INSTRUMENTS].reverse().map(i => i.label))
    expect(labels.at(-1)).toBe('BD')
    view.destroy()
  })

  it('puts accent and flam below the grid', () => {
    const { root, view } = mount()
    const editor = root.querySelector('.tr909-editor')
    const order = [...editor.children].map(el => el.className)
    expect(order.findIndex(c => c.includes('tr909-sub-lanes')))
      .toBeGreaterThan(order.findIndex(c => c.includes('tr909-all-lanes')))
    view.destroy()
  })

  // The three lane kinds used to carry different label gutters and gaps, so a
  // given step sat at a different x in each. They must share one row template.
  it('renders every lane with the same row template', () => {
    const { root, view } = mount()
    const lanes = [...root.querySelectorAll('.tr909-steps, .tr909-grid-steps, .tr909-mini-steps')]
    expect(lanes.length).toBe(INSTRUMENTS.length + 3) // selected lane + grid + accent + flam
    for (const lane of lanes) {
      expect(lane.children.length).toBe(16)
      expect(lane.parentElement.classList.contains('tr909-lane-row')).toBe(true)
      expect(lane.parentElement.children.length).toBe(2) // label gutter + steps
    }
    view.destroy()
  })
})
