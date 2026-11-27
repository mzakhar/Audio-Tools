// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createControllerLearn, learnInto, loadOverrides, saveOverrides, safeStorage, storageKey } from '../src/renderer/js/components/controller-learn-dialog.js'

import { SMC_PAD } from '../src/renderer/js/pads/profiles/smc-pad.js'

const memory = () => { const m = new Map(); return { getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: k => m.delete(k) } }

beforeEach(() => {
  document.body.innerHTML = '<dialog id="controller-learn-dialog"><output id="controller-learn-device"></output><p id="controller-learn-note"></p><div id="controller-learn-list"></div><button id="controller-learn-reset"></button></dialog>'
  const d = document.getElementById('controller-learn-dialog')
  d.showModal = () => { d.open = true }
  d.close = () => { d.open = false }
})

describe('learnInto / loadOverrides', () => {
  it('one control per action', () => {
    expect(learnInto({ 'cc:0:1': 'full', 'cc:0:2': 'layer' }, 'cc:0:9', 'full')).toEqual({ 'cc:0:2': 'layer', 'cc:0:9': 'full' })
  })
  it('learning onto a new control unbinds the profile default for that action', () => {
    expect(learnInto({}, 'cc:0:90', 'layer', 'cc:0:26')).toEqual({ 'cc:0:26': null, 'cc:0:90': 'layer' })
    expect(learnInto({ 'cc:0:90': 'layer', 'cc:0:26': null }, 'cc:0:91', 'layer', 'cc:0:26')).toEqual({ 'cc:0:26': null, 'cc:0:91': 'layer' })
    // an existing claim on that control survives, and re-learning the default itself needs no null
    expect(learnInto({ 'cc:0:26': 'full' }, 'cc:0:90', 'layer', 'cc:0:26')).toEqual({ 'cc:0:26': 'full', 'cc:0:90': 'layer' })
    expect(learnInto({}, 'cc:0:26', 'layer', 'cc:0:26')).toEqual({ 'cc:0:26': 'layer' })
  })
  it('null storage never throws', () => {
    expect(loadOverrides(null, 'X')).toEqual({})
    expect(() => saveOverrides(null, 'X', { a: 'b' })).not.toThrow()
    expect(() => safeStorage()).not.toThrow()
  })
  it('bad storage is an empty map', () => {
    const s = memory(); s.setItem(storageKey('X'), '{nope')
    expect(loadOverrides(s, 'X')).toEqual({})
    expect(loadOverrides({ getItem() { throw new Error('x') } }, 'X')).toEqual({})
  })
})

describe('learn dialog', () => {
  const make = (extra = {}) => {
    const storage = memory(), router = { capture: null }, onChange = vi.fn()
    const learn = createControllerLearn({ storage, getDevice: () => 'SMC-PAD', isConnected: () => true, router, onChange, profileFor: () => SMC_PAD, ...extra })
    return { storage, router, onChange, learn }
  }

  it('opens, learns one mapping from a device event, persists it', () => {
    const { learn, router, storage, onChange } = make()
    learn.open()
    expect(document.getElementById('controller-learn-dialog').open).toBe(true)
    expect(document.getElementById('controller-learn-device').textContent).toBe('SMC-PAD')
    document.querySelector('[data-action="full"]').click()
    expect(router.capture).toBeTypeOf('function')
    router.capture({ kind: 'cc', channel: 0, controller: 90, value: 127 }, 'SMC-PAD')
    expect(JSON.parse(storage.getItem(storageKey('SMC-PAD')))).toEqual({ 'cc:0:29': null, 'cc:0:90': 'full' })
    expect(router.capture).toBeNull()
    expect(onChange).toHaveBeenCalledWith('SMC-PAD')
    expect(document.querySelector('[data-action="full"]').textContent).toContain('cc:0:90')
  })

  it('ignores non-control events while armed; reset clears', () => {
    const { learn, router, storage } = make()
    learn.open()
    document.querySelector('[data-action="knob:2"]').click()
    router.capture({ kind: 'channel-aftertouch', channel: 0, pressure: 5 }, 'SMC-PAD')
    expect(router.capture).toBeTypeOf('function')
    router.capture({ kind: 'cc', channel: 0, controller: 50, value: 3 }, 'SMC-PAD')
    expect(storage.getItem(storageKey('SMC-PAD'))).not.toBeNull()
    document.getElementById('controller-learn-reset').click()
    expect(storage.getItem(storageKey('SMC-PAD'))).toBeNull()
  })

  it('no device: explains and disables', () => {
    const { learn } = make({ isConnected: () => false })
    learn.open()
    expect(document.getElementById('controller-learn-note').textContent).toMatch(/https/)
    expect(document.querySelector('[data-action="full"]').disabled).toBe(true)
  })
})
