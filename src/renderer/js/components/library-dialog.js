// library-dialog.js — pack administration is a dialog, not a fourth workspace.
// Lists what is installed and imports a local .sf2 (Electron IPC, or a file
// input plus IndexedDB in the browser). Removal is offered only for browser
// packs: the Electron IPC has no delete, and inventing one here would lie.

import { openDialog } from '../ui/dialog.js'

export const LIBRARY_DIALOG_ID = 'library-dialog'

const manifestOf = pack => pack?.manifest || pack

function sampleCount(manifest) {
  const ids = new Set()
  for (const patch of manifest?.patches || []) for (const zone of patch.zones || []) ids.add(zone.sampleId)
  return ids.size
}

const megabytes = bytes => `${(bytes / 1048576).toFixed(bytes < 10485760 ? 1 : 0)} MB`

const PROGRESS = {
  reading: 'Reading file…',
  parsing: 'Converting SoundFont…',
  storing: 'Saving pack…',
  done: 'Imported.'
}

export class LibraryDialog {
  /** deps: { packCatalog(), importPack(onProgress) → Promise, canImport(), removePack(pack)?, usage()? } */
  constructor(deps) {
    this.deps = deps
    this.status = ''
    this.usage = null
    this.el = document.getElementById(LIBRARY_DIALOG_ID)
    if (!this.el) return
    this.listEl = this.el.querySelector('#lib-list')
    this.importBtn = this.el.querySelector('#lib-import-btn')
    this.importBtn.addEventListener('click', () => this.runImport())
  }

  async runImport() {
    this.importBtn.disabled = true
    this.setStatus('Choosing file…')
    try {
      const pack = await this.deps.importPack?.(step => this.setStatus(PROGRESS[step?.stage] || ''))
      this.status = pack ? `Imported ${manifestOf(pack)?.name || pack.id}.` : ''
    } catch (error) {
      this.status = `Import failed: ${error.message}`
    } finally {
      this.importBtn.disabled = false
      this.refreshUsage()
      this.render()
    }
  }

  setStatus(value) {
    this.status = value
    this.render()
  }

  refreshUsage() {
    Promise.resolve(this.deps.usage?.()).then(value => {
      if (!value) return
      this.usage = value
      this.render()
    }).catch(() => {})
  }

  open() {
    if (!this.el || this.el.open) return // showModal throws on an open dialog
    if (!openDialog(LIBRARY_DIALOG_ID)) return
    this.status = ''
    this.refreshUsage()
    this.render()
    this.importBtn.focus()
  }

  render() {
    if (!this.el) return
    const packs = this.deps.packCatalog?.() || []
    const canImport = !!this.deps.canImport?.()
    this.importBtn.disabled = !canImport || this.importBtn.disabled
    this.listEl.innerHTML = ''
    if (this.status) this.listEl.append(this.note(this.status))
    if (!canImport) {
      this.listEl.append(this.note('This browser cannot store instrument packs — IndexedDB is unavailable (private window?). Use the desktop app.'))
      return
    }
    if (!packs.length) {
      this.listEl.append(this.note('No packs installed. + IMPORT .SF2 converts a local SoundFont.'))
      return
    }
    for (const pack of packs) this.listEl.appendChild(this.row(pack))
    if (this.usage?.bytes) this.listEl.append(this.note(`${this.usage.packs} pack(s) · ${megabytes(this.usage.bytes)} stored in this browser.`))
  }

  row(pack) {
    const manifest = manifestOf(pack)
    const row = document.createElement('div')
    row.className = 'lib-row'
    const name = document.createElement('span')
    name.className = 'lib-name'
    name.textContent = `${manifest.name || pack.id} · ${pack.version}`
    const counts = document.createElement('span')
    counts.className = 'lib-counts'
    counts.textContent = [
      `${manifest.patches?.length || 0} patches`,
      `${sampleCount(manifest)} samples`,
      ...(pack.bytes ? [megabytes(pack.bytes)] : [])
    ].join(' · ')
    const licence = document.createElement('span')
    licence.className = 'lib-licence'
    licence.textContent = `${manifest.license?.spdx || 'unknown licence'} · ${manifest.license?.noticeFile || 'no notice'}`
    row.append(name, counts, licence)
    if (pack.origin === 'idb' && this.deps.removePack) {
      const remove = document.createElement('button')
      remove.className = 'midi-btn lib-remove'
      remove.textContent = 'REMOVE'
      remove.addEventListener('click', async () => {
        remove.disabled = true
        try { await this.deps.removePack(pack); this.status = `Removed ${manifest.name || pack.id}.` }
        catch (error) { this.status = `Remove failed: ${error.message}` }
        this.refreshUsage()
        this.render()
      })
      row.append(remove)
    }
    return row
  }

  note(value) {
    const item = document.createElement('p')
    item.className = 'instrument-empty'
    item.textContent = value
    return item
  }
}
