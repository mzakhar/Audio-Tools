import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import ProjectStore from '../src/renderer/js/store/ProjectStore.js'
import { PadsView } from '../src/renderer/js/components/pads-view.js'
import { KITS } from '../src/renderer/js/pads/kit.js'

let root, view, triggerPad
const mount = (extra = {}) => {
  root = document.createElement('div')
  document.body.append(root)
  triggerPad = vi.fn()
  view = new PadsView(root, { triggerPad, getKit: () => KITS['default-909'], getNotes: () => [], getBeat: () => null, ...extra })
}
const pad = n => root.querySelector(`.pads-pad[data-pad="${n}"]`)
const settings = () => ProjectStore.getState().pads

beforeEach(() => { ProjectStore.reset(); vi.useFakeTimers() })
afterEach(() => { view?.destroy(); root?.remove(); vi.useRealTimers() })

describe('pads view', () => {
  it('renders 16 pad twins, pad 1 bottom-left and 13-16 on top, labelled from the kit', () => {
    mount()
    const order = [...root.querySelectorAll('.pads-pad')].map(el => Number(el.dataset.pad) + 1)
    expect(order).toEqual([13, 14, 15, 16, 9, 10, 11, 12, 5, 6, 7, 8, 1, 2, 3, 4])
    expect(pad(0).querySelector('.pads-pad-name').textContent).toBe('BD')
    expect(pad(0).getAttribute('aria-label')).toBe('Pad 1 BD')
  })

  it('pointerdown triggers the right note at a velocity', () => {
    mount()
    pad(2).dispatchEvent(new Event('pointerdown', { bubbles: true, cancelable: true }))
    expect(triggerPad).toHaveBeenCalledWith(38, expect.any(Number))
  })

  it('settings controls dispatch SetPadsSettings', () => {
    mount()
    const change = (el, v) => {
      el.value = String(v)
      el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }))
    }
    change(root.querySelector('.pads-bars'), 4)
    change(root.querySelector('.pads-countin'), 2)
    change(root.querySelector('.pads-groove'), 57)
    change(root.querySelector('.pads-snap'), '1/8')
    change(root.querySelector('.pads-strength'), 50)
    root.querySelector('.pads-metro').click()
    expect(settings()).toMatchObject({ loopBars: 4, countInBars: 2, groove: 0.58, snapGrid: 0.5, snapStrength: 0.5, metronome: false })
    expect(root.querySelector('.pads-groove-out').textContent).toBe('58%')
  })

  it('Layer toggles aria-pressed and reports; Undo calls back', () => {
    const onLayerChange = vi.fn(), onUndo = vi.fn()
    mount({ onLayerChange, onUndo })
    const layer = root.querySelector('.pads-layer')
    layer.click()
    expect(layer.getAttribute('aria-pressed')).toBe('true')
    expect(view.layerOn()).toBe(true)
    expect(onLayerChange).toHaveBeenCalledWith(true)
    root.querySelector('.pads-undo').click()
    expect(onUndo).toHaveBeenCalled()
  })

  it('Wipe is hold-to-use (pointer and keyboard) and remembers touched pads', () => {
    mount()
    const wipe = root.querySelector('.pads-wipe')
    wipe.dispatchEvent(new Event('pointerdown'))
    expect(view.isWiping()).toBe(true)
    expect(view.wipePitches()).toBeNull()
    view.flashPad(38, 100)
    expect([...view.wipePitches()]).toEqual([38])
    wipe.dispatchEvent(new Event('pointerup'))
    expect(view.isWiping()).toBe(false)
    expect(view.wipePitches()).toBeNull()
    wipe.dispatchEvent(new KeyboardEvent('keydown', { key: ' ' }))
    expect(view.isWiping()).toBe(true)
    wipe.dispatchEvent(new KeyboardEvent('keyup', { key: ' ' }))
    expect(view.isWiping()).toBe(false)
  })

  it('flashPad sets velocity-scaled state that clears', () => {
    mount()
    view.flashPad(36, 127)
    expect(pad(0).style.getPropertyValue('--flash')).toBe('1')
    expect(pad(0).dataset.flash).toBe('on')
    vi.advanceTimersByTime(200)
    expect(pad(0).dataset.flash).toBeUndefined()
    expect(pad(0).style.getPropertyValue('--flash')).toBe('0')
  })

  it('destroy empties the container and unsubscribes from the store', () => {
    mount()
    view.destroy()
    expect(root.innerHTML).toBe('')
    // would throw on the emptied DOM if the subscription were still live
    expect(() => ProjectStore.dispatch({ label: 'x', execute: s => s, undo: s => s })).not.toThrow()
  })
})
