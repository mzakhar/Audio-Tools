// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { LibraryDialog, LIBRARY_DIALOG_ID } from '../src/renderer/js/components/library-dialog.js'
import { packPatchState } from '../src/renderer/js/instruments/pack-registry.js'

const MARKUP = `
<dialog id="${LIBRARY_DIALOG_ID}">
  <div class="dlg-body">
  <button id="lib-import-btn"></button>
  <div id="lib-list"></div>
  <div id="lib-browse" hidden>
    <button id="lib-add-folder"></button>
    <button id="lib-rescan"></button>
    <div id="lib-folders"></div>
    <input type="search" id="lib-search">
    <div id="lib-results"></div>
  </div>
  </div>
</dialog>`

const preset = (name, program) => ({ bank: 0, program, name })

const bank = (fileName, title, presets, extra = {}) => ({
  path: `folder/${fileName}`, folder: 'folder', fileName, size: 10, mtimeMs: 1,
  title, info: { author: 'Yingchun', ...extra.info }, presets
})

/** 500 banks × 3 presets — enough to trip the 200-row cap. */
function manyBanks(count = 500) {
  return Array.from({ length: count }, (_, index) =>
    bank(`bank${index}.sf2`, `Bank ${index}`, [preset('Acoustic Grand Piano', 0), preset('Warm Pad', 89), preset('Slap Bass', 36)]))
}

function setup({ banks = [], packs = [], folders = [{ id: 'folder', name: 'Packs', granted: true }], library = true, discovery = null } = {}) {
  document.body.innerHTML = MARKUP
  const el = document.getElementById(LIBRARY_DIALOG_ID)
  el.showModal = () => { el.open = true }
  el.close = () => { if (el.open) { el.open = false; el.dispatchEvent(new Event('close')) } }

  const lib = {
    listFolders: vi.fn(async () => folders),
    addFolder: vi.fn(async () => folders),
    removeFolder: vi.fn(async () => []),
    requestAccess: vi.fn(async () => true),
    scan: vi.fn(async () => ({ folders, banks, skipped: 3 })),
    importPreset: vi.fn(async () => ({ id: 'bank0', version: '1.0.0', manifest: {} }))
  }
  const deps = {
    packCatalog: () => packs,
    canImport: () => true,
    importPack: vi.fn(),
    folders: () => (library ? lib : null),
    importPreset: vi.fn((path, presetIndex) => lib.importPreset(path, presetIndex)),
    armPack: vi.fn(),
    discovery: () => discovery
  }
  const dialog = new LibraryDialog(deps)
  return { dialog, deps, lib, el }
}

const installed = (packId, patchIds) => ({
  id: packId, version: '1.0.0', origin: 'idb',
  manifest: { name: packId, patches: [] },
  byId: new Map(patchIds.map(id => [id, { id }]))
})

const results = () => [...document.querySelectorAll('.lib-preset')]
const search = (dialog, value) => { dialog.searchEl.value = value; dialog.renderResults() }

describe('LibraryDialog browse', () => {
  it('hides the browse section when neither folder origin exists', () => {
    const { dialog } = setup({ library: false })
    expect(document.getElementById('lib-browse').hidden).toBe(true)
    expect(dialog.searchEl).toBeUndefined()
  })

  it('scans on first open and reports the skip count', async () => {
    const { dialog, lib } = setup({ banks: manyBanks(2) })
    dialog.open()
    await Promise.resolve()
    await Promise.resolve()
    expect(lib.scan).toHaveBeenCalledTimes(1)
    expect(document.getElementById('lib-folders').textContent).toContain('6 presets in 2 banks')
    expect(document.getElementById('lib-folders').textContent).toContain('3 skipped')
  })

  it('renders at most 200 rows and filters on the search text', async () => {
    const { dialog } = setup({ banks: manyBanks() })
    await dialog.rescan()
    expect(dialog.rows.length).toBe(1500)
    expect(results().length).toBe(200)
    search(dialog, 'warm pad')
    expect(results().length).toBe(200)
    search(dialog, 'slap bass bank 7')
    // "Bank 7", "Bank 70".."Bank 79", "Bank 7xx" — every term must match.
    expect(results().map(row => row.querySelector('.lib-counts').textContent.split(' · ')[0])).toContain('Bank 7')
    search(dialog, 'nothing here')
    expect(results().length).toBe(0)
  })

  it('marks presets that are already imported and re-arms instead of reconverting', async () => {
    const { dialog, deps } = setup({ banks: manyBanks(1), packs: [installed('bank0', ['sf2-1'])] })
    await dialog.rescan()
    expect(results().map(row => row.querySelector('.lib-state').textContent)).toEqual(['', 'imported', ''])
    results()[1].click()
    await Promise.resolve()
    expect(deps.importPreset).not.toHaveBeenCalled()
    expect(deps.armPack).toHaveBeenCalledWith('bank0', '1.0.0', 'sf2-1')
  })

  it('imports the phdr index the row was built from, not its position on screen', async () => {
    const banks = [
      bank('zz-last.sf2', 'Zed Bank', [preset('Piano', 0), preset('Organ', 16), preset('Choir Aahs', 52)]),
      bank('aa-first.sf2', 'Alpha Bank', [preset('Choir Aahs', 52)])
    ]
    const { dialog, deps } = setup({ banks })
    await dialog.rescan()
    search(dialog, 'choir')
    const rows = results()
    expect(rows.length).toBe(2)
    rows[0].click()
    await Promise.resolve()
    // Row 0 is the third preset of the first bank: filtering must not reindex it.
    expect(deps.importPreset).toHaveBeenCalledWith('folder/zz-last.sf2', 2, expect.any(Function))
    rows[1].click()
    await Promise.resolve()
    expect(deps.importPreset).toHaveBeenLastCalledWith('folder/aa-first.sf2', 0, expect.any(Function))
  })

  it('arms what it imported', async () => {
    const { dialog, deps } = setup({ banks: manyBanks(1) })
    await dialog.rescan()
    results()[2].click()
    await new Promise(done => setTimeout(done, 0))
    expect(deps.armPack).toHaveBeenCalledWith('bank0', '1.0.0', 'sf2-2')
  })

  it('adds, removes and rescans folders', async () => {
    const { dialog, lib } = setup({ banks: manyBanks(1) })
    await dialog.rescan()
    document.getElementById('lib-add-folder').click()
    await new Promise(done => setTimeout(done, 0))
    expect(lib.addFolder).toHaveBeenCalled()
    expect(lib.scan).toHaveBeenCalledTimes(2)
    document.querySelector('#lib-folders .lib-remove').click()
    await new Promise(done => setTimeout(done, 0))
    expect(lib.removeFolder).toHaveBeenCalledWith('folder')
  })

  it('offers GRANT for a folder whose permission lapsed', async () => {
    const { dialog, lib } = setup({ banks: [], folders: [{ id: 'folder', name: 'Packs', granted: false }] })
    await dialog.rescan()
    const buttons = [...document.querySelectorAll('#lib-folders button')].map(node => node.textContent)
    expect(buttons).toEqual(['GRANT', 'REMOVE'])
    document.querySelector('#lib-folders button').click()
    await new Promise(done => setTimeout(done, 0))
    expect(lib.requestAccess).toHaveBeenCalledWith('folder')
  })

  it('debounces typing rather than filtering per keystroke', async () => {
    const { dialog } = setup({ banks: manyBanks(1) })
    await dialog.rescan()
    dialog.searchEl.value = 'warm'
    dialog.searchEl.dispatchEvent(new Event('input'))
    expect(results().length).toBe(3)      // not yet filtered
    await new Promise(done => setTimeout(done, 200))
    expect(results().length).toBe(1)
  })
})

describe('LibraryDialog discovery', () => {
  const candidate = { assetName: 'Soul Vocal', sourceUrl: 'https://freesound.org/soul', creator: 'Ada', sourceId: 'freesound', evidence: [{ url: 'https://freesound.org/soul' }], fitNote: 'Fits hard house.' }

  it('does not render discovery controls without a trusted API', () => {
    setup()
    expect(document.getElementById('lib-discovery')).toBeNull()
  })

  it('keeps local setup available without configured credentials', async () => {
    setup({ discovery: { configure: vi.fn(), available: async () => false } })
    await Promise.resolve()
    expect(document.getElementById('lib-discovery')).not.toBeNull()
    expect(document.getElementById('discovery-run').disabled).toBe(false)
    expect(document.getElementById('discovery-status').textContent).toContain('Local search')
  })

  it('shows web discovery without browser key fields', async () => {
    let emit
    const run = vi.fn(() => 'web-run')
    setup({ discovery: { browser: true, available: async () => true, run, onEvent: listener => { emit = listener }, open: vi.fn() } })
    await Promise.resolve()
    expect(document.getElementById('discovery-freesound-key')).toBeNull()
    expect(document.getElementById('discovery-openai-key')).toBeNull()
    expect(document.getElementById('discovery-status').textContent).toBe('Web search ready.')
    document.getElementById('discovery-query').value = 'soul vocal'
    document.getElementById('discovery-run').click()
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ sources: ['local', 'web'] }))
    emit({ runId: 'web-run', type: 'final', candidates: [candidate] })
    expect(document.getElementById('discovery-status').textContent).toBe('1 sound found.')
  })

  it('finds indexed local presets and imports through the existing path', async () => {
    const saveLead = vi.fn(async () => ({ id: 'lead-1' }))
    const linkLead = vi.fn(async () => {})
    const { dialog, deps } = setup({
      banks: [bank('bank0.sf2', 'House', [preset('Soulful Warm Pad', 89)])],
      discovery: { configure: vi.fn(), available: async () => false, saveLead, linkLead }
    })
    await Promise.resolve()
    document.getElementById('discovery-web').checked = false
    document.getElementById('discovery-query').value = 'soulful warm'
    document.getElementById('discovery-run').click()
    await new Promise(done => setTimeout(done, 0))
    expect(document.querySelector('#discovery-results .lib-name').textContent).toBe('Soulful Warm Pad')
    const local = dialog.candidates[0]
    document.querySelectorAll('#discovery-results button')[1].click()
    await new Promise(done => setTimeout(done, 0))
    expect(saveLead).toHaveBeenCalledWith(expect.objectContaining({ candidate: expect.objectContaining({ kind: 'local-preset' }) }))
    document.querySelector('#discovery-results button').click()
    await new Promise(done => setTimeout(done, 0))
    expect(deps.importPreset).toHaveBeenCalledWith('folder/bank0.sf2', 0, expect.any(Function))
    expect(deps.armPack).toHaveBeenCalledWith('bank0', '1.0.0', 'sf2-0')
    expect(local.handoff).toEqual({ packId: 'bank0', packVersion: '1.0.0', patchId: 'sf2-0' })
    expect(linkLead).toHaveBeenCalledWith('lead-1', local.handoff)
  })

  it('sends transient connection settings and clears keys immediately', async () => {
    let resolve
    const configure = vi.fn(() => new Promise(done => { resolve = done }))
    setup({ discovery: { configure, available: () => true, onEvent: () => {}, run: async () => 'run-1' } })
    document.getElementById('discovery-freesound-key').value = 'freesound-secret'
    document.getElementById('discovery-openai-key').value = 'openai-secret'
    document.getElementById('discovery-openai-model').value = 'test-model'
    document.getElementById('discovery-configure').click()
    expect(configure).toHaveBeenCalledWith({ freesoundToken: 'freesound-secret', openaiKey: 'openai-secret', model: 'test-model' })
    expect(document.getElementById('discovery-freesound-key').value).toBe('')
    expect(document.getElementById('discovery-openai-key').value).toBe('')
    resolve()
    await Promise.resolve()
    expect(document.getElementById('discovery-status').textContent).toBe('Keys stored locally. Search verifies Freesound.')
  })

  it('connects with Ctrl+Enter from a setup input', async () => {
    const configure = vi.fn(async () => {})
    setup({ discovery: { configure, available: () => true, onEvent: () => {}, run: async () => 'run-1' } })
    const input = document.getElementById('discovery-freesound-key')
    input.value = 'freesound-secret'
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }))
    await Promise.resolve()
    expect(configure).toHaveBeenCalledWith(expect.objectContaining({ freesoundToken: 'freesound-secret' }))
    expect(document.getElementById('discovery-configure').getAttribute('aria-keyshortcuts')).toContain('Control+Enter')
  })

  it('renders source-linked candidates and saves only after a click', async () => {
    let emit
    const discovery = {
      configure: vi.fn(), available: vi.fn(async () => true), run: vi.fn(async () => 'run-1'),
      onEvent: vi.fn(listener => { emit = listener }), open: vi.fn(), saveLead: vi.fn()
    }
    const { dialog } = setup({ discovery })
    document.getElementById('discovery-query').value = 'soulful hard house'
    document.getElementById('discovery-run').click()
    await Promise.resolve()
    expect(discovery.run).toHaveBeenCalledWith(expect.objectContaining({ text: 'soulful hard house' }))
    emit({ runId: 'run-1', type: 'candidate', candidate })
    expect(document.querySelector('#discovery-results .lib-name').textContent).toBe('Soul Vocal')
    document.querySelector('#discovery-results button').click()
    expect(discovery.open).toHaveBeenCalledWith(candidate)
    document.querySelectorAll('#discovery-results button')[1].click()
    await vi.waitFor(() => expect(discovery.saveLead).toHaveBeenCalledWith(expect.objectContaining({ candidate })))
    await vi.waitFor(() => expect(document.getElementById('discovery-leads').textContent).toContain('1 saved lead'))
    dialog.cancelDiscovery()
  })

  it('does not leave FIND active when final arrives before run resolves', async () => {
    let emit
    let resolveRun
    const run = vi.fn(() => new Promise(resolve => { resolveRun = resolve }))
    setup({ discovery: {
      configure: vi.fn(), available: () => true, run,
      onEvent: listener => { emit = listener }
    } })
    document.getElementById('discovery-run').click()
    emit({ type: 'final', candidates: [candidate] })
    resolveRun('run-1')
    await Promise.resolve()
    await Promise.resolve()
    expect(document.getElementById('discovery-run').disabled).toBe(false)
    expect(document.getElementById('discovery-status').textContent).toBe('1 sound found.')
  })

  it('cancels an active investigation', () => {
    const cancel = vi.fn()
    const { dialog } = setup({ discovery: { configure: vi.fn(), available: () => true, onEvent: () => {}, run: async () => 'run-1', cancel } })
    document.getElementById('discovery-run').click()
    return Promise.resolve().then(() => {
      dialog.cancelDiscovery()
      expect(cancel).toHaveBeenCalledWith('run-1')
    expect(document.getElementById('discovery-status').textContent).toBe('Search cancelled.')
    })
  })
})

describe('packPatchState', () => {
  const pack = installed('bank0', ['sf2-0'])
  const loaders = { fs: () => 'electron', idb: () => 'indexeddb' }
  const loaderFor = entry => loaders[entry.origin || 'fs']?.() || null

  it('is missing when the pack does not hold the patch', () => {
    expect(packPatchState(pack, 'sf2-9', loaderFor)).toBe('missing')
    expect(packPatchState(null, 'sf2-0', loaderFor)).toBe('missing')
  })

  it('reports a browser-origin pack ready without Electron', () => {
    const noElectron = entry => (entry.origin === 'idb' ? loaders.idb() : null)
    expect(packPatchState(pack, 'sf2-0', noElectron)).toBe('ready')
    expect(packPatchState({ ...pack, origin: 'fs' }, 'sf2-0', noElectron)).toBe('unavailable')
  })
})
