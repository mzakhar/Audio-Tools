import { describe, it, expect, vi } from 'vitest'
import { createControllerRouter } from '../src/renderer/js/pads/controller-router.js'
import { SMC_PAD } from '../src/renderer/js/pads/profiles/smc-pad.js'

const cc = (controller, value, device = 'SMC-PAD') => ({ kind: 'cc', channel: 0, controller, value, device })

function setup(overrides = {}, extra = {}) {
  const view = { turnKnob: vi.fn(), pressControl: vi.fn() }
  const run = vi.fn()
  const applyKnob = vi.fn(() => [{ type: 'bpm', bpm: 121 }])
  const actions = { play: vi.fn(), layer: vi.fn(), repeat: vi.fn(), wipe: vi.fn(), full: vi.fn(), pressure: vi.fn() }
  const router = createControllerRouter({
    profileFor: d => (SMC_PAD.match(d) ? SMC_PAD : null), overrides: () => overrides,
    applyKnob, knobCtx: () => ({}), run, actions, view: () => view, ...extra
  })
  return { router, view, run, applyKnob, actions }
}

describe('controller router', () => {
  it('ignores other devices, pads and device-less events', () => {
    const { router } = setup()
    expect(router.handle(cc(36, 1, 'Other'))).toBe(false)
    expect(router.handle({ kind: 'cc', channel: 0, controller: 36, value: 1 })).toBe(false)
    expect(router.handle({ kind: 'note-on', channel: 9, pitch: 36, velocity: 100, device: 'SMC-PAD' })).toBe(false)
  })

  it('knob: first message seeds, later ones become deltas', () => {
    const { router, applyKnob, run, view } = setup()
    router.handle(cc(36, 10))
    expect(applyKnob).not.toHaveBeenCalled()
    router.handle(cc(36, 13))
    expect(applyKnob).toHaveBeenCalledWith(0, 3, {})
    expect(run).toHaveBeenCalledWith([{ type: 'bpm', bpm: 121 }])
    expect(view.turnKnob).toHaveBeenCalledWith(0)
  })

  it('works without knob-roles (applyKnob absent)', () => {
    const run = vi.fn()
    const router = createControllerRouter({ profileFor: () => SMC_PAD, overrides: () => ({}), knobCtx: () => ({}), run, actions: {}, view: () => null })
    router.handle(cc(36, 1)); router.handle(cc(36, 2))
    expect(run).toHaveBeenCalledWith([])
  })

  it('buttons: toggles fire on press only, holds follow the hold', () => {
    const { router, actions, view } = setup()
    router.handle(cc(26, 127)); router.handle(cc(26, 0))
    expect(actions.layer).toHaveBeenCalledTimes(1)
    router.handle(cc(27, 127)); router.handle(cc(27, 0))
    expect(actions.repeat.mock.calls).toEqual([[true], [false]])
    expect(view.pressControl).toHaveBeenCalledWith('repeat', true)
  })

  it('learned override maps a control to an action, knob:<n> to a knob', () => {
    const { router, actions, applyKnob } = setup({ 'cc:0:90': 'full', 'cc:0:91': 'knob:4' })
    router.handle(cc(90, 127))
    expect(actions.full).toHaveBeenCalled()
    router.handle(cc(91, 1)); router.handle(cc(91, 2))
    expect(applyKnob).toHaveBeenCalledWith(4, 1, {})
  })

  it('pressure goes to the repeat engine', () => {
    const { router, actions } = setup()
    router.handle({ kind: 'channel-aftertouch', channel: 9, pressure: 64, device: 'SMC-PAD' })
    expect(actions.pressure).toHaveBeenCalledWith(64)
  })

  it('capture swallows device events', () => {
    const { router, actions } = setup()
    router.capture = vi.fn()
    expect(router.handle(cc(26, 127))).toBe(true)
    expect(router.capture).toHaveBeenCalled()
    expect(actions.layer).not.toHaveBeenCalled()
  })
})

describe('controller router: gating and seeds', () => {
  it('inactive (not the Pads view): nothing is handled, everything falls through', () => {
    const { router, actions, applyKnob } = setup({}, { active: () => false })
    expect(router.handle(cc(26, 127))).toBe(false)
    router.handle(cc(36, 1)); expect(router.handle(cc(36, 5))).toBe(false)
    expect(router.handle({ kind: 'channel-aftertouch', channel: 9, pressure: 64, device: 'SMC-PAD' })).toBe(false)
    expect(actions.layer).not.toHaveBeenCalled()
    expect(applyKnob).not.toHaveBeenCalled()
  })

  it('capture still works when inactive (the dialog is modal)', () => {
    const { router } = setup({}, { active: () => false })
    router.capture = vi.fn()
    expect(router.handle(cc(26, 127))).toBe(true)
  })

  it('the knob seed is per control: a remap re-seeds, resetKnobs forgets', () => {
    let overrides = {}
    const { router, applyKnob } = setup(overrides, { overrides: () => overrides })
    router.handle(cc(36, 10))
    overrides = { 'cc:0:90': 'knob:0' }
    router.handle(cc(90, 100))          // knob 0 again, but a new control: seeds, no huge delta
    expect(applyKnob).not.toHaveBeenCalled()
    router.handle(cc(36, 11)); expect(applyKnob).toHaveBeenCalledWith(0, 1, {})
    router.resetKnobs()
    router.handle(cc(36, 20)); expect(applyKnob).toHaveBeenCalledTimes(1)
  })

  it('beginCapture lets go of holds and re-seeds; the learned control release is swallowed once', () => {
    const { router, actions, view } = setup({ 'cc:0:90': 'repeat' })
    router.handle(cc(36, 1))
    router.beginCapture(vi.fn())
    expect(actions.repeat).toHaveBeenCalledWith(false)
    expect(actions.wipe).toHaveBeenCalledWith(false)
    expect(view.pressControl).toHaveBeenCalledWith('repeat', false)
    router.endCapture(true)
    expect(router.capture).toBeNull()
    actions.repeat.mockClear()
    expect(router.handle(cc(90, 0))).toBe(true)   // the release of the press that taught it
    expect(actions.repeat).not.toHaveBeenCalled()
    router.handle(cc(90, 127)); router.handle(cc(90, 0))
    expect(actions.repeat.mock.calls).toEqual([[true], [false]])
  })
})
