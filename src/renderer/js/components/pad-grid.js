// pad-grid.js — 8 pads × 2 banks of GM percussion, mirroring the K25.
// Pads are *input*, not a drum kit: a press is a note number, handed to the
// caller exactly like an on-screen key. Which sound it makes is the armed
// instrument's business. The note table is instruments/pad-map.js.

import { padBank } from '../instruments/pad-map.js'

const FLASH_MS = 120

export class PadGrid {
  /**
   * @param {HTMLElement} container   the pad grid host
   * @param {object} deps
   *  bankEl        host for the A/B toggle
   *  onPad(note, on)   press / release
   *  isPlayable(note)  false → the pad renders unlit and does nothing
   */
  constructor(container, { bankEl, onPad, isPlayable } = {}) {
    this.container = container
    this.bankEl = bankEl
    this.onPad = onPad || (() => {})
    this.isPlayable = isPlayable || (() => true)
    this.bank = 'A'
    this.els = new Map()   // slot → button
    this.held = new Set()  // slot
    this.timers = new Map()
    // A pointer released anywhere still ends the note it started.
    this._release = () => this.releaseAll()
    window.addEventListener('pointerup', this._release)
    window.addEventListener('pointercancel', this._release)
    this.renderBanks()
    this.render()
  }

  setBank(bank) {
    if (bank === this.bank) return
    this.releaseAll()
    this.bank = bank
    this.renderBanks()
    this.render()
  }

  renderBanks() {
    if (!this.bankEl) return
    this.bankEl.innerHTML = ''
    for (const bank of ['A', 'B']) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'pad-bank pad-bank-' + bank.toLowerCase()
      btn.textContent = bank
      btn.setAttribute('aria-pressed', bank === this.bank ? 'true' : 'false')
      btn.setAttribute('aria-label', 'Pad bank ' + bank)
      btn.addEventListener('click', () => this.setBank(bank))
      this.bankEl.appendChild(btn)
    }
  }

  render() {
    if (!this.container) return
    // The first pad press of an empty project provisions a track, which calls
    // back in here — swapping the element out mid-press would strand its
    // note-off. Redraw when the hand comes off instead.
    if (this.held.size) { this.pending = true; return }
    this.pending = false
    this.container.innerHTML = ''
    this.container.dataset.bank = this.bank
    this.els.clear()

    for (const pad of padBank(this.bank)) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'drum-pad'
      btn.dataset.slot = pad.slot
      btn.dataset.note = pad.note
      const playable = !!this.isPlayable(pad.note)
      btn.disabled = !playable
      btn.classList.toggle('pad-off', !playable)
      btn.setAttribute('aria-label', pad.label + ' — note ' + pad.note)

      const label = document.createElement('span')
      label.className = 'drum-pad-label'
      label.textContent = pad.label

      const kbd = document.createElement('span')
      kbd.className = 'drum-pad-key'
      kbd.textContent = pad.key

      btn.append(label, kbd)
      btn.addEventListener('pointerdown', e => { e.preventDefault(); this.press(pad.slot) })
      btn.addEventListener('pointerup', () => this.release(pad.slot))
      // Space/Enter on a focused pad is a pad hit, not the global transport.
      btn.addEventListener('keydown', e => {
        if (e.key !== ' ' && e.key !== 'Enter') return
        e.preventDefault(); e.stopPropagation()
        if (!e.repeat) this.press(pad.slot)
      })
      btn.addEventListener('keyup', e => {
        if (e.key === ' ' || e.key === 'Enter') this.release(pad.slot)
      })

      this.container.appendChild(btn)
      this.els.set(pad.slot, btn)
    }
  }

  noteAt(slot) {
    const el = this.els.get(slot)
    return el && !el.disabled ? Number(el.dataset.note) : null
  }

  press(slot) {
    const note = this.noteAt(slot)
    if (note === null || this.held.has(slot)) return
    this.held.add(slot)
    this.els.get(slot)?.classList.add('active')
    this.onPad(note, true)
  }

  release(slot) {
    const note = this.noteAt(slot)
    if (note === null || !this.held.delete(slot)) return
    this.els.get(slot)?.classList.remove('active')
    this.onPad(note, false)
    if (this.pending && !this.held.size) this.render()
  }

  releaseAll() {
    for (const slot of [...this.held]) this.release(slot)
  }

  /** PC keys 1–8: a momentary hit, since a key-up may land in another context. */
  trigger(slot) {
    if (this.noteAt(slot) === null) return
    clearTimeout(this.timers.get(slot))
    this.release(slot)
    this.press(slot)
    this.timers.set(slot, setTimeout(() => this.release(slot), FLASH_MS))
  }

  destroy() {
    this.releaseAll()
    for (const timer of this.timers.values()) clearTimeout(timer)
    window.removeEventListener('pointerup', this._release)
    window.removeEventListener('pointercancel', this._release)
  }
}
