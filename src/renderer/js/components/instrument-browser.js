// instrument-browser.js — the one instrument picker. A momentary <dialog>:
// it takes the screen, assigns to the armed track and gives the screen back.
// Ranking and flattening live in instruments/patch-index.js; this file is glue.

import { buildIndex, searchIndex } from '../instruments/patch-index.js'
import { openDialog, closeDialog } from '../ui/dialog.js'
import { SetTrackInstrument } from '../store/ProjectStore.js'

export const BROWSER_DIALOG_ID = 'instrument-browser-dialog'

const FAV_KEY = 'synth_instrumentFavourites'
const RECENT_KEY = 'synth_instrumentRecent'
const RECENT_MAX = 12
const MAX_ROWS = 200      // a converted SoundFont is hundreds of patches deep
const AUDITION_DEBOUNCE = 120

// Session conveniences only — never project state, and never allowed to throw
// (Electron file:// and private-mode browsers both refuse localStorage).
function readList(key) {
  try { const raw = JSON.parse(localStorage.getItem(key)); return Array.isArray(raw) ? raw : [] }
  catch (err) { return [] }
}
function writeList(key, list) {
  try { localStorage.setItem(key, JSON.stringify(list)) } catch (err) {}
}

const SCOPES = [
  { id: 'all',     label: 'ALL',      scope: 'all' },
  { id: 'pack',    label: 'PACKS',    scope: 'pack' },
  { id: 'palette', label: 'INTERNAL', scope: 'palette' },
  { id: 'rack',    label: 'RACKS',    scope: 'rack' },
  { id: 'fav',     label: '♥',        scope: 'all', only: 'fav' },
  { id: 'recent',  label: 'RECENT',   scope: 'all', only: 'recent' },
]

export class InstrumentBrowser {
  /**
   * @param {object} deps
   *  store           ProjectStore
   *  packCatalog()   compiled pack list
   *  palettes()      selectable palettes, keyed by paletteKey
   *  racks()         state.racks
   *  auditioner      createAuditioner(...) result
   *  ensureTrack()   armed MIDI track, auto-provisioned if the project has none
   *  addTrack()      new armed MIDI track
   *  packState(instrument) → 'ready' | 'unavailable' | 'missing'
   *  openSettings(trackId)
   */
  constructor(deps) {
    this.deps = deps
    this.scopeIndex = 0
    this.highlight = 0
    this.rows = []
    this.timer = null
    this.favourites = readList(FAV_KEY)
    this.recent = readList(RECENT_KEY)

    this.el = document.getElementById(BROWSER_DIALOG_ID)
    if (!this.el) return
    this.search = this.el.querySelector('#ib-search')
    this.chips = this.el.querySelector('#ib-scopes')
    this.list = this.el.querySelector('#ib-list')

    for (const [i, scope] of SCOPES.entries()) {
      const chip = document.createElement('button')
      chip.type = 'button'
      chip.className = 'ib-chip'
      chip.textContent = scope.label
      chip.onclick = () => { this.scopeIndex = i; this.refresh() }
      this.chips.appendChild(chip)
    }

    this.el.querySelector('#ib-settings-btn')?.addEventListener('click', () => {
      const track = this.deps.ensureTrack?.()
      this.stopAudition()
      closeDialog(BROWSER_DIALOG_ID)
      if (track) this.deps.openSettings?.(track.id)
    })
    this.search.addEventListener('input', () => this.refresh())
    this.el.addEventListener('keydown', event => this.onKeyDown(event))
  }

  open() {
    if (!this.el || this.el.open) return // showModal throws on an open dialog
    this.favourites = readList(FAV_KEY)
    this.recent = readList(RECENT_KEY)
    const opened = openDialog(BROWSER_DIALOG_ID, { onClose: () => this.stopAudition() })
    if (!opened) return
    this.search.value = ''
    this.highlight = 0
    this.refresh()
    this.search.focus()
  }

  stopAudition() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    this.deps.auditioner?.stop()
  }

  index() {
    return buildIndex({
      packs: this.deps.packCatalog?.() || [],
      palettes: this.deps.palettes?.() || {},
      racks: this.deps.racks?.() || {},
    })
  }

  refresh() {
    if (!this.el?.open) return
    const scope = SCOPES[this.scopeIndex]
    let rows = searchIndex(this.index(), this.search.value, {
      scope: scope.scope,
      favourites: this.favourites,
      recent: this.recent,
    })
    if (scope.only === 'fav') rows = rows.filter(row => this.favourites.includes(row.key))
    if (scope.only === 'recent') rows = rows.filter(row => this.recent.includes(row.key))
    this.rows = rows
    if (this.highlight >= rows.length) this.highlight = Math.max(0, rows.length - 1)
    this.render()
  }

  render() {
    const chips = this.chips.querySelectorAll('.ib-chip')
    chips.forEach((chip, i) => chip.setAttribute('aria-pressed', String(i === this.scopeIndex)))
    this.list.innerHTML = ''
    if (!this.rows.length) {
      const empty = document.createElement('p')
      empty.className = 'instrument-empty'
      empty.textContent = 'Nothing matches. Ctrl+L imports a pack.'
      this.list.appendChild(empty)
      return
    }
    for (const [i, row] of this.rows.slice(0, MAX_ROWS).entries()) {
      this.list.appendChild(this.renderRow(row, i))
    }
    if (this.rows.length > MAX_ROWS) {
      const more = document.createElement('p')
      more.className = 'instrument-empty'
      more.textContent = `…and ${this.rows.length - MAX_ROWS} more. Keep typing.`
      this.list.appendChild(more)
    }
    this.paintHighlight()
  }

  paintHighlight() {
    const items = [...this.list.querySelectorAll('.ib-row')]
    items.forEach((item, i) => {
      item.classList.toggle('active', i === this.highlight)
      item.setAttribute('aria-selected', String(i === this.highlight))
    })
    items[this.highlight]?.scrollIntoView?.({ block: 'nearest' })
  }

  renderRow(row, i) {
    const item = document.createElement('div')
    item.className = 'ib-row' + (i === this.highlight ? ' active' : '')
    item.setAttribute('role', 'option')
    item.setAttribute('aria-selected', String(i === this.highlight))

    const fav = document.createElement('button')
    fav.type = 'button'
    fav.className = 'ib-fav' + (this.favourites.includes(row.key) ? ' on' : '')
    fav.textContent = '♥'
    fav.title = 'Favourite (Ctrl+D)'
    fav.setAttribute('aria-label', `Favourite ${row.label}`)
    fav.onclick = event => { event.stopPropagation(); this.toggleFavourite(row) }

    const label = document.createElement('span')
    label.className = 'ib-label'
    label.textContent = row.label

    const sub = document.createElement('span')
    sub.className = 'ib-sub'
    sub.textContent = row.sub || ''

    const program = document.createElement('span')
    program.className = 'ib-program'
    program.textContent = row.program == null ? '—' : String(row.program).padStart(3, '0')

    const state = document.createElement('span')
    const status = row.kind === 'pack' ? (this.deps.packState?.(row.instrument) || 'ready') : 'ready'
    state.className = `ib-state ${status}`
    state.textContent = status === 'ready' ? '● loaded' : status === 'missing' ? '○ missing' : '○ no audio'

    item.append(fav, label, sub, program, state)
    item.onclick = () => { this.highlight = i; this.paintHighlight(); this.queueAudition() }
    item.ondblclick = () => this.assign(row, false)
    return item
  }

  toggleFavourite(row) {
    this.favourites = this.favourites.includes(row.key)
      ? this.favourites.filter(key => key !== row.key)
      : [row.key, ...this.favourites]
    writeList(FAV_KEY, this.favourites)
    this.render()
  }

  queueAudition() {
    if (this.timer) clearTimeout(this.timer)
    const row = this.rows[this.highlight]
    if (!row) return
    this.timer = setTimeout(() => { this.timer = null; this.deps.auditioner?.play(row.instrument) }, AUDITION_DEBOUNCE)
  }

  move(delta) {
    if (!this.rows.length) return
    this.highlight = Math.min(Math.max(this.highlight + delta, 0), Math.min(this.rows.length, MAX_ROWS) - 1)
    this.paintHighlight()
    this.queueAudition()
  }

  assign(row, newTrack) {
    if (!row) return
    const track = newTrack ? this.deps.addTrack?.() : this.deps.ensureTrack?.()
    if (track) this.deps.store.dispatch(SetTrackInstrument(track.id, row.instrument))
    this.recent = [row.key, ...this.recent.filter(key => key !== row.key)].slice(0, RECENT_MAX)
    writeList(RECENT_KEY, this.recent)
    this.stopAudition()
    closeDialog(BROWSER_DIALOG_ID)
  }

  onKeyDown(event) {
    const row = this.rows[this.highlight]
    if (event.key === 'ArrowDown') { event.preventDefault(); this.move(1) }
    else if (event.key === 'ArrowUp') { event.preventDefault(); this.move(-1) }
    else if (event.key === 'Tab') {
      event.preventDefault()
      this.scopeIndex = (this.scopeIndex + (event.shiftKey ? SCOPES.length - 1 : 1)) % SCOPES.length
      this.refresh()
    }
    else if (event.key === 'Enter') { event.preventDefault(); this.assign(row, event.shiftKey) }
    else if (event.key === 'd' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); if (row) this.toggleFavourite(row) }
    else if (event.key === 'Escape') this.stopAudition() // the dialog closes itself
  }
}
