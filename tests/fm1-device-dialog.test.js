// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createFm1DeviceDialog, statusLine, DEVICE_DIALOG_ID } from '../src/renderer/js/components/fm1-device-dialog.js'

const MARKUP = `<dialog id="${DEVICE_DIALOG_ID}"><span id="fm1d-title"></span><div id="fm1d-body"></div></dialog>`

function fakeSession(overrides = {}) {
  const lcdSubs = []
  const statusSubs = []
  const session = {
    path: 'worker',
    state: { state: 'ready', rtf: 2.34, underruns: 0, late: 0, starved: 0 },
    status() { return this.state },
    key: vi.fn(), enc: vi.fn(), pot: vi.fn(),
    unLcd: vi.fn(), unStatus: vi.fn(),
    onLcd(cb) { lcdSubs.push(cb); return this.unLcd },
    onStatus(cb) { statusSubs.push(cb); return this.unStatus },
    lcdSubs, statusSubs,
    ...overrides
  }
  return session
}

let session, dialog, track, el, putImageData
const press = (node, key, type = 'keydown', init = {}) => node.dispatchEvent(new KeyboardEvent(type, { key, bubbles: true, cancelable: true, ...init }))
const byName = name => document.querySelector(`[aria-label="${name}"]`)

beforeEach(() => {
  putImageData = vi.fn()
  HTMLCanvasElement.prototype.getContext = () => ({ putImageData })
  globalThis.ImageData = class { constructor(data, w, h) { this.data = data; this.width = w; this.height = h } }
  document.body.innerHTML = MARKUP
  el = document.getElementById(DEVICE_DIALOG_ID)
  el.show = function () { this.open = true }
  el.showModal = el.show
  el.close = function () { if (this.open) { this.open = false; this.dispatchEvent(new Event('close')) } }
  session = fakeSession()
  track = { id: 't1', name: 'Lead', instrument: { type: 'fm1', firmwareHash: 'sha256:a', deviceChannel: 0, mhz: 100 } }
  dialog = createFm1DeviceDialog({
    getSession: () => session,
    getTrack: id => id === 't1' ? track : null,
    compatFor: () => ({ minMhz: 120 })
  })
})

describe('fm1 device dialog', () => {
  it('refuses a track that is not FM-1', () => {
    track.instrument = { type: 'palette' }
    expect(dialog.open('t1')).toBe(false)
    expect(el.open).toBeFalsy()
  })

  it('renders every control with an accessible name: 7 encoders, 1 pot, 14 buttons, 27 keys', () => {
    expect(dialog.open('t1')).toBe(true)
    expect(el.open).toBe(true)
    expect(document.querySelectorAll('button.fm1d-enc')).toHaveLength(7)
    expect(document.querySelectorAll('.fm1d-enc[role="slider"], .fm1d-enc[aria-valuenow]')).toHaveLength(0)
    expect(document.querySelectorAll('.fm1d-pot[role="slider"]')).toHaveLength(1)
    expect(document.querySelectorAll('button.fm1d-btn')).toHaveLength(14)
    expect(document.querySelectorAll('button.fm1d-key')).toHaveLength(27)
    for (const node of document.querySelectorAll('.fm1d-panel [aria-label]')) expect(node.getAttribute('aria-label')).toBeTruthy()
    for (const node of document.querySelectorAll('.fm1d-panel button, .fm1d-panel [role="slider"]')) expect(node.getAttribute('aria-label')).toBeTruthy()
    expect(byName('SELECT encoder')).not.toBeNull()
    expect(byName('Key C4')).not.toBeNull()
    expect(document.querySelector('canvas[aria-label="FM-1 display"]')).not.toBeNull()
    expect(document.getElementById('fm1d-title').textContent).toBe('FM-1 · Lead')
    // two tracks may share a name: the position tells them apart
    dialog.close()
    const numbered = createFm1DeviceDialog({ getSession: () => session, getTrack: id => id === 't1' ? track : null, trackNumber: () => 2, compatFor: () => null })
    numbered.open('t1')
    expect(document.getElementById('fm1d-title').textContent).toBe('FM-1 · Lead · track 2')
  })

  it('encoder arrows send +-1, Page keys +-5, other keys nothing', () => {
    dialog.open('t1')
    const select = byName('SELECT encoder')
    expect(select.tagName).toBe('BUTTON')
    expect(select.getAttribute('aria-description')).toBe('Arrow keys turn it')
    press(select, 'ArrowUp'); press(select, 'ArrowDown'); press(select, 'PageUp'); press(select, 'PageDown'); press(select, 'a')
    expect(session.enc.mock.calls).toEqual([[0, 1], [0, -1], [0, 5], [0, -5]])
    press(byName('ALGORITHM encoder'), 'ArrowRight')
    expect(session.enc).toHaveBeenLastCalledWith(1, 1)
    expect(select.hasAttribute('aria-valuenow')).toBe(false)
  })

  it('a button presses on keydown and releases on keyup, once per hold', () => {
    dialog.open('t1')
    const play = byName('PLAY')
    press(play, 'Enter'); press(play, 'Enter', 'keydown', { repeat: true })
    expect(session.key.mock.calls).toEqual([[12, true]])
    press(play, 'Enter', 'keyup')
    expect(session.key.mock.calls).toEqual([[12, true], [12, false]])
    press(byName('Key C4'), ' '); press(byName('Key C4'), ' ', 'keyup')
    expect(session.key).toHaveBeenLastCalledWith(21, false)
  })

  it('a button presses on pointerdown and releases on pointerup', () => {
    dialog.open('t1')
    const save = byName('SAVE')
    save.dispatchEvent(new Event('pointerdown', { bubbles: true, cancelable: true }))
    save.dispatchEvent(new Event('pointerup', { bubbles: true }))
    expect(session.key.mock.calls).toEqual([[9, true], [9, false]])
  })

  it('closing releases held keys and unsubscribes the LCD, but does not touch the device', () => {
    dialog.open('t1')
    press(byName('PLAY'), 'Enter')
    el.close()
    expect(session.key).toHaveBeenLastCalledWith(12, false)
    expect(session.unLcd).toHaveBeenCalledOnce()
    expect(session.unStatus).toHaveBeenCalledOnce()
    expect(session.dispose).toBeUndefined()
  })

  it('the pot is a 0..1023 slider that reports "not set" until moved', () => {
    dialog.open('t1')
    const pot = byName('MASTER')
    expect(pot.getAttribute('role')).toBe('slider')
    expect(pot.getAttribute('aria-valuemin')).toBe('0')
    expect(pot.getAttribute('aria-valuemax')).toBe('1023')
    expect(pot.hasAttribute('aria-valuenow')).toBe(false)
    expect(pot.getAttribute('aria-valuetext')).toBe('not set')
    press(pot, 'End'); press(pot, 'Home'); press(pot, 'ArrowUp')
    expect(session.pot.mock.calls).toEqual([[1023], [0], [16]])
    expect(pot.getAttribute('aria-valuenow')).toBe('16')
    expect(pot.getAttribute('aria-valuetext')).toBe('16')
  })

  it('paints LCD frames and LEDs from the subscription', () => {
    dialog.open('t1')
    const leds = new Float32Array(41); leds[12] = 0.75
    session.lcdSubs.at(-1)(new Uint8ClampedArray(240 * 240 * 4), leds)
    expect(putImageData).toHaveBeenCalledOnce()
    expect(byName('PLAY').style.getPropertyValue('--led')).toBe('0.75')
    expect(byName('HOME').style.getPropertyValue('--led')).toBe('0')
  })

  it('shows status, the worker latency note, the saves note and the slow-clock warning', () => {
    dialog.open('t1')
    const text = document.getElementById(DEVICE_DIALOG_ID).textContent
    expect(text).toMatch(/Running · 2\.3x realtime/)
    expect(text).toMatch(/about 100 ms latency/)
    expect(text).toMatch(/Saves on the device are kept when the project is saved to a folder/)
    expect(text).toMatch(/at least 120 MHz/)
  })

  it('reports a failed device and a strained one', () => {
    session.state = { state: 'failed', reason: 'missing-firmware', underruns: 0, starved: 0 }
    dialog.open('t1')
    expect(document.querySelector('.fm1d-status').textContent).toMatch(/not installed/)
    el.close()
    session.state = { state: 'ready', rtf: 1, underruns: 0, starved: 0 }
    dialog.open('t1')
    session.state = { state: 'ready', rtf: 1, underruns: 3, starved: 0 }
    session.statusSubs.at(-1)()
    expect(document.querySelector('.fm1d-status').textContent).toMatch(/Struggling to keep up/)
    expect(document.querySelector('.fm1d-status').classList.contains('warn')).toBe(true)
  })
})

describe('fm1 device dialog follows the store', () => {
  it('closes when the track is deleted or stops being FM-1', () => {
    dialog.open('t1')
    track.instrument = { type: 'palette' }
    dialog.refresh()
    expect(el.open).toBe(false)
    track.instrument = { type: 'fm1', firmwareHash: 'sha256:a' }
    dialog.open('t1')
    track = null
    dialog.refresh()
    expect(el.open).toBe(false)
  })

  it('re-binds to a new session after a descriptor change, unsubscribing the old one', () => {
    dialog.open('t1')
    const old = session
    session = fakeSession()
    track.instrument = { ...track.instrument, mhz: 200 }
    dialog.refresh()
    expect(old.unLcd).toHaveBeenCalledOnce()
    expect(session.lcdSubs).toHaveLength(1)
    press(byName('PLAY'), 'Enter')
    expect(session.key).toHaveBeenCalledWith(12, true)
    expect(old.key).not.toHaveBeenCalled()
  })

  it('a disposed session re-binds to its replacement; an unchanged store is a no-op', async () => {
    dialog.open('t1')
    dialog.refresh()
    expect(session.lcdSubs).toHaveLength(1)
    const old = session
    session = fakeSession()
    old.state = { state: 'disposed', underruns: 0, starved: 0 }
    old.statusSubs.at(-1)()
    await Promise.resolve()
    expect(session.lcdSubs).toHaveLength(1)
    press(byName('SELECT encoder'), 'ArrowUp')
    expect(session.enc).toHaveBeenCalledWith(0, 1)
  })

  it('a disposed session handed back again does not loop', async () => {
    dialog.open('t1')
    session.state = { state: 'disposed', underruns: 0, starved: 0 }
    session.statusSubs.at(-1)()
    await Promise.resolve(); await Promise.resolve()
    expect(session.lcdSubs).toHaveLength(1)
    expect(document.querySelector('.fm1d-status').textContent).toMatch(/stopped/)
  })
})

describe('statusLine', () => {
  it('covers each state', () => {
    expect(statusLine(null)).toMatch(/not available/)
    expect(statusLine({ state: 'booting' })).toMatch(/Starting/)
    expect(statusLine({ state: 'disposed' })).toMatch(/stopped/)
    expect(statusLine({ state: 'failed', reason: 'halted' })).toMatch(/crashed/)
    expect(statusLine({ state: 'ready' })).toBe('Running')
    expect(statusLine({ state: 'ready', bootTimeout: true })).toMatch(/over 8 s to start/)
  })
})

describe('panel layout hit targets', () => {
  it('no two controls overlap, so every key and button is clickable over its whole box', async () => {
    const { ENCODERS, POT, BUTTONS, KEYS, LCD } = await import('../src/renderer/js/fm1/panel-layout.js')
    const box = s => ('r' in s ? { x: s.cx - s.r, y: s.cy - s.r, w: 2 * s.r, h: 2 * s.r } : s)
    const all = [...ENCODERS, POT, ...BUTTONS, ...KEYS, LCD].map(box)
    for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
      const a = all[i], b = all[j]
      const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
      expect(overlap, `${JSON.stringify(a)} vs ${JSON.stringify(b)}`).toBe(false)
    }
  })

  it('a key holds nothing that takes the pointer: its LED ignores pointer events', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/renderer/styles/fm1-device.css'), 'utf8')
    expect(css).toMatch(/\.fm1d-led\s*\{[^}]*pointer-events:\s*none/)
    dialog.open('t1')
    for (const key of document.querySelectorAll('button.fm1d-key')) {
      expect([...key.children].every(child => child.classList.contains('fm1d-led'))).toBe(true)
      expect(key.textContent).toBe('')
    }
  })
})

describe('fm1 device dialog: saved device state', () => {
  let flash
  const withFlash = (hasFolder) => {
    document.body.innerHTML = MARKUP
    el = document.getElementById(DEVICE_DIALOG_ID)
    el.show = function () { this.open = true }
    el.showModal = el.show
    el.close = function () { if (this.open) { this.open = false; this.dispatchEvent(new Event('close')) } }
    flash = { hasFolder: () => hasFolder, reset: vi.fn(), exportState: vi.fn(), importState: vi.fn() }
    dialog = createFm1DeviceDialog({ getSession: () => session, getTrack: id => id === 't1' ? track : null, compatFor: () => null, flash })
  }
  const button = text => [...document.querySelectorAll('.fm1d-flash button')].find(b => b.textContent === text)

  it('a saved state that cannot load shows why, and offers Start from firmware defaults', () => {
    withFlash(true)
    for (const [reason, text] of [['flash-missing', /missing from the project folder/], ['flash-corrupt', /damaged/], ['flash-wrong-firmware', /different firmware/]]) {
      session.state = { state: 'failed', reason, underruns: 0, starved: 0 }
      dialog.open('t1')
      expect(document.querySelector('.fm1d-status').textContent).toMatch(text)
      expect(button('Start from firmware defaults').hidden).toBe(false)
      el.close()
    }
    dialog.open('t1')
    button('Start from firmware defaults').click()
    expect(flash.reset).toHaveBeenCalledWith('t1')
  })

  it('no reset for a running device or another failure; export/import only while running', () => {
    withFlash(true)
    dialog.open('t1')
    expect(button('Start from firmware defaults').hidden).toBe(true)
    expect(button('Export device state…').disabled).toBe(false)
    button('Export device state…').click()
    button('Import device state…').click()
    expect(flash.exportState).toHaveBeenCalledWith('t1')
    expect(flash.importState).toHaveBeenCalledWith('t1')
    el.close()
    session.state = { state: 'failed', reason: 'missing-firmware', underruns: 0, starved: 0 }
    dialog.open('t1')
    expect(button('Start from firmware defaults').hidden).toBe(true)
    expect(button('Export device state…').disabled).toBe(true)
    expect(button('Import device state…').disabled).toBe(true)
  })

  it('without a project folder it says saves need one; with one it does not', () => {
    withFlash(false)
    dialog.open('t1')
    expect(document.querySelector('.fm1d-note').textContent).toMatch(/kept when the project is saved to a folder/)
    withFlash(true)
    dialog.open('t1')
    expect(document.querySelector('.fm1d-note').textContent).not.toMatch(/saved to a folder/)
  })
})
