import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import ProjectStore, { SetPadsSettings } from '../src/renderer/js/store/ProjectStore.js'
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
      if (el.type === 'range') el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
    }
    change(root.querySelector('.pads-bars'), 4)
    change(root.querySelector('.pads-countin'), 2)
    change(root.querySelector('.pads-snap'), '1/8')
    root.querySelector('.pads-metro').click()
    expect(settings()).toMatchObject({ loopBars: 4, countInBars: 2, snapGrid: 0.5, metronome: false })
    expect(root.querySelector('.pads-groove')).toBeNull()   // the knob twins replace the phase-2 sliders
    expect(root.querySelector('.pads-strength')).toBeNull()
    expect(root.querySelector('.pads-perf .pads-snap')).not.toBeNull()
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

  it('Enter/Space on a focused pad triggers it and does not reach the global handler', () => {
    mount()
    const seen = vi.fn()
    document.addEventListener('keydown', seen)
    for (const key of ['Enter', ' ']) {
      const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
      pad(1).dispatchEvent(e)
      expect(e.defaultPrevented).toBe(true)
    }
    document.removeEventListener('keydown', seen)
    expect(seen).not.toHaveBeenCalled()
    expect(triggerPad).toHaveBeenCalledTimes(2)
    expect(triggerPad).toHaveBeenCalledWith(37, 100)
  })

  it('Undo button disabled state follows canUndo', () => {
    let can = false
    mount({ canUndo: () => can })
    const undo = root.querySelector('.pads-undo')
    expect(undo.disabled).toBe(true)
    can = true
    ProjectStore.reset()
    expect(undo.disabled).toBe(false)
  })

  it('knob twins: drag, wheel and arrows call onKnob; turnKnob pulses', () => {
    const onKnob = vi.fn()
    mount({ onKnob })
    expect(root.querySelectorAll('.pads-knob')).toHaveLength(8)
    const k = root.querySelector('.pads-knob[data-knob="2"]')
    k.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp' }))
    k.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }))
    k.dispatchEvent(new WheelEvent('wheel', { deltaY: -10, cancelable: true }))
    expect(onKnob.mock.calls).toEqual([[2, 1], [2, -1], [2, 1]])
    const down = new Event('pointerdown'); down.clientY = 100
    const move = new Event('pointermove'); move.clientY = 84
    k.dispatchEvent(down); k.dispatchEvent(move)
    expect(onKnob).toHaveBeenLastCalledWith(2, 2)
    view.turnKnob(2)
    expect(k.dataset.pulse).toBe('on')
    vi.advanceTimersByTime(200)
    expect(k.dataset.pulse).toBeUndefined()
  })

  it('knob readouts follow settings and bpm', () => {
    mount({ getBpm: () => 133 })
    const out = i => root.querySelector(`.pads-knob[data-knob="${i}"] .pads-knob-out`).textContent
    expect([out(0), out(1), out(7), out(2)]).toEqual(['50%', '1/16', '133', '0 st'])
    ProjectStore.dispatch(SetPadsSettings({ groove: 0.62, repeatRate: '1/8' }))
    expect([out(0), out(1)]).toEqual(['62%', '1/8'])
  })

  it('bank tabs relabel pads and emit banked notes; flashPad in another bank switches', () => {
    mount({ getKit: () => ({ slots: { 52: { voice: 'sd', params: {} } } }) })
    expect(pad(0).querySelector('.pads-pad-name').textContent).toBe('\u2014')
    expect(pad(0).hasAttribute('data-empty')).toBe(true)
    root.querySelectorAll('.pads-bank')[1].click()
    expect(pad(0).querySelector('.pads-pad-name').textContent).toBe('SD')
    pad(1).dispatchEvent(new Event('pointerdown', { cancelable: true }))
    expect(triggerPad).toHaveBeenCalledWith(53, expect.any(Number))
    view.flashPad(36 + 48, 100)
    expect(root.querySelectorAll('.pads-bank')[3].getAttribute('aria-pressed')).toBe('true')
    expect(view.selectedNote()).toBe(84)
  })

  it('Full, Ladder and rate controls dispatch settings', () => {
    mount()
    root.querySelector('.pads-full').click()
    const ladder = root.querySelector('.pads-ladder')
    ladder.value = 'decay'; ladder.dispatchEvent(new Event('change', { bubbles: true }))
    const rate = root.querySelector('.pads-rate')
    rate.value = '1/8T'; rate.dispatchEvent(new Event('change', { bubbles: true }))
    expect(settings()).toMatchObject({ full: true, ladder: 'decay', repeatRate: '1/8T' })
    ladder.value = ''; ladder.dispatchEvent(new Event('change', { bubbles: true }))
    expect(settings().ladder).toBeNull()
  })

  it('Repeat and Overlay are hold buttons reporting onAction; Learn reports', () => {
    const onAction = vi.fn()
    mount({ onAction })
    for (const [cls, action] of [['.pads-repeat', 'repeat'], ['.pads-overlay', 'overlay']]) {
      const b = root.querySelector(cls)
      b.dispatchEvent(new Event('pointerdown')); b.dispatchEvent(new Event('pointerup'))
      expect(onAction).toHaveBeenCalledWith(action, { pressed: true })
      expect(onAction).toHaveBeenCalledWith(action, { pressed: false })
    }
    root.querySelector('.pads-learn').click()
    expect(onAction).toHaveBeenCalledWith('learn', {})
  })

  it('overlay: pads become a menu and do not sound (MUTE, BANK, RATE, LADDER)', () => {
    mount()
    view.setActive(true)
    const over = held => root.querySelector('.pads-overlay').dispatchEvent(new Event(held ? 'pointerdown' : 'pointerup'))
    const menu = root.querySelector('.pads-overlay-menu')
    const pick = n => pad(n).dispatchEvent(new Event('pointerdown', { cancelable: true }))
    over(true)
    pick(2); pick(2) // mute then unmute note 38
    pick(3)
    expect(settings().muted).toEqual([39])
    expect(pad(3).hasAttribute('data-muted')).toBe(true)
    menu.value = 'BANK'; menu.dispatchEvent(new Event('change'))
    expect(pad(1).querySelector('.pads-pad-name').textContent).toBe('B')
    pick(2)
    expect(root.querySelectorAll('.pads-bank')[2].getAttribute('aria-pressed')).toBe('true')
    menu.value = 'RATE'; menu.dispatchEvent(new Event('change'))
    pick(2)
    expect(settings().repeatRate).toBe('1/8T')
    menu.value = 'LADDER'; menu.dispatchEvent(new Event('change'))
    pick(1)
    expect(settings().ladder).toBe('tune')
    pick(1)
    expect(settings().ladder).toBeNull()
    expect(triggerPad).not.toHaveBeenCalled()
    over(false)
    pick(2)
    expect(triggerPad).toHaveBeenCalledTimes(1)
  })

  it('keyboard fallbacks G/H/O/L; ignored in form controls and when inactive', () => {
    const onAction = vi.fn()
    mount({ onAction })
    const key = (k, type = 'keydown') => document.dispatchEvent(new KeyboardEvent(type, { key: k, bubbles: true }))
    key('h')
    expect(settings().full).toBe(false) // inactive
    view.setActive(true)
    key('h')
    expect(settings().full).toBe(true)
    key('g'); key('g', 'keyup')
    expect(onAction.mock.calls).toEqual([['repeat', { pressed: true }], ['repeat', { pressed: false }]])
    key('o'); expect(view.overlayActive()).toBe(true); key('o', 'keyup'); expect(view.overlayActive()).toBe(false)
    key('l'); expect(settings().ladder).toBe('velocity')
    key('l'); key('l'); key('l'); expect(settings().ladder).toBe('filter')
    key('l'); expect(settings().ladder).toBeNull()
    root.querySelector('.pads-rate').focus()
    key('h')
    expect(settings().full).toBe(true)
  })

  it('Shift + hover shows help for the control role, incl. the repeat note', () => {
    mount()
    const tip = root.querySelector('.pads-help')
    const rep = root.querySelector('.pads-repeat')
    rep.dispatchEvent(new Event('pointerover', { bubbles: true }))
    expect(tip.hidden).toBe(true)
    const e = new Event('pointerover', { bubbles: true }); e.shiftKey = true
    rep.dispatchEvent(e)
    expect(tip.hidden).toBe(false)
    expect(tip.textContent).toContain('Note Repeat off')
    rep.dispatchEvent(new Event('pointerout', { bubbles: true }))
    expect(tip.hidden).toBe(true)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift' }))
    root.querySelector('.pads-ladder').dispatchEvent(new Event('pointerover', { bubbles: true }))
    expect(tip.textContent).toContain('Now: off')
    document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift' }))
    expect(tip.hidden).toBe(true)
  })

  it('pickPad picks the overlay item like a tap (hardware pads under Overlay)', () => {
    mount()
    view.pressControl('overlay', true)
    view.pickPad(2)
    expect(settings().muted).toEqual([38])
    expect(triggerPad).not.toHaveBeenCalled()
    view.pickPad(null)
    expect(settings().muted).toEqual([38])
  })

  it('on-screen pad release (pointerup/leave) and PC key release report the matching note, once', () => {
    const releasePad = vi.fn()
    mount({ releasePad })
    view.setActive(true)
    pad(1).dispatchEvent(new Event('pointerdown', { bubbles: true, cancelable: true }))
    pad(1).dispatchEvent(new Event('pointerup', { bubbles: true }))
    pad(1).dispatchEvent(new Event('pointerleave', { bubbles: true }))
    expect(releasePad.mock.calls).toEqual([[37]])
    view.trigger(4, 'keyq')
    view.setBank(1)   // bank change between press and release: release still names the pressed note
    document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Q', bubbles: true }))
    expect(releasePad.mock.calls).toEqual([[37], [40]])
    view.pressControl('overlay', true)
    view.trigger(0, 'keyz')
    document.dispatchEvent(new KeyboardEvent('keyup', { key: 'z', bubbles: true }))
    expect(releasePad).toHaveBeenCalledTimes(2)   // an overlay pick never sounded, so nothing to release
  })

  it('G/H/O/L keydown is ignored while a dialog is open; keyup still ends a hold', () => {
    const onAction = vi.fn()
    mount({ onAction })
    view.setActive(true)
    const key = (k, type = 'keydown') => document.dispatchEvent(new KeyboardEvent(type, { key: k, bubbles: true }))
    key('g')
    const dlg = document.createElement('dialog')
    dlg.setAttribute('open', '')
    document.body.append(dlg)
    key('h'); key('o')
    expect(settings().full).toBe(false)
    expect(view.overlayActive()).toBe(false)
    key('g', 'keyup')
    dlg.remove()
    expect(onAction.mock.calls).toEqual([['repeat', { pressed: true }], ['repeat', { pressed: false }]])
  })

  it('a store change repaints pads and strip only when what they draw changed', () => {
    mount()
    const kit = vi.spyOn(view, 'refreshKit')
    ProjectStore.dispatch(SetPadsSettings({ metronome: true }))
    ProjectStore.dispatch(SetPadsSettings({ snapGrid: 0.5 }))
    expect(kit).not.toHaveBeenCalled()
    ProjectStore.dispatch(SetPadsSettings({ muted: [36] }))
    expect(kit).toHaveBeenCalledTimes(1)
    ProjectStore.dispatch(SetPadsSettings({ ladder: 'tune' }))
    expect(kit).toHaveBeenCalledTimes(2)
  })
})
