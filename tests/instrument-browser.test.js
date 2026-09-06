// @vitest-environment jsdom
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { InstrumentBrowser, BROWSER_DIALOG_ID } from '../src/renderer/js/components/instrument-browser.js'

const MARKUP = `
<dialog id="${BROWSER_DIALOG_ID}">
  <button id="ib-settings-btn"></button>
  <input type="search" id="ib-search">
  <div id="ib-scopes"></div>
  <input type="text" id="ib-save-name">
  <button id="ib-save-btn"></button>
  <div id="ib-list"></div>
</dialog>`

const packs = [{
  id: 'gm', version: '1',
  manifest: { name: 'GM Main', patches: [
    { id: 'piano', name: 'Acoustic Grand', address: { bankMsb: 0, bankLsb: 0, program: 0 } },
    { id: 'pad', name: 'Warm Pad', address: { bankMsb: 0, bankLsb: 0, program: 89 } },
  ] }
}]

function setup() {
  document.body.innerHTML = MARKUP
  const el = document.getElementById(BROWSER_DIALOG_ID)
  el.showModal = () => { el.open = true }
  el.close = () => { if (el.open) { el.open = false; el.dispatchEvent(new Event('close')) } }

  const tracks = [{ id: 't1', type: 'midi', instrument: { type: 'palette', paletteKey: 'classic', params: {} } }]
  const presets = [{ id: 'preset-1', name: 'Night Pad', paletteKey: 'classic', params: { cutoff: 400 } }]
  const dispatched = []
  const deps = {
    store: { getState: () => ({ tracks, racks: {}, presets }), dispatch: cmd => dispatched.push(cmd) },
    packCatalog: () => packs,
    palettes: () => ({ classic: { name: 'Classic Synth' } }),
    racks: () => ({}),
    presets: () => presets,
    auditioner: { play: vi.fn(), stop: vi.fn() },
    ensureTrack: () => tracks[0],
    addTrack: vi.fn(() => { tracks.push({ id: 't2', type: 'midi' }); return tracks[1] }),
    packState: () => 'ready',
  }
  const browser = new InstrumentBrowser(deps)
  browser.open()
  return { browser, deps, dispatched, el, tracks }
}

const press = (el, key, init = {}) => el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...init }))
const labels = () => [...document.querySelectorAll('.ib-label')].map(node => node.textContent)

describe('instrument browser', () => {
  beforeEach(() => { localStorage.clear(); vi.useRealTimers() })

  it('lists every source and filters live', () => {
    const { browser } = setup()
    expect(labels()).toEqual(['Acoustic Grand', 'Warm Pad', 'Classic Synth', 'Night Pad'])
    browser.search.value = 'warm'
    browser.search.dispatchEvent(new Event('input'))
    expect(labels()).toEqual(['Warm Pad'])
  })

  it('lists project presets beside factory patches, not in a separate surface', () => {
    const { el } = setup()
    press(el, 'Tab', {}) // PACKS
    press(el, 'Tab', {}) // INTERNAL
    press(el, 'Tab', {}) // RACKS
    press(el, 'Tab', {}) // ♥
    press(el, 'Tab', {}) // RECENT
    press(el, 'Tab', {}) // PRESETS
    expect(labels()).toEqual(['Night Pad'])
  })

  it('auditions the highlighted row after a debounce', () => {
    vi.useFakeTimers()
    const { browser, deps, el } = setup()
    press(el, 'ArrowDown')
    expect(deps.auditioner.play).not.toHaveBeenCalled()
    vi.advanceTimersByTime(200)
    expect(deps.auditioner.play).toHaveBeenCalledWith(browser.rows[1].instrument)
  })

  it('Enter assigns to the armed track and closes', () => {
    const { dispatched, el, tracks } = setup()
    press(el, 'Enter')
    expect(dispatched).toHaveLength(1)
    const next = dispatched[0].execute({ tracks: structuredClone(tracks), racks: {} })
    expect(next.tracks[0].instrument).toEqual({ type: 'pack', packId: 'gm', packVersion: '1', patchId: 'piano', programFollow: 'pinned' })
    expect(el.open).toBe(false)
  })

  it('Shift+Enter makes a new track instead', () => {
    const { deps, el } = setup()
    press(el, 'Enter', { shiftKey: true })
    expect(deps.addTrack).toHaveBeenCalledOnce()
    expect(el.open).toBe(false)
  })

  it('Tab cycles scope chips and ♥ is a saved query over the same index', () => {
    const { browser, el } = setup()
    press(el, 'Tab')                                   // PACKS
    expect(labels()).toEqual(['Acoustic Grand', 'Warm Pad'])
    press(el, 'Tab')                                   // INTERNAL
    expect(labels()).toEqual(['Classic Synth'])
    press(el, 'Tab'); press(el, 'Tab')                 // RACKS, ♥
    expect(labels()).toEqual([])
    browser.toggleFavourite({ key: 'palette:classic' })
    browser.refresh()
    expect(labels()).toEqual(['Classic Synth'])
  })

  it('Esc closes without assigning and stops the audition', () => {
    const { deps, dispatched, el } = setup()
    el.close()
    expect(dispatched).toHaveLength(0)
    expect(deps.auditioner.stop).toHaveBeenCalled()
  })

  it('saves the armed track\'s current sound as a preset', () => {
    const { browser, dispatched } = setup()
    browser.el.querySelector('#ib-save-name').value = 'Bright Lead'
    browser.el.querySelector('#ib-save-btn').click()
    expect(dispatched).toHaveLength(1)
    expect(dispatched[0].label).toMatch(/Bright Lead/)
  })

  it('does not save when the armed track has no palette instrument', () => {
    const { browser, dispatched, tracks } = setup()
    tracks[0].instrument = { type: 'rack', rackId: 'r1' }
    browser.el.querySelector('#ib-save-btn').click()
    expect(dispatched).toHaveLength(0)
  })

  it('applying a preset row dispatches ApplyPreset against the armed track', () => {
    const { browser, dispatched, el } = setup()
    const presetRow = browser.rows.find(row => row.kind === 'preset')
    browser.assign(presetRow, false)
    expect(dispatched).toHaveLength(1)
    expect(dispatched[0].label).toMatch(/preset/i)
  })

  it('removing a preset is reachable from its row', () => {
    const { browser, dispatched } = setup()
    browser.scopeIndex = 6 // PRESETS is the last scope chip
    browser.refresh()
    const removeBtn = document.querySelector('.ib-preset-remove')
    removeBtn.click()
    expect(dispatched).toHaveLength(1)
    expect(dispatched[0].label).toMatch(/remove preset/i)
  })

  it('survives a storage that refuses to answer', () => {
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied') })
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied') })
    expect(() => { const { browser } = setup(); browser.toggleFavourite({ key: 'palette:classic' }) }).not.toThrow()
    get.mockRestore(); set.mockRestore()
  })
})
