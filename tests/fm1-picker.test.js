// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { buildIndex, searchIndex } from '../src/renderer/js/instruments/patch-index.js'
import { trackInstrumentLabel } from '../src/renderer/js/instruments/instrument-label.js'
import { InstrumentBrowser, BROWSER_DIALOG_ID } from '../src/renderer/js/components/instrument-browser.js'
import { InstrumentSettings, SETTINGS_DIALOG_ID } from '../src/renderer/js/components/instrument-settings.js'
import { commandItems } from '../src/renderer/js/ui/command-model.js'

const felucca = { id: 'sha256:aaa', name: 'Felucca' }
const sloop = { id: 'sha256:bbb', name: 'SLOOP' }

describe('fm1 rows in the patch index', () => {
  it('builds one row per installed firmware with a default descriptor', () => {
    const rows = buildIndex({ fm1: [felucca, sloop] })
    expect(rows.map(row => row.key)).toEqual(['fm1:sha256:aaa', 'fm1:sha256:bbb'])
    expect(rows[0]).toMatchObject({ kind: 'fm1', label: 'Felucca', sub: 'FM-1 firmware', instrument: { type: 'fm1', firmwareHash: 'sha256:aaa', deviceChannel: 0, mhz: 120 } })
  })
  it('is scoped by the fm1 scope and searchable by name', () => {
    const index = buildIndex({ fm1: [felucca, sloop], palettes: { classic: { name: 'Classic' } } })
    expect(searchIndex(index, '', { scope: 'fm1' }).map(row => row.label)).toEqual(['Felucca', 'SLOOP'])
    expect(searchIndex(index, 'sloop').map(row => row.label)).toEqual(['SLOOP'])
  })
})

describe('fm1 label', () => {
  it('names the installed firmware, else says it is missing', () => {
    const instrument = { type: 'fm1', firmwareHash: 'sha256:aaa' }
    expect(trackInstrumentLabel(instrument, [], [felucca])).toBe('Felucca')
    expect(trackInstrumentLabel(instrument, [], () => [felucca])).toBe('Felucca')
    expect(trackInstrumentLabel(instrument, [], [])).toBe('Missing firmware')
    expect(trackInstrumentLabel(instrument, [])).toBe('Missing firmware')
  })
})

describe('fm1-device command', () => {
  it('is enabled only when an FM-1 track is armed, and always listed', () => {
    const find = opts => commandItems(opts).find(item => item.id === 'fm1-device')
    expect(find({ fm1Armed: true })).toMatchObject({ enabled: true, visible: true, label: 'FM-1 device…' })
    expect(find({})).toMatchObject({ enabled: false, visible: true })
  })
})

describe('instrument browser FM-1 scope', () => {
  const MARKUP = `<dialog id="${BROWSER_DIALOG_ID}"><button id="ib-settings-btn"></button><input type="search" id="ib-search"><div id="ib-scopes"></div>
    <input type="text" id="ib-save-name"><button id="ib-save-btn"></button><div id="ib-list"></div></dialog>`
  let browser, auditioner

  beforeEach(() => {
    localStorage.clear()
    vi.useFakeTimers()
    document.body.innerHTML = MARKUP
    const el = document.getElementById(BROWSER_DIALOG_ID)
    el.showModal = () => { el.open = true }
    el.close = () => { if (el.open) { el.open = false; el.dispatchEvent(new Event('close')) } }
    auditioner = { play: vi.fn(() => new Promise(() => {})), stop: vi.fn() }
    browser = new InstrumentBrowser({
      store: { getState: () => ({}), dispatch: vi.fn() },
      palettes: () => ({ classic: { name: 'Classic Synth' }, fm: { name: 'FM Synth' } }),
      fm1Rows: () => [felucca, sloop],
      auditioner,
      ensureTrack: () => ({ id: 't1' })
    })
    browser.open()
  })
  afterEach(() => vi.useRealTimers())

  const chip = () => [...document.querySelectorAll('.ib-chip')].find(node => node.textContent === 'FM-1')
  const labels = () => [...document.querySelectorAll('.ib-label')].map(node => node.textContent)

  it('has an FM-1 chip that lists only firmware rows', () => {
    chip().click()
    expect(labels()).toEqual(['Felucca', 'SLOOP'])
  })

  it('does not audition (boot an emulator) when the highlight moves, only on click', () => {
    chip().click()
    browser.search.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    vi.advanceTimersByTime(1000)
    expect(auditioner.play).not.toHaveBeenCalled()
    document.querySelectorAll('.ib-row')[0].click()
    vi.advanceTimersByTime(200)
    expect(auditioner.play).toHaveBeenCalledOnce()
    expect(auditioner.play.mock.calls[0][0]).toMatchObject({ type: 'fm1', firmwareHash: 'sha256:aaa' })
  })

  it('shows booting on the row until the audition settles', async () => {
    chip().click()
    let finish
    auditioner.play.mockReturnValue(new Promise(resolve => { finish = resolve }))
    document.querySelectorAll('.ib-row')[0].click()
    vi.advanceTimersByTime(200)
    expect(document.querySelector('.ib-state.booting').textContent).toMatch(/booting/)
    finish(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(document.querySelector('.ib-state.booting')).toBeNull()
    expect(document.querySelector('.ib-state').textContent).toMatch(/installed/)
  })

  it('other kinds still audition on highlight move', () => {
    document.getElementById('ib-search').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    vi.advanceTimersByTime(200)
    expect(auditioner.play).toHaveBeenCalled()
  })
})

describe('instrument settings FM-1 source', () => {
  let dispatched, track, settings, deps

  const select = label => document.querySelector(`select[aria-label="${label}"]`)
  const change = (node, value) => { node.value = value; node.dispatchEvent(new Event('change')) }

  beforeEach(() => {
    document.body.innerHTML = `<dialog id="${SETTINGS_DIALOG_ID}"><span id="is-title"></span><div id="is-tabs"></div><div id="is-body"></div></dialog>`
    const el = document.getElementById(SETTINGS_DIALOG_ID)
    el.showModal = () => { el.open = true }
    track = { id: 't1', type: 'midi', name: 'Lead', instrument: { type: 'palette', paletteKey: 'classic' } }
    dispatched = []
    deps = {
      store: { getState: () => ({ tracks: [track], racks: {}, mixer: { channels: [] } }), subscribe: vi.fn(), dispatch: cmd => dispatched.push(cmd.execute({ tracks: [{ id: 't1' }] }).tracks[0].instrument) },
      fm1Installed: () => [felucca, sloop],
      fm1Compat: hash => hash === 'sha256:aaa' ? { minMhz: 120 } : null,
      openFm1Device: vi.fn()
    }
    settings = new InstrumentSettings(deps)
    settings.open('t1')
  })

  it('offers FM-1 and picks the first installed firmware', () => {
    change(select('Instrument source'), 'fm1')
    expect(dispatched).toHaveLength(1)
    expect(dispatched[0]).toMatchObject({ type: 'fm1', firmwareHash: 'sha256:aaa' })
  })

  it('renders firmware, channel 1-16, MHz, the minMhz warning and the saves note', () => {
    track.instrument = { type: 'fm1', firmwareHash: 'sha256:aaa', deviceChannel: 2, mhz: 100 }
    settings.render()
    expect([...select('Firmware').options].map(o => o.textContent)).toEqual(['Felucca', 'SLOOP'])
    expect(select('Device channel').options).toHaveLength(16)
    expect(select('Device channel').value).toBe('2')
    expect([...select('Emulated clock').options].map(o => o.value)).toEqual(['60', '80', '100', '120', '160', '200', '240'])
    expect(select('Emulated clock').value).toBe('100')
    const text = document.getElementById('is-body').textContent
    expect(text).toMatch(/at least 120 MHz/)
    expect(text).toMatch(/Saves on the device are not kept yet/)
  })

  it('writes clock and channel changes back as a descriptor, and opens the device', () => {
    track.instrument = { type: 'fm1', firmwareHash: 'sha256:aaa', deviceChannel: 0, mhz: 120 }
    settings.render()
    change(select('Emulated clock'), '200')
    change(select('Device channel'), '9')
    expect(dispatched[0]).toMatchObject({ mhz: 200 })
    expect(dispatched[1]).toMatchObject({ deviceChannel: 9 })
    ;[...document.querySelectorAll('#is-body button')].find(b => /Open device/.test(b.textContent)).click()
    expect(deps.openFm1Device).toHaveBeenCalledWith('t1')
  })

  it('marks a missing firmware instead of silently showing another', () => {
    track.instrument = { type: 'fm1', firmwareHash: 'sha256:zzz', deviceChannel: 0, mhz: 120 }
    settings.render()
    expect(select('Firmware').selectedOptions[0].textContent).toBe('Missing firmware')
  })

  it('choosing FM-1 with no firmware installed explains why instead of silently snapping back', () => {
    deps.fm1Installed = () => []
    change(select('Instrument source'), 'fm1')
    expect(dispatched).toHaveLength(0)
    expect(select('Instrument source').value).toBe('palette')
    expect(document.getElementById('is-body').textContent).toMatch(/No FM-1 firmware installed. Open FM-1 firmware… to import one./)
    settings.render()
    expect(document.getElementById('is-body').textContent).not.toMatch(/No FM-1 firmware installed/)
  })

  it('says so when nothing is installed', () => {
    deps.fm1Installed = () => []
    track.instrument = { type: 'fm1', firmwareHash: 'sha256:aaa', deviceChannel: 0, mhz: 120 }
    settings.render()
    expect(document.getElementById('is-body').textContent).toMatch(/No firmware installed/)
  })
})
