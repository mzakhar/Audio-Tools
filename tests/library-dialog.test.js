// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { LibraryDialog, LIBRARY_DIALOG_ID } from '../src/renderer/js/components/library-dialog.js'
import { packPatchState } from '../src/renderer/js/instruments/pack-registry.js'

const MARKUP = `
<dialog id="${LIBRARY_DIALOG_ID}">
  <button id="lib-import-btn"></button>
  <div id="lib-list"></div>
  <div id="lib-browse" hidden>
    <button id="lib-add-folder"></button>
    <button id="lib-rescan"></button>
    <div id="lib-folders"></div>
    <input type="search" id="lib-search">
    <div id="lib-results"></div>
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

function setup({ banks = [], packs = [], folders = [{ id: 'folder', name: 'Packs', granted: true }], library = true } = {}) {
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
    armPack: vi.fn()
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
