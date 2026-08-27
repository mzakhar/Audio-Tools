// library-dialog.js — pack administration is a dialog, not a fourth workspace.
// Lists what is installed and imports a local .sf2. Removal is not offered:
// the Electron IPC has no delete, and inventing one here would lie.

import { openDialog } from '../ui/dialog.js'

export const LIBRARY_DIALOG_ID = 'library-dialog'

const manifestOf = pack => pack?.manifest || pack

function sampleCount(manifest) {
  const ids = new Set()
  for (const patch of manifest?.patches || []) for (const zone of patch.zones || []) ids.add(zone.sampleId)
  return ids.size
}

export class LibraryDialog {
  /** deps: { packCatalog(), importPack() → Promise, canImport() } */
  constructor(deps) {
    this.deps = deps
    this.el = document.getElementById(LIBRARY_DIALOG_ID)
    if (!this.el) return
    this.listEl = this.el.querySelector('#lib-list')
    this.importBtn = this.el.querySelector('#lib-import-btn')
    this.importBtn.addEventListener('click', async () => {
      this.importBtn.disabled = true
      try { await this.deps.importPack?.() }
      finally { this.importBtn.disabled = false; this.render() }
    })
  }

  open() {
    if (!this.el || this.el.open) return // showModal throws on an open dialog
    if (!openDialog(LIBRARY_DIALOG_ID)) return
    this.render()
    this.importBtn.focus()
  }

  render() {
    const packs = this.deps.packCatalog?.() || []
    this.importBtn.disabled = !this.deps.canImport?.()
    this.listEl.innerHTML = ''
    if (!this.deps.canImport?.()) {
      this.listEl.append(this.note('Instrument packs need the desktop app — this build has no local file access.'))
      return
    }
    if (!packs.length) {
      this.listEl.append(this.note('No packs installed. + IMPORT .SF2 converts a local SoundFont.'))
      return
    }
    for (const pack of packs) {
      const manifest = manifestOf(pack)
      const row = document.createElement('div')
      row.className = 'lib-row'
      const name = document.createElement('span')
      name.className = 'lib-name'
      name.textContent = `${manifest.name || pack.id} · ${pack.version}`
      const counts = document.createElement('span')
      counts.className = 'lib-counts'
      counts.textContent = `${manifest.patches?.length || 0} patches · ${sampleCount(manifest)} samples`
      const licence = document.createElement('span')
      licence.className = 'lib-licence'
      licence.textContent = `${manifest.license?.spdx || 'unknown licence'} · ${manifest.license?.noticeFile || 'no notice'}`
      row.append(name, counts, licence)
      this.listEl.appendChild(row)
    }
  }

  note(value) {
    const item = document.createElement('p')
    item.className = 'instrument-empty'
    item.textContent = value
    return item
  }
}
