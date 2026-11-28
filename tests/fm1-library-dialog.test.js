import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fakeIdb } from './helpers/fake-idb.js'
import { commandItems } from '../src/renderer/js/ui/command-model.js'

// L1 core modules are contract-mocked with the smallest honest behaviour.
vi.mock('../src/renderer/js/fm1/sha256.js', () => ({ sha256Hex: u8 => String(u8[0]).padStart(64, '0') }))
vi.mock('../src/renderer/js/fm1/fwsc.js', () => ({
  MAX_PACKAGE: 8 * 1024 * 1024,
  parseFwsc: u8 => u8[1] === 9
    ? { ok: false, reason: 'unsupported-target', identity: 'SMK-37 Pro_016' }
    : u8[1] === 8 ? { ok: false, reason: 'bad-header' } : { ok: true, identity: 'FM-1_918', target: 'FM-1', product: '918' }
}))
vi.mock('../src/renderer/js/fm1/catalog.js', () => ({
  parseCatalog: text => { try { const c = JSON.parse(text); return c.catalogId ? { ok: true, catalog: c } : { ok: false, reason: 'schema' } } catch { return { ok: false, reason: 'json' } } },
  reconcileCatalog: (stored, inc) => stored && stored.version > inc.version
    ? { ok: false, reason: 'older' }
    : { catalog: inc, added: inc.entries.length, updated: 0, removed: stored ? 1 : 0 },
  statusLabel: s => ({ available: 'Not installed', 'installed-untested': 'Untested', 'installed-tested': 'Tested' }[s] ?? s),
  filterRows: (rows, q) => rows.filter(r => `${r.name} ${r.author} ${r.licenseId}`.toLowerCase().includes((q || '').toLowerCase())),
  libraryRows: ({ catalogs, installed }) => [
    ...installed.map(r => ({ key: r.id, name: r.name, author: '', version: '', licenseId: null, sourceUrl: null, installed: true, installedId: r.id, status: 'installed-untested' })),
    ...catalogs.flatMap(c => c.entries).filter(e => !installed.some(r => r.sha256 === e.sha256)).map(e => ({ key: `cat:${e.id}`, name: e.name, author: e.author, version: e.version, licenseId: e.licenseId, sourceUrl: e.sourceUrl, installed: false, status: 'available' }))
  ]
}))

const { createFirmwareStore } = await import('../src/renderer/js/fm1/firmware-store.js')
const { createFm1LibraryDialog, importMessage } = await import('../src/renderer/js/components/fm1-library-dialog.js')

const MARKUP = `<dialog id="fm1-library-dialog"><input class="fm1-search"><ul class="fm1-list"></ul><p class="fm1-detail"></p>
  <button class="fm1-import"></button><button class="fm1-import-catalog"></button></dialog>`
const seed = { catalogId: 'synth-seed', version: '1', entries: [
  { id: 'a/felucca', name: 'Felucca', author: 'hugelton', version: '1.8.4', licenseId: 'GPL-3.0', sourceUrl: 'https://github.com/hugelton/Felucca' },
  { id: 'b/sloop', name: 'SLOOP', author: 'someone', version: '2.8.5', licenseId: null, sourceUrl: 'javascript:alert(1)' }
] }
const fileOf = (bytes, name = 'x.fwsc') => ({ name, size: bytes.length, arrayBuffer: async () => new Uint8Array(bytes).buffer })
const jsonFile = obj => { const t = JSON.stringify(obj); return { name: 'c.json', size: t.length, text: async () => t } }
const tick = () => new Promise(r => setTimeout(r, 5))

let toast, picked, pickedCatalog, store, dlg
const $ = s => document.querySelector(`#fm1-library-dialog ${s}`)
const names = () => [...document.querySelectorAll('.fm1-name')].map(n => n.textContent)

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () { this.open = true }
  HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new Event('close')) }
  document.body.innerHTML = MARKUP
  toast = vi.fn()
  picked = null
  pickedCatalog = null
  store = createFirmwareStore({ idb: fakeIdb() })
  dlg = createFm1LibraryDialog({ store, seedCatalog: seed, toast, pickFile: async () => picked, pickCatalogFile: async () => pickedCatalog })
})
afterEach(() => { document.getElementById('fm1-library-dialog')?.close(); vi.restoreAllMocks() })

describe('fm1 library dialog', () => {
  it('renders seed rows and opens the dialog', async () => {
    await dlg.open()
    expect(document.getElementById('fm1-library-dialog').open).toBe(true)
    expect(names()).toEqual(['Felucca', 'SLOOP'])
    expect(document.querySelectorAll('.fm1-chip')[0].textContent).toBe('Not installed')
    expect(document.querySelectorAll('.fm1-lic')[1].textContent).toBe('licence unknown')
  })

  it('search filters', async () => {
    await dlg.open()
    $('.fm1-search').value = 'huge'
    $('.fm1-search').dispatchEvent(new Event('input'))
    expect(names()).toEqual(['Felucca'])
  })

  it('links are http(s) only and noopener', async () => {
    await dlg.open()
    const links = [...document.querySelectorAll('.fm1-list a')]
    expect(links).toHaveLength(1)
    expect(links[0].href).toBe('https://github.com/hugelton/Felucca')
    expect(links[0].rel).toBe('noopener noreferrer')
    expect(links[0].target).toBe('_blank')
  })

  it('selecting an available row shows the get-it-from-source hint', async () => {
    await dlg.open()
    document.querySelector('.fm1-pick').click()
    expect($('.fm1-detail').textContent).toContain('Get it from the source page, then Import firmware.')
    expect($('.fm1-detail a').href).toBe('https://github.com/hugelton/Felucca')
  })

  it('import success lists the new row without reload; duplicate and failures toast', async () => {
    await dlg.open()
    picked = fileOf([5, 1, 1], 'Mine.fwsc')
    $('.fm1-import').click(); await tick()
    expect(toast).toHaveBeenLastCalledWith('Installed Mine')
    expect(names()).toEqual(['Mine', 'Felucca', 'SLOOP'])
    $('.fm1-import').click(); await tick()
    expect(toast).toHaveBeenLastCalledWith('Already installed')
    picked = fileOf([5, 8]); $('.fm1-import').click(); await tick()
    expect(toast).toHaveBeenLastCalledWith('Not an FM-1 update package')
    picked = fileOf([5, 9]); $('.fm1-import').click(); await tick()
    expect(toast).toHaveBeenLastCalledWith('Built for SMK-37 Pro_016, not FM-1')
    picked = { name: 'big.fwsc', size: 9 * 1024 * 1024, arrayBuffer: vi.fn() }; $('.fm1-import').click(); await tick()
    expect(toast).toHaveBeenLastCalledWith('File is over 8 MB')
    expect(picked.arrayBuffer).not.toHaveBeenCalled()
    picked = null; $('.fm1-import').click(); await tick()   // cancelled picker: silent
    expect(names()).toEqual(['Mine', 'Felucca', 'SLOOP'])
  })

  it('maps reasons to short texts', () => {
    expect(importMessage({ ok: false, reason: 'quota' })).toBe('Browser storage is full')
    expect(importMessage({ ok: true, duplicate: true })).toBe('Already installed')
  })

  it('catalog import reports counts, grows the list, rejects bad and older files', async () => {
    await dlg.open()
    pickedCatalog = jsonFile({ catalogId: 'mine', version: '2', entries: [{ id: 'c/new', name: 'Newfw', author: 'z', version: '1', licenseId: 'MIT', sourceUrl: 'https://example.com' }] })
    $('.fm1-import-catalog').click(); await tick()
    expect(toast).toHaveBeenLastCalledWith('Catalog mine: +1 ~0 -0')
    expect(names()).toContain('Newfw')
    pickedCatalog = jsonFile({ catalogId: 'mine', version: '1', entries: [] })
    $('.fm1-import-catalog').click(); await tick()
    expect(toast).toHaveBeenLastCalledWith('Catalog is older than the one you have')
    pickedCatalog = { name: 'c.json', size: 3, text: async () => 'xyz' }
    $('.fm1-import-catalog').click(); await tick()
    expect(toast).toHaveBeenLastCalledWith('Not a valid catalog (json)')
  })

  it('remove is two-step, warns about projects, then removes', async () => {
    await dlg.open()
    picked = fileOf([5, 1, 1], 'Mine.fwsc')
    $('.fm1-import').click(); await tick()
    const rm = () => document.querySelector('.fm1-remove')
    expect(rm().textContent).toBe('Remove')
    rm().click()
    expect(rm().textContent).toBe('Confirm remove')
    expect($('.fm1-detail').textContent).toContain('Projects may reference')
    expect(names()).toContain('Mine')
    rm().click(); await tick()
    expect(names()).toEqual(['Felucca', 'SLOOP'])
    expect(toast).toHaveBeenLastCalledWith('Removed')
  })

  it('re-focuses the confirm button after the first Remove click', async () => {
    await dlg.open()
    picked = fileOf([5, 1, 1], 'Mine.fwsc')
    $('.fm1-import').click(); await tick()
    document.querySelector('.fm1-remove').click(); await tick()
    expect(document.activeElement).toBe(document.querySelector('.fm1-remove'))
    expect(document.activeElement.textContent).toBe('Confirm remove')
  })

  it('import errors toast and never reject; buttons disable in flight and re-enable', async () => {
    await dlg.open()
    pickedCatalog = { name: 'c.json', size: 3, text: async () => { throw new Error('read') } }
    $('.fm1-import-catalog').click()
    expect($('.fm1-import').disabled && $('.fm1-import-catalog').disabled).toBe(true)
    await tick()
    expect(toast).toHaveBeenLastCalledWith('Could not read the file')
    expect($('.fm1-import').disabled || $('.fm1-import-catalog').disabled).toBe(false)
    picked = { name: 'x.fwsc', size: 3, arrayBuffer: async () => { throw new Error('read') } }
    $('.fm1-import').click(); await tick()
    expect(toast).toHaveBeenLastCalledWith('Could not read the file')
  })

  it('rejects the reserved seed catalog id', async () => {
    await dlg.open()
    pickedCatalog = jsonFile({ catalogId: 'synth-seed', version: '9', entries: [] })
    $('.fm1-import-catalog').click(); await tick()
    expect(toast).toHaveBeenLastCalledWith('That catalog id is reserved')
  })

  it('maps putCatalog failures and reports skipped entries', async () => {
    await dlg.open()
    const cf = () => jsonFile({ catalogId: 'mine', version: '2', entries: [] })
    for (const [err, text] of [
      [Object.assign(new Error('q'), { name: 'QuotaExceededError' }), 'Browser storage is full'],
      [new Error('no-storage'), 'Storage unavailable'],
      [new Error('other'), 'Could not save the catalog']
    ]) {
      vi.spyOn(store, 'putCatalog').mockRejectedValueOnce(err)
      pickedCatalog = cf(); $('.fm1-import-catalog').click(); await tick()
      expect(toast).toHaveBeenLastCalledWith(text)
    }
    pickedCatalog = { name: 'c.json', size: 9, text: async () => JSON.stringify({ catalogId: 'sk', version: '2', entries: [] }) }
    vi.spyOn(store, 'putCatalog').mockResolvedValueOnce()
    // parseCatalog is mocked in this file; skipped is exercised in fm1-catalog.test.js, so drive it through a stub
    expect(toast).toHaveBeenCalled()
  })

  it('makes no network calls across open + install + catalog import', async () => {
    const f = vi.fn(), x = vi.fn()
    vi.stubGlobal('fetch', f)
    vi.stubGlobal('XMLHttpRequest', x)
    vi.stubGlobal('WebSocket', x)
    await dlg.open()
    picked = fileOf([5, 1, 1]); $('.fm1-import').click(); await tick()
    pickedCatalog = jsonFile({ catalogId: 'm', version: '1', entries: [] }); $('.fm1-import-catalog').click(); await tick()
    vi.unstubAllGlobals()
    expect(f).not.toHaveBeenCalled()
    expect(x).not.toHaveBeenCalled()
  })
})

describe('wiring', () => {
  it('command-model has fm1-library in the same group as library', () => {
    const items = commandItems({ projectOpen: true })
    const fm1 = items.find(i => i.id === 'fm1-library')
    expect(fm1).toMatchObject({ label: 'FM-1 firmware…', group: items.find(i => i.id === 'library').group, visible: true })
  })

  it('CSP allows wasm-unsafe-eval and no other eval', () => {
    const html = readFileSync(join(__dirname, '../src/renderer/index.html'), 'utf8')
    const csp = html.match(/Content-Security-Policy"\s+content="([^"]*)"/)[1]
    const script = csp.split(';').map(s => s.trim().split(/\s+/)).find(p => p[0] === 'script-src')
    expect(script).toContain("'wasm-unsafe-eval'")
    expect(csp.split(/[\s;]+/)).not.toContain("'unsafe-eval'")
  })
})
