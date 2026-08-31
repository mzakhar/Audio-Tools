// library-dialog.js — pack administration is a dialog, not a fourth workspace.
// Lists what is installed and imports a local .sf2 (Electron IPC, or a file
// input plus IndexedDB in the browser). Removal is offered only for browser
// packs: the Electron IPC has no delete, and inventing one here would lie.
//
// It also browses registered SoundFont folders: ~500 banks × ~150 presets is
// 81k rows, so the search filters and renders the first 200 and stops there —
// no virtualization until a real list is slow (specs/soundfont-library.md).

import { openDialog } from '../ui/dialog.js'
import { packIdForBank } from '../../../shared/sf2-index.js'

export const LIBRARY_DIALOG_ID = 'library-dialog'

const manifestOf = pack => pack?.manifest || pack

function sampleCount(manifest) {
  const ids = new Set()
  for (const patch of manifest?.patches || []) for (const zone of patch.zones || []) ids.add(zone.sampleId)
  return ids.size
}

const megabytes = bytes => `${(bytes / 1048576).toFixed(bytes < 10485760 ? 1 : 0)} MB`

/** Render ceiling. Search stops scanning here too, so the work stays proportional. */
const MAX_ROWS = 200
const SEARCH_DEBOUNCE = 120

/** One row per preset, flat. Position in `bank.presets` IS the phdr index and
 *  the id the importer needs — never sort or filter that array. */
function presetRows(banks) {
  const rows = []
  for (const bank of banks || []) {
    const packId = packIdForBank(bank.fileName || '')
    bank.presets?.forEach((preset, presetIndex) => {
      const author = bank.info?.author || ''
      rows.push({
        path: bank.path,
        presetIndex,
        packId,
        patchId: `sf2-${presetIndex}`,
        name: preset.name,
        title: bank.title,
        author,
        program: preset.program,
        drums: preset.bank === 128,
        hay: `${preset.name} ${bank.title} ${author}`.toLowerCase()
      })
    })
  }
  return rows
}

const PROGRESS = {
  reading: 'Reading file…',
  parsing: 'Converting SoundFont…',
  storing: 'Saving pack…',
  done: 'Imported.'
}

export class LibraryDialog {
  /** deps: { packCatalog(), importPack(onProgress) → Promise, canImport(), removePack(pack)?, usage()?,
   *          folders() → folder library or null, importPreset(path, presetIndex, onProgress), armPack(packId, packVersion, patchId) } */
  constructor(deps) {
    this.deps = deps
    this.discovery = deps.discovery?.() || null
    this.discoveryRun = null
    this.discoveryBrief = null
    this.candidates = []
    this.savedLeads = []
    this.status = ''
    this.usage = null
    this.rows = []          // every indexed preset, in phdr order per bank
    this.folders = []
    this.banks = 0
    this.skipped = 0
    this.scanned = false
    this.el = document.getElementById(LIBRARY_DIALOG_ID)
    if (!this.el) return
    this.listEl = this.el.querySelector('#lib-list')
    this.importBtn = this.el.querySelector('#lib-import-btn')
    this.importBtn.addEventListener('click', () => this.runImport())
    this.setupDiscovery()
    this.browseEl = this.el.querySelector('#lib-browse')
    if (!this.browseEl) return
    // Neither Electron nor showDirectoryPicker (the LAN http route): there is
    // nothing to browse, so the section does not exist rather than sitting dead.
    if (!this.library()) { this.browseEl.hidden = true; return }
    this.browseEl.hidden = false
    this.foldersEl = this.browseEl.querySelector('#lib-folders')
    this.resultsEl = this.browseEl.querySelector('#lib-results')
    this.searchEl = this.browseEl.querySelector('#lib-search')
    this.searchEl.addEventListener('input', () => {
      clearTimeout(this.searchTimer)
      this.searchTimer = setTimeout(() => this.renderResults(), SEARCH_DEBOUNCE)
    })
    this.searchEl.addEventListener('keydown', event => {
      if (event.key === 'Enter') this.resultsEl.querySelector('.lib-preset')?.click()
    })
    this.browseEl.querySelector('#lib-add-folder').addEventListener('click', () => this.addFolder())
    this.browseEl.querySelector('#lib-rescan').addEventListener('click', () => this.rescan())
  }

  library() {
    return this.deps.folders?.() || null
  }

  /** Discovery is absent until a trusted host API exists. No dead controls. */
  setupDiscovery() {
    if (!this.discovery?.configure) return
    const body = this.el.querySelector('.dlg-body')
    if (!body) return
    const section = document.createElement('section')
    section.className = 'lib-browse'
    section.id = 'lib-discovery'
    section.innerHTML = `<h3>FIND SOUNDS</h3>
      <div class="discovery-config"><label>Freesound key <input id="discovery-freesound-key" type="password" autocomplete="off"></label><label>OpenAI key (ranking later) <input id="discovery-openai-key" type="password" autocomplete="off"></label><label>Model <input id="discovery-openai-model" type="text" value="gpt-5.6-luna"></label><button id="discovery-configure" class="midi-btn" type="button" title="Save keys (Ctrl+Enter)" aria-keyshortcuts="Control+Enter Meta+Enter">SAVE KEYS <span aria-hidden="true">CTRL+↵</span></button></div>
      <div class="dlg-row"><label>Role <select id="discovery-role"><option value="sample-loop">Sample / loop</option><option value="drum-pack">Drum pack</option><option value="playable-preset">Playable preset</option></select></label>
      <label>BPM <input id="discovery-tempo-min" type="number" min="20" max="300" placeholder="min" aria-label="Minimum tempo">–<input id="discovery-tempo-max" type="number" min="20" max="300" placeholder="max" aria-label="Maximum tempo"></label></div>
      <div class="dlg-row"><label><input id="discovery-loop" type="checkbox"> Loop</label><label><input id="discovery-vocals" type="checkbox"> Vocals okay</label><label>Budget <select id="discovery-budget"><option value="either">Either</option><option value="free">Free</option><option value="paid">Paid</option></select></label><label><input id="discovery-local" type="checkbox" checked> Local</label><label><input id="discovery-web" type="checkbox" checked> Web</label></div>
      <label class="sr-only" for="discovery-query">What are you looking for?</label><input id="discovery-query" class="lib-search" type="search" placeholder="Soulful hard-house base" aria-label="Sound brief">
      <div class="dlg-row"><button id="discovery-run" class="midi-btn" type="button">FIND</button><button id="discovery-cancel" class="midi-btn" type="button" hidden>CANCEL</button></div>
      <p id="discovery-status" class="instrument-empty" role="status"></p><div id="discovery-results" class="lib-list"></div><div id="discovery-leads" class="lib-list"></div>`
    body.insertBefore(section, this.browseEl || null)
    this.discoveryEl = section
    this.discoveryStatusEl = section.querySelector('#discovery-status')
    this.discoveryResultsEl = section.querySelector('#discovery-results')
    this.discoveryLeadsEl = section.querySelector('#discovery-leads')
    this.discoveryRunBtn = section.querySelector('#discovery-run')
    this.discoveryCancelBtn = section.querySelector('#discovery-cancel')
    this.discoveryConfigureBtn = section.querySelector('#discovery-configure')
    this.discoveryRunBtn.addEventListener('click', () => this.runDiscovery())
    this.discoveryCancelBtn.addEventListener('click', () => this.cancelDiscovery())
    this.discoveryConfigureBtn.addEventListener('click', () => this.configureDiscovery())
    section.addEventListener('keydown', event => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault()
        this.configureDiscovery()
      }
    })
    Promise.resolve(this.discovery.available?.()).then(available => {
      if (available) this.refreshLeads()
      else { this.discoveryRunBtn.disabled = true; this.setDiscoveryStatus('Connect Freesound and OpenAI to search.') }
    }).catch(() => { this.discoveryRunBtn.disabled = true })
  }

  async configureDiscovery() {
    if (!this.discoveryEl) return
    const value = id => this.discoveryEl.querySelector(id).value
    const config = {
      freesoundToken: value('#discovery-freesound-key'),
      openaiKey: value('#discovery-openai-key'),
      model: value('#discovery-openai-model')
    }
    this.discoveryEl.querySelector('#discovery-freesound-key').value = ''
    this.discoveryEl.querySelector('#discovery-openai-key').value = ''
    this.discoveryConfigureBtn.disabled = true
    try {
      await this.discovery.configure(config)
      this.setDiscoveryStatus('Keys stored locally. Search verifies Freesound.')
      this.discoveryRunBtn.disabled = false
      this.refreshLeads()
    } catch {
      this.setDiscoveryStatus('Connection failed.')
    } finally {
      this.discoveryConfigureBtn.disabled = false
    }
  }

  discoveryInput() {
    const value = id => this.discoveryEl.querySelector(id).value
    const checked = id => this.discoveryEl.querySelector(id).checked
    const min = value('#discovery-tempo-min')
    const max = value('#discovery-tempo-max')
    return {
      text: value('#discovery-query'), target: value('#discovery-role'),
      ...(min || max ? { tempo: { min: Number(min), max: Number(max) } } : {}),
      loop: checked('#discovery-loop') ? 'loop' : 'either', vocalsAllowed: checked('#discovery-vocals'), budget: value('#discovery-budget'),
      sources: ['local', 'web'].filter(source => checked(`#discovery-${source}`))
    }
  }

  async runDiscovery() {
    if (!this.discoveryEl || this.discoveryRun) return
    this.subscribeDiscovery()
    this.discoveryStarting = true
    this.discoveryFinished = false
    this.candidates = []
    this.discoveryBrief = this.discoveryInput()
    this.setDiscoveryStatus('Searching…')
    this.renderDiscovery()
    try {
      const runId = await this.discovery.run(this.discoveryBrief)
      this.discoveryStarting = false
      this.discoveryRun = this.discoveryFinished ? null : runId
      this.renderDiscovery()
      return
    } catch (error) {
      this.discoveryStarting = false
      this.setDiscoveryStatus(`Search failed: ${error.message}`)
      this.discoveryRun = null
      this.renderDiscovery()
    }
  }

  cancelDiscovery() {
    this.discovery.cancel?.(this.discoveryRun)
    this.discoveryRun = null
    this.setDiscoveryStatus('Search cancelled.')
    this.renderDiscovery()
  }

  subscribeDiscovery() {
    if (this.unsubscribeDiscovery || !this.discovery?.onEvent) return
    this.unsubscribeDiscovery = this.discovery.onEvent(event => {
      if (this.discoveryStarting || event?.runId === this.discoveryRun) this.onDiscoveryEvent(event)
    })
  }

  async refreshLeads() {
    try { this.savedLeads = await this.discovery.listLeads?.() || []; this.renderDiscovery() } catch {}
  }

  onDiscoveryEvent(event = {}) {
    if (event.type === 'candidate' && event.candidate) this.candidates.push(event.candidate)
    if (event.type === 'final') {
      this.candidates = event.candidates || this.candidates
      this.discoveryFinished = true
      this.discoveryRun = null
      this.setDiscoveryStatus(`${this.candidates.length} sound${this.candidates.length === 1 ? '' : 's'} found.`)
      this.unsubscribeDiscovery?.()
      this.unsubscribeDiscovery = null
    }
    if (event.type === 'error') {
      this.discoveryFinished = true
      this.discoveryRun = null
      this.unsubscribeDiscovery?.()
      this.unsubscribeDiscovery = null
      this.setDiscoveryStatus(`Search failed: ${event.message || 'Unknown error'}`)
    }
    else if (event.type === 'status') this.setDiscoveryStatus(event.message || event.stage || 'Searching…')
    this.renderDiscovery()
  }

  setDiscoveryStatus(value) {
    if (this.discoveryStatusEl) this.discoveryStatusEl.textContent = value
  }

  renderDiscovery() {
    if (!this.discoveryEl) return
    const active = !!this.discoveryRun
    this.discoveryRunBtn.disabled = active
    this.discoveryCancelBtn.hidden = !active
    this.discoveryResultsEl.innerHTML = ''
    for (const candidate of this.candidates.slice(0, 5)) {
      if (!candidate?.assetName || !candidate?.sourceUrl) continue
      this.discoveryResultsEl.append(this.discoveryRow(candidate))
    }
    this.discoveryLeadsEl.innerHTML = ''
    if (this.savedLeads.length) this.discoveryLeadsEl.append(this.note(`${this.savedLeads.length} saved lead${this.savedLeads.length === 1 ? '' : 's'}.`))
  }

  discoveryRow(candidate) {
    const row = document.createElement('div')
    row.className = 'lib-row'
    const name = document.createElement('span')
    name.className = 'lib-name'
    name.textContent = candidate.assetName
    const detail = document.createElement('span')
    detail.className = 'lib-counts'
    detail.textContent = [candidate.creator, candidate.sourceId, candidate.sourceUrl].filter(Boolean).join(' · ')
    row.append(name, detail)
    const note = candidate.fitNote
    if (note) { const fit = document.createElement('span'); fit.className = 'lib-licence'; fit.textContent = note; row.append(fit) }
    const evidence = candidate.evidence?.map(item => item.note || item.title).filter(Boolean).join(' · ')
    if (evidence) { const source = document.createElement('span'); source.className = 'lib-licence'; source.textContent = evidence; row.append(source) }
    const open = document.createElement('button')
    open.className = 'midi-btn lib-remove'; open.type = 'button'; open.textContent = 'OPEN'
    open.addEventListener('click', () => this.discovery.open?.(candidate))
    const save = document.createElement('button')
    save.className = 'midi-btn lib-remove'; save.type = 'button'; save.textContent = 'SAVE LEAD'
    save.hidden = !this.discovery.saveLead
    save.addEventListener('click', async () => {
      save.disabled = true
      try {
        const lead = await this.discovery.saveLead?.({ brief: this.discoveryBrief, candidate })
        if (this.discovery.listLeads) await this.refreshLeads()
        else { this.savedLeads.push(lead || { candidate }); this.renderDiscovery() }
      }
      catch (error) { this.setDiscoveryStatus(`Save failed: ${error.message}`) }
      finally { save.disabled = false }
    })
    row.append(open, save)
    return row
  }

  async addFolder() {
    try {
      const folders = await this.library().addFolder()
      if (!folders) return
      this.folders = folders
      await this.rescan()
    } catch (error) { this.setStatus(`Could not add that folder: ${error.message}`) }
  }

  /** Index every registered folder. Cached rows make a repeat scan near-instant. */
  async rescan() {
    if (!this.library()) return
    this.setStatus('Scanning folders…')
    try {
      const { folders, banks, skipped } = await this.library().scan()
      this.folders = folders
      this.banks = banks.length
      this.skipped = skipped || 0
      this.rows = presetRows(banks)
      this.scanned = true
      this.setStatus('')
    } catch (error) {
      this.setStatus(`Scan failed: ${error.message}`)
    }
  }

  /** Filter, stop at what we render. 81k rows must not be walked in full per keystroke. */
  matches() {
    const terms = (this.searchEl?.value || '').trim().toLowerCase().split(/\s+/).filter(Boolean)
    const found = []
    for (const row of this.rows) {
      if (terms.every(term => row.hay.includes(term))) found.push(row)
      if (found.length >= MAX_ROWS) break
    }
    return found
  }

  /** The installed pack for a row's bank, if that preset was already converted. */
  installed(row) {
    return (this.deps.packCatalog?.() || []).find(pack => pack.id === row.packId && pack.byId?.get(row.patchId)) || null
  }

  /**
   * Import is the audition: there is no preview path. An already-installed
   * preset only re-arms, so a second activation cannot reconvert a 90 MB bank.
   */
  async activate(row, button) {
    const already = this.installed(row)
    if (already) {
      this.deps.armPack?.(already.id, already.version, row.patchId)
      this.setStatus(`Armed ${row.name}.`)
      return
    }
    button.disabled = true
    try {
      const pack = await this.deps.importPreset?.(row.path, row.presetIndex, step => this.setStatus(PROGRESS[step?.stage] || ''))
      if (pack) this.deps.armPack?.(pack.id, pack.version, row.patchId)
      this.status = pack ? `Imported ${row.name}.` : ''
    } catch (error) {
      this.status = `Import failed: ${error.message}`
    } finally {
      button.disabled = false
      this.refreshUsage()
      this.render()
    }
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
    if (this.library() && !this.scanned) this.rescan()
  }

  render() {
    if (!this.el) return
    this.renderBrowse()
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

  renderBrowse() {
    if (!this.resultsEl) return
    this.foldersEl.innerHTML = ''
    for (const folder of this.folders) this.foldersEl.appendChild(this.folderRow(folder))
    if (!this.folders.length) this.foldersEl.append(this.note('No folders registered. + FOLDER indexes a directory of .sf2 banks in place — nothing is copied.'))
    else this.foldersEl.append(this.note(`${this.rows.length} presets in ${this.banks} banks${this.skipped ? ` · ${this.skipped} skipped` : ''}`))
    this.renderResults()
  }

  renderResults() {
    if (!this.resultsEl) return
    const rows = this.matches()
    this.resultsEl.innerHTML = ''
    if (!this.rows.length) return
    if (!rows.length) { this.resultsEl.append(this.note('No preset matches that search.')); return }
    const frame = document.createDocumentFragment()
    for (const row of rows) frame.appendChild(this.presetRow(row))
    this.resultsEl.appendChild(frame)
    if (rows.length >= MAX_ROWS) this.resultsEl.append(this.note(`First ${MAX_ROWS} matches — narrow the search to see the rest.`))
  }

  folderRow(folder) {
    const item = document.createElement('div')
    item.className = 'lib-row'
    const name = document.createElement('span')
    name.className = 'lib-name'
    name.textContent = folder.name
    item.append(name)
    if (!folder.granted) {
      // A reload drops file-system permission; re-asking needs this click.
      const grant = document.createElement('button')
      grant.className = 'midi-btn lib-remove'
      grant.textContent = 'GRANT'
      grant.addEventListener('click', async () => {
        await this.library().requestAccess?.(folder.id)
        await this.rescan()
      })
      item.append(grant)
    }
    const remove = document.createElement('button')
    remove.className = 'midi-btn lib-remove'
    remove.textContent = 'REMOVE'
    remove.addEventListener('click', async () => {
      remove.disabled = true
      try { this.folders = await this.library().removeFolder(folder.id) } catch (error) { this.status = `Remove failed: ${error.message}` }
      await this.rescan()
    })
    item.append(remove)
    return item
  }

  /** A button, so Enter on a focused row imports for free. */
  presetRow(row) {
    const item = document.createElement('button')
    item.className = 'lib-row lib-preset'
    item.type = 'button'
    const name = document.createElement('span')
    name.className = 'lib-name'
    name.textContent = row.name
    const detail = document.createElement('span')
    detail.className = 'lib-counts'
    detail.textContent = [row.title, row.author, row.drums ? 'drums' : `GM ${row.program}`].filter(Boolean).join(' · ')
    const state = document.createElement('span')
    state.className = 'lib-state'
    if (this.installed(row)) state.textContent = 'imported'
    item.append(name, detail, state)
    item.addEventListener('click', () => this.activate(row, item))
    return item
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
