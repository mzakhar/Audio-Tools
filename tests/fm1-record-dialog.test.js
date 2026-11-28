// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createFm1RecordDialog, RECORD_DIALOG_ID } from '../src/renderer/js/components/fm1-record-dialog.js'

const MARKUP = `<dialog id="${RECORD_DIALOG_ID}"><button class="dlg-close-btn"></button><div id="fm1r-body"></div></dialog>`

let el, state, listeners, flow, tracks, dialog
const $ = sel => document.querySelector(sel)
const emit = patch => { state = { ...state, ...patch }; listeners.forEach(cb => cb(state)) }

beforeEach(() => {
  document.body.innerHTML = MARKUP
  el = document.getElementById(RECORD_DIALOG_ID)
  el.showModal = function () { this.open = true }
  el.close = function () { if (this.open) { this.open = false; this.dispatchEvent(new Event('close')) } }
  state = { phase: 'idle', elapsed: 0, peak: 0, error: null, notice: null, canRetry: false }
  listeners = []
  flow = {
    state: () => state,
    onChange: cb => listeners.push(cb),
    start: vi.fn(), stop: vi.fn(), retry: vi.fn(), saveAs: vi.fn(),
    cancel: vi.fn(() => emit({ phase: 'idle' })), reset: vi.fn(() => emit({ phase: 'idle' }))
  }
  tracks = [{ id: 'a', name: 'Lead' }, { id: 'b', name: 'Pad' }]
  dialog = createFm1RecordDialog({ flow, getTracks: () => tracks, armedId: () => 'b' })
})

const escape = () => el.dispatchEvent(new Event('cancel', { cancelable: true }))

describe('fm1 record dialog', () => {
  it('lists FM-1 tracks only, defaulting to the armed one', () => {
    dialog.open()
    expect([...$('.fm1r-source').options].map(o => o.textContent)).toEqual(['Lead', 'Pad'])
    expect($('.fm1r-source').value).toBe('b')
    expect($('.fm1r-start').disabled).toBe(false)
  })

  it('disables Start with no FM-1 track', () => {
    tracks = []
    dialog.open()
    expect($('.fm1r-start').disabled).toBe(true)
    expect($('.fm1r-msg').textContent).toMatch(/FM-1 track/)
  })

  it('Start passes parsed options; bad input shows a message and does not start', () => {
    dialog.open()
    $('.fm1r-beat').value = '8'
    $('.fm1r-bars').value = '4'
    $('.fm1r-mute').checked = true
    $('.fm1r-start').click()
    expect(flow.start).toHaveBeenCalledWith({ trackId: 'b', startBeat: 8, bars: 4, tail: 2, mute: true })
    flow.start.mockClear()
    $('.fm1r-beat').value = '-3'
    $('.fm1r-start').click()
    expect(flow.start).not.toHaveBeenCalled()
    expect($('.fm1r-msg').textContent).toMatch(/Start beat/)
  })

  it('recording view shows elapsed and level; Stop calls the flow', () => {
    dialog.open()
    emit({ phase: 'recording', elapsed: 65, peak: 0.4 })
    expect($('.fm1r-setup').hidden).toBe(true)
    expect($('.fm1r-running').hidden).toBe(false)
    expect($('.fm1r-elapsed').textContent).toBe('1:05')
    expect($('.fm1r-meter').value).toBe(0.4)
    $('.fm1r-stop').click()
    expect(flow.stop).toHaveBeenCalled()
  })

  it('Escape while recording cancels and closes', () => {
    dialog.open()
    emit({ phase: 'recording' })
    escape()
    expect(flow.cancel).toHaveBeenCalled()
    expect(el.open).toBe(false)
  })

  it('Escape in setup just closes', () => {
    dialog.open()
    escape()
    expect(flow.cancel).not.toHaveBeenCalled()
    expect(el.open).toBe(false)
  })

  it('pending take: close needs two steps before discarding', () => {
    dialog.open()
    emit({ phase: 'pending', error: "Couldn't save the take: disk full", canRetry: true })
    expect($('.fm1r-pending').hidden).toBe(false)
    expect($('.fm1r-msg').textContent).toMatch(/disk full/)
    expect($('.fm1r-retry').disabled).toBe(false)
    escape()
    expect(el.open).toBe(true)
    expect(flow.cancel).not.toHaveBeenCalled()
    expect($('.fm1r-confirm').hidden).toBe(false)
    $('.fm1r-really').click()
    expect(flow.cancel).toHaveBeenCalled()
    expect(el.open).toBe(false)
  })

  it('pending take: Keep backs out of the confirm; Retry disabled with no project folder', () => {
    dialog.open()
    emit({ phase: 'pending', canRetry: false })
    expect($('.fm1r-retry').disabled).toBe(true)
    $('.fm1r-discard').click()
    expect($('.fm1r-confirm').hidden).toBe(false)
    $('.fm1r-keep').click()
    expect($('.fm1r-confirm').hidden).toBe(true)
    expect(flow.cancel).not.toHaveBeenCalled()
    $('.fm1r-saveas').click()
    expect(flow.saveAs).toHaveBeenCalled()
  })

  it('cannot be closed while saving', () => {
    dialog.open()
    emit({ phase: 'saving' })
    escape()
    expect(el.open).toBe(true)
  })
})
