// fm1-library-dialog.js — the FM-1 firmware library: installed packages plus the
// catalog (seed + imported). Nothing here touches the network; source URLs are
// links the user may follow, firmware arrives only through "Import firmware…".

import { openDialog } from '../ui/dialog.js'
import { MAX_PACKAGE } from '../fm1/fwsc.js'
import { parseCatalog, reconcileCatalog, libraryRows, filterRows, statusLabel } from '../fm1/catalog.js'

export const FM1_LIBRARY_DIALOG_ID = 'fm1-library-dialog'
const MAX_ROWS = 200
const MAX_CATALOG_BYTES = 2 * 1024 * 1024

export const importMessage = r => {
  if (r.ok) return r.duplicate ? 'Already installed' : `Installed ${r.record?.name ?? 'firmware'}`
  switch (r.reason) {
    case 'too-large': return 'File is over 8 MB'
    case 'unsupported-target': return `Built for ${r.identity ?? 'another device'}, not FM-1`
    case 'quota': return 'Browser storage is full'
    case 'no-storage': return 'Browser storage is unavailable'
    case 'storage-error': return 'Could not save the firmware'
    default: return 'Not an FM-1 update package'
  }
}

const httpUrl = value => {
  try { return /^https?:$/.test(new URL(value).protocol) ? value : null } catch { return null }
}

const el = (tag, cls, text) => {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text != null) e.textContent = text
  return e
}

function link(url, label = 'Source') {
  const href = httpUrl(url)
  if (!href) return null
  const a = el('a', 'fm1-link', label)
  a.href = href
  a.target = '_blank'
  a.rel = 'noopener noreferrer'
  return a
}

export function createFm1LibraryDialog({ root = document, store, seedCatalog, toast = () => {}, pickFile, pickCatalogFile } = {}) {
  const $ = sel => root.querySelector(`#${FM1_LIBRARY_DIALOG_ID} ${sel}`)
  const search = $('.fm1-search'), list = $('.fm1-list'), detail = $('.fm1-detail')
  const importBtn = $('.fm1-import'), catalogBtn = $('.fm1-import-catalog')
  let installed = [], catalogs = [], selected = null, confirming = null

  const rows = () => filterRows(libraryRows({ catalogs: [...catalogs, seedCatalog], installed }), search.value)

  function renderDetail(all) {
    detail.replaceChildren()
    const row = all.find(r => r.key === selected)
    if (confirming && row?.key === confirming) {
      detail.append(el('span', null, 'Projects may reference this firmware. Remove it anyway?'))
    } else if (row && !row.installed) {
      detail.append(el('span', null, 'Get it from the source page, then Import firmware. '))
      const a = link(row.sourceUrl)
      if (a) detail.append(a)
    }
  }

  function render() {
    const all = rows()
    list.replaceChildren()
    for (const r of all.slice(0, MAX_ROWS)) {
      const li = el('li', 'fm1-row')
      li.dataset.key = r.key
      li.dataset.status = r.status
      if (r.key === selected) li.classList.add('selected')
      const main = el('button', 'fm1-pick')
      main.type = 'button'
      main.append(el('span', 'fm1-name', r.name), el('span', 'fm1-meta', [r.author, r.version].filter(Boolean).join(' · ')))
      main.addEventListener('click', () => { selected = r.key; confirming = null; render() })
      li.append(main, el('span', 'fm1-chip', statusLabel(r.status)), el('span', 'fm1-lic', r.licenseId || 'licence unknown'))
      const a = link(r.sourceUrl)
      if (a) li.append(a)
      if (r.installed && r.installedId) {
        const rm = el('button', 'btn fm1-remove', confirming === r.key ? 'Confirm remove' : 'Remove')
        rm.type = 'button'
        rm.addEventListener('click', () => remove(r))
        li.append(rm)
      }
      list.append(li)
    }
    if (all.length > MAX_ROWS) list.append(el('li', 'fm1-more', `${all.length - MAX_ROWS} more — refine the search`))
    renderDetail(all)
  }

  async function refresh() {
    try { [installed, catalogs] = await Promise.all([store.list(), store.getCatalogs()]) } catch { toast('Could not read the firmware library') }
    render()
  }

  async function remove(r) {
    if (confirming !== r.key) { selected = confirming = r.key; return render() }
    confirming = null
    try { await store.remove(r.installedId); toast('Removed') } catch { toast('Could not remove the firmware') }
    await refresh()
  }

  async function importFirmware() {
    const file = await pickFile()
    if (!file) return
    if (file.size > MAX_PACKAGE) return toast(importMessage({ ok: false, reason: 'too-large' }))
    toast(importMessage(await store.install({ name: file.name, bytes: await file.arrayBuffer() })))
    await refresh()
  }

  async function importCatalog() {
    const file = await pickCatalogFile()
    if (!file) return
    if (file.size > MAX_CATALOG_BYTES) return toast('Catalog is over 2 MB')
    const parsed = parseCatalog(await file.text())
    if (!parsed.ok) return toast(`Not a valid catalog (${parsed.reason})`)
    const stored = catalogs.find(c => c.catalogId === parsed.catalog.catalogId) ?? null
    const r = reconcileCatalog(stored, parsed.catalog)
    if (r.ok === false) return toast(r.reason === 'older' ? 'Catalog is older than the one you have' : `Catalog rejected (${r.reason})`)
    try { await store.putCatalog(r.catalog) } catch { return toast('Browser storage is full') }
    toast(`Catalog ${r.catalog.catalogId}: +${r.added} ~${r.updated} -${r.removed}`)
    await refresh()
  }

  search.addEventListener('input', render)
  importBtn.addEventListener('click', importFirmware)
  catalogBtn.addEventListener('click', importCatalog)

  return {
    async open() {
      selected = confirming = null
      await refresh()
      openDialog(FM1_LIBRARY_DIALOG_ID)
    },
    refresh
  }
}
