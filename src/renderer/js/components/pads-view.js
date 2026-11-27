import ProjectStore, { SetPadsSettings, DEFAULT_PADS } from '../store/ProjectStore.js'
import { snapGroove, SNAP_GRIDS } from '../pads/groove.js'
import { readThemeColors, themeStyle, onThemeChange } from '../ui/theme-colors.js'
import { withAlpha } from './canvas-colors.js'
import { REPEAT_RATES } from '../pads/repeat.js'
import { KNOB_ROLES, knobLabel } from '../pads/knob-roles.js'

const FIRST_NOTE = 36
const BANKS = ['A', 'B', 'C', 'D']
const RATE_KEYS = Object.keys(REPEAT_RATES)
const LADDER_PARAMS = ['velocity', 'tune', 'decay', 'filter']
const OVERLAY_MENUS = ['MUTE', 'BANK', 'RATE', 'LADDER']
const KNOB_LABELS = ['GROOVE', 'RATE', 'TUNE', 'DECAY', 'FILTER', 'LEVEL', 'SNAP', 'BPM']
const KNOB_HELP = [
  'Groove: swing amount for snapping, repeat and the loop.',
  'Repeat rate: how fast held pads retrigger.',
  'Tune: pitch of the selected (last-hit) pad, in semitones.',
  'Decay: length of the selected pad, as a percentage.',
  'Filter: brightness of the selected pad.',
  'Level: volume of the selected pad.',
  'Snap strength: how far recorded hits move to the grid.',
  'BPM: project tempo.',
]
/** Shift + hover/touch help, keyed by data-help. A function sees the view and returns the current role. */
export const HELP = {
  ...Object.fromEntries(KNOB_HELP.map((t, i) => [`knob${i}`, t])),
  repeat: 'Repeat (hold, key G): hold it, then hold a pad to retrigger at the repeat rate. Leave the SMC-PAD\'s own Note Repeat off; Synth does not send MIDI clock.',
  full: 'Full level (toggle, key H): every hit plays at maximum velocity.',
  ladder: v => `Ladder (key L cycles): spreads the last-hit pad over all 16 pads by one parameter. Now: ${v._pads.ladder ?? 'off'}.`,
  rate: 'Repeat rate for Repeat. Also set by the Rate overlay or knob 2.',
  overlay: 'Overlay (hold, key O): while held, pads become a menu and do not sound.',
  overlayMenu: 'Which menu the pads show while Overlay is held: Mute, Bank, Rate or Ladder.',
  learn: 'Learn: map your controller\'s buttons and knobs.',
  layer: 'Layer: record what you play into the loop.',
  wipe: 'Wipe (hold): erase what the playhead passes for the pads you touch.',
  undo: 'Undo the last pass.',
  bank: v => `Bank ${BANKS[v.bank]}: 16 pads per bank, notes ${FIRST_NOTE + 16 * v.bank} to ${FIRST_NOTE + 16 * v.bank + 15}.`,
  pad: v => v.overlay ? `Overlay ${v.overlayMenu}: ${OVERLAY_HELP[v.overlayMenu]}` : 'Pad: plays this slot of the armed kit.',
}
const OVERLAY_HELP = {
  MUTE: 'tap a pad to mute or unmute its loop playback.',
  BANK: 'pads 1-4 pick bank A-D.',
  RATE: 'pads 1-7 pick the repeat rate.',
  LADDER: 'pads 1-4 pick the ladder parameter (tap again for off).',
}
// Rows read top-down 13-16 … 1-4, so pad 1 sits bottom-left like the hardware.
const PAD_ROWS = [[12, 13, 14, 15], [8, 9, 10, 11], [4, 5, 6, 7], [0, 1, 2, 3]]
// Computer-key twins in the same shape; registered by app.js in the 'pads' context.
export const PAD_KEY_ROWS = [['1', '2', '3', '4'], ['q', 'w', 'e', 'r'], ['a', 's', 'd', 'f'], ['z', 'x', 'c', 'v']]
// voice -> --track-N colour slot
const VOICE_TRACK = { bd: 1, sd: 2, rs: 3, cp: 3, ch: 4, oh: 4, lt: 5, mt: 6, ht: 7, cr: 8, rd: 8 }
const STRIP_TOKENS = [
  'canvas-bg', 'canvas-ruler-bg', 'canvas-ruler-ink', 'canvas-grid-bar', 'canvas-grid-beat',
  'canvas-playhead', 'text-dim', 'font-mono', ...Array.from({ length: 8 }, (_, i) => `track-${i + 1}`),
]
const FLASH_MS = 140
const VELOCITY_DEFAULT = 108

const gridKey = value => Object.entries(SNAP_GRIDS)
  .reduce((best, [k, v]) => (Math.abs(v - value) < Math.abs(SNAP_GRIDS[best] - value) ? k : best), '1/16')

/**
 * opts: triggerPad(note, velocity127), getKit() -> kit|null, getNotes() -> notes[],
 * canUndo() -> bool (Undo enabled), getBeat() -> transport beat (<0 count-in, null when stopped), onUndo(), onLayerChange(on),
 * onWipeChange(held).
 */
export class PadsView {
  constructor(container, opts = {}) {
    this.container = container
    this.opts = opts
    this.layer = false
    this.wiping = false
    this.wipePads = new Set()
    this.active = false
    this.playing = false
    this.raf = null
    this._shift = false
    this._shiftHeld = false
    this.bank = 0
    this.repeat = false
    this.overlay = false
    this.overlayMenu = 'MUTE'
    this._selected = null
    this._flashTimers = new Map()
    this._pulseTimers = new Map()
    const state = ProjectStore.getState()
    this._pads = { ...DEFAULT_PADS, ...state.pads }
    this._beatsPerBar = state.timeSignature?.[0] ?? 4
    this._colours = null
    this._unsubTheme = onThemeChange(() => { this._colours = null; this.drawStrip() })
    this._unsub = ProjectStore.subscribe(next => {
      this._pads = { ...DEFAULT_PADS, ...next.pads }
      this._beatsPerBar = next.timeSignature?.[0] ?? 4
      this.sync()
    })
    this._onKey = e => this._key(e)
    document.addEventListener('keydown', this._onKey)
    document.addEventListener('keyup', this._onKey)
    this.render()
  }

  destroy() {
    this.setActive(false)
    this._unsub?.()
    this._unsubTheme?.()
    this._ro?.disconnect()
    document.removeEventListener('keydown', this._onKey)
    document.removeEventListener('keyup', this._onKey)
    for (const id of [...this._flashTimers.values(), ...this._pulseTimers.values()]) clearTimeout(id)
    this._flashTimers.clear()
    this._pulseTimers.clear()
    this.container.innerHTML = ''
  }

  // ─── Public ─────────────────────────────────────────────────────────────
  layerOn() { return this.layer }
  isWiping() { return this.wiping }
  /** Pads touched while Wipe was held (null = none touched, meaning every pad). */
  wipePitches() { return this.wipePads.size ? this.wipePads : null }
  overlayActive() { return this.overlay }
  /** Last-hit note (the knobs' target); first pad of the shown bank until something is hit. */
  selectedNote() { return this._selected ?? this._noteOf(0) }

  /** On-screen/PC-key pad press. Under Overlay it picks a menu item instead of sounding. */
  trigger(padIndex) { this._press(padIndex, VELOCITY_DEFAULT) }

  setBank(bank) {
    const b = Math.min(3, Math.max(0, Math.round(bank) || 0))
    if (b === this.bank) return
    this.bank = b
    this.el.banks.forEach((btn, i) => btn.setAttribute('aria-pressed', String(i === b)))
    this.refreshKit()
  }

  /** Light the twin of a hardware button (play has no twin here). Repeat/overlay also hold their state. */
  pressControl(action, pressed) {
    const btn = this.el[action]
    if (action === 'repeat') this._setRepeat(pressed, false)
    else if (action === 'overlay') this._setOverlay(pressed, false)
    if (btn) btn.toggleAttribute('data-lit', !!pressed)
  }

  /** Pulse a knob twin (hardware turned it). */
  turnKnob(index) {
    const el = this.el.knobs?.[index]
    if (!el) return
    el.dataset.pulse = 'on'
    clearTimeout(this._pulseTimers.get(index))
    this._pulseTimers.set(index, setTimeout(() => delete el.dataset.pulse, FLASH_MS))
    this._syncKnobs()
  }

  /** Hit feedback — from a twin, the PC keys or hardware. Switches bank when the note lives elsewhere. */
  flashPad(note, velocity) {
    if (this.wiping) this.wipePads.add(note)
    const bank = Math.floor((note - FIRST_NOTE) / 16)
    if (bank < 0 || bank > 3) return
    this._selected = note
    if (bank !== this.bank) this.setBank(bank)
    this._syncKnobs()
    const el = this.padEls?.get(note - FIRST_NOTE - 16 * bank)
    if (!el) return
    el.style.setProperty('--flash', String(Math.min(1, Math.max(0.25, velocity / 127))))
    el.dataset.flash = 'on'
    clearTimeout(this._flashTimers.get(note))
    this._flashTimers.set(note, setTimeout(() => {
      el.style.setProperty('--flash', '0')
      delete el.dataset.flash
    }, FLASH_MS))
  }

  /** The view is on screen / the transport is running; the rAF loop needs both. */
  setActive(active) {
    this.active = active
    this._loop()
    if (active) this.refreshKit()
    else { this._setRepeat(false); this._setOverlay(false); this._showHelp(null) }
  }
  setPlaying(playing) { this.playing = playing; this._loop(); this.drawStrip() }

  _noteOf(i) { return FIRST_NOTE + 16 * this.bank + i }
  _slotOf(note) { return this.opts.getKit?.()?.slots?.[note] ?? null }
  _set(patch) { ProjectStore.dispatch(SetPadsSettings(patch)) }

  _press(i, velocity) {
    if (this.overlay) return this._pick(i)
    this.opts.triggerPad?.(this._noteOf(i), velocity)
  }

  /** Overlay menu pick. */
  _pick(i) {
    const p = this._pads
    if (this.overlayMenu === 'MUTE') {
      const note = this._noteOf(i)
      this._set({ muted: p.muted.includes(note) ? p.muted.filter(n => n !== note) : [...p.muted, note] })
    } else if (this.overlayMenu === 'BANK') {
      if (i < BANKS.length) this.setBank(i)
    } else if (this.overlayMenu === 'RATE') {
      if (i < RATE_KEYS.length) this._set({ repeatRate: RATE_KEYS[i] })
    } else if (i < LADDER_PARAMS.length) {
      this._set({ ladder: p.ladder === LADDER_PARAMS[i] ? null : LADDER_PARAMS[i] })
    }
  }

  _setRepeat(held, notify = true) {
    if (this.repeat === held) return
    this.repeat = held
    this.el.repeat.setAttribute('aria-pressed', String(held))
    if (notify) this.opts.onAction?.('repeat', { pressed: held })
  }

  _setOverlay(held, notify = true) {
    if (this.overlay === held) return
    this.overlay = held
    this.el.overlay.setAttribute('aria-pressed', String(held))
    this.container.querySelector('.pads-shell').toggleAttribute('data-overlay', held)
    this.refreshKit()
    if (notify) this.opts.onAction?.('overlay', { pressed: held })
  }

  refreshKit() {
    const p = this._pads
    this.padEls.forEach((el, i) => {
      const note = this._noteOf(i)
      const slot = this._slotOf(note)
      const voice = slot?.voice ?? ''
      let name = voice ? voice.toUpperCase() : '—'
      if (this.overlay) {
        const m = this.overlayMenu
        name = m === 'MUTE' ? name
          : m === 'BANK' ? (BANKS[i] ?? '')
          : m === 'RATE' ? (RATE_KEYS[i] ?? '')
          : (LADDER_PARAMS[i]?.slice(0, 4).toUpperCase() ?? '')
      }
      el.dataset.voice = voice
      el.toggleAttribute('data-empty', !slot)
      el.toggleAttribute('data-muted', p.muted.includes(note))
      el.setAttribute('aria-disabled', slot ? 'false' : 'true')
      el.querySelector('.pads-pad-name').textContent = name
      el.setAttribute('aria-label', `Pad ${i + 1}${voice ? ` ${voice.toUpperCase()}` : ' empty'}${p.muted.includes(note) ? ' muted' : ''}`)
    })
    this.drawStrip()
  }

  // ─── Help (hold Shift, hover or touch) ──────────────────────────────────
  _showHelp(target) {
    const tip = this.el?.help
    if (!tip) return
    const text = target && (() => {
      const h = HELP[target.dataset.help]
      return typeof h === 'function' ? h(this) : h
    })()
    if (!text) { tip.hidden = true; return }
    tip.textContent = text
    tip.hidden = false
    const shell = this.container.querySelector('.pads-shell').getBoundingClientRect()
    const r = target.getBoundingClientRect()
    tip.style.left = `${Math.max(0, Math.min(r.left - shell.left, shell.width - 240))}px`
    tip.style.top = `${r.bottom - shell.top + 6}px`
  }

  _key(e) {
    if (e.key === 'Shift') {
      this._shiftHeld = e.type === 'keydown'
      if (!this._shiftHeld) this._showHelp(null)
      return
    }
    if (!this.active || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return
    if (['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return
    const down = e.type === 'keydown'
    switch (e.key.toLowerCase()) {
      case 'g': this._setRepeat(down); break
      case 'o': this._setOverlay(down); break
      case 'h': if (down) this._set({ full: !this._pads.full }); break
      case 'l': if (down) this._set({ ladder: LADDER_PARAMS[LADDER_PARAMS.indexOf(this._pads.ladder) + 1] ?? (this._pads.ladder ? null : LADDER_PARAMS[0]) }); break
    }
  }

  _knobCtx() {
    const note = this.selectedNote()
    return { pads: this._pads, bpm: this.opts.getBpm?.() ?? 120, slot: this._slotOf(note), note }
  }

  _syncKnobs() {
    if (!this.el?.knobs) return
    const ctx = this._knobCtx()
    this.el.knobs.forEach((k, i) => {
      const text = knobLabel(i, ctx)
      k.querySelector('.pads-knob-out').textContent = text
      k.setAttribute('aria-valuetext', text)
    })
  }

  // ─── DOM ────────────────────────────────────────────────────────────────
  render() {
    const grids = Object.keys(SNAP_GRIDS).map(k => `<option value="${k}">${k}</option>`).join('')
    const pads = PAD_ROWS.map((row, r) => row.map((i, c) =>
      `<button type="button" class="pads-pad" data-pad="${i}" data-help="pad" aria-label="Pad ${i + 1}"><span class="pads-pad-num">${i + 1}</span><span class="pads-pad-name"></span><span class="pads-pad-key">${PAD_KEY_ROWS[r][c].toUpperCase()}</span></button>`
    ).join('')).join('')
    const opt = (v, t = v) => `<option value="${v}">${t}</option>`
    const knobs = KNOB_ROLES.map((_, i) =>
      `<div class="pads-knob" role="slider" tabindex="0" data-knob="${i}" data-help="knob${i}" aria-label="${KNOB_LABELS[i]} knob" aria-valuetext=""><span class="micro-label">${KNOB_LABELS[i]}</span><output class="lcd pads-knob-out"></output></div>`).join('')
    const banks = BANKS.map((b, i) => `<button type="button" class="btn pads-bank" data-help="bank" aria-pressed="${i === 0}" aria-label="Bank ${b}">${b}</button>`).join('')
    this.container.innerHTML = `
      <div class="pads-shell panel">
        <div class="pads-header">
          <span class="micro-label">LOOP</span>
          <output class="lcd pads-pos" aria-label="Loop position">bar 1/2</output>
          <button type="button" class="btn btn--danger pads-layer" data-help="layer" aria-pressed="false" aria-label="Layer (overdub)">● LAYER</button>
          <button type="button" class="btn pads-undo" data-help="undo" aria-label="Undo last pass">UNDO</button>
          <button type="button" class="btn btn--danger pads-wipe" data-help="wipe" aria-pressed="false" aria-label="Wipe (hold, then touch pads)">WIPE</button>
          <button type="button" class="btn btn--toggle pads-metro" aria-pressed="false" aria-label="Metronome">CLICK</button>
          <label class="pads-field"><span class="micro-label">COUNT-IN</span>
            <select class="pads-countin" aria-label="Count-in bars"><option value="0">0</option><option value="1">1</option><option value="2">2</option></select></label>
          <label class="pads-field"><span class="micro-label">BARS</span>
            <select class="pads-bars" aria-label="Loop length in bars">${[1, 2, 4, 8].map(n => `<option value="${n}">${n}</option>`).join('')}</select></label>
        </div>
        <canvas class="pads-strip" aria-label="Loop hits"></canvas>
        <div class="pads-body">
          <div class="pads-left">
            <div class="pads-banks" role="group" aria-label="Pad bank">${banks}</div>
            <div class="pads-grid" role="group" aria-label="Pads">${pads}</div>
          </div>
          <div class="pads-controls">
            <div class="pads-perf">
              <button type="button" class="btn btn--toggle pads-repeat" data-help="repeat" aria-pressed="false" aria-label="Repeat (hold, key G)">REPEAT</button>
              <button type="button" class="btn btn--toggle pads-full" data-help="full" aria-pressed="false" aria-label="Full level (key H)">FULL</button>
              <button type="button" class="btn btn--toggle pads-overlay" data-help="overlay" aria-pressed="false" aria-label="Overlay (hold, key O)">OVERLAY</button>
              <label class="pads-field"><span class="micro-label">MENU</span>
                <select class="pads-overlay-menu" data-help="overlayMenu" aria-label="Overlay menu">${OVERLAY_MENUS.map(m => opt(m)).join('')}</select></label>
              <label class="pads-field"><span class="micro-label">LADDER</span>
                <select class="pads-ladder" data-help="ladder" aria-label="Ladder parameter (key L)">${opt('', 'off')}${LADDER_PARAMS.map(m => opt(m)).join('')}</select></label>
              <label class="pads-field"><span class="micro-label">RATE</span>
                <select class="pads-rate" data-help="rate" aria-label="Repeat rate">${RATE_KEYS.map(m => opt(m)).join('')}</select></label>
              <button type="button" class="btn pads-learn" data-help="learn" aria-label="Controller learn">LEARN</button>
            </div>
            <div class="pads-knobs" role="group" aria-label="Knobs">${knobs}</div>
            <label class="pads-field"><span class="micro-label">GROOVE</span>
              <input type="range" class="pads-groove" min="50" max="75" step="1" aria-label="Groove (swing), Shift for fine">
              <output class="lcd pads-groove-out">50%</output></label>
            <label class="pads-field"><span class="micro-label">SNAP</span>
              <select class="pads-snap" aria-label="Snap grid">${grids}</select></label>
            <label class="pads-field"><span class="micro-label">STRENGTH</span>
              <input type="range" class="pads-strength" min="0" max="100" step="1" aria-label="Snap strength">
              <output class="lcd pads-strength-out">100%</output></label>
          </div>
        </div>
        <div class="pads-help" role="tooltip" hidden></div>
      </div>`
    const $ = sel => this.container.querySelector(sel)
    this.el = {
      pos: $('.pads-pos'), layer: $('.pads-layer'), undo: $('.pads-undo'), wipe: $('.pads-wipe'),
      metro: $('.pads-metro'), countin: $('.pads-countin'), bars: $('.pads-bars'),
      groove: $('.pads-groove'), grooveOut: $('.pads-groove-out'), snap: $('.pads-snap'),
      strength: $('.pads-strength'), strengthOut: $('.pads-strength-out'), strip: $('.pads-strip'),
      repeat: $('.pads-repeat'), full: $('.pads-full'), overlay: $('.pads-overlay'), overlayMenu: $('.pads-overlay-menu'),
      ladder: $('.pads-ladder'), rate: $('.pads-rate'), learn: $('.pads-learn'), help: $('.pads-help'),
      banks: [...this.container.querySelectorAll('.pads-bank')], knobs: [...this.container.querySelectorAll('.pads-knob')],
    }
    this.padEls = new Map([...this.container.querySelectorAll('.pads-pad')].map(el => [Number(el.dataset.pad), el]))
    this._bind()
    this.refreshKit()
    this.sync()
  }

  _bind() {
    const { el } = this
    const set = patch => this._set(patch)

    this.padEls.forEach((pad, i) => {
      pad.addEventListener('pointerdown', e => {
        e.preventDefault()
        this._press(i, VELOCITY_DEFAULT)
      })
      // Focused pad: Enter/Space plays it. stopPropagation keeps the global Space (transport) out.
      pad.addEventListener('keydown', e => {
        if (e.key !== 'Enter' && e.key !== ' ') return
        e.preventDefault()
        e.stopPropagation()
        if (!e.repeat) this._press(i, 100)
      })
    })

    el.layer.addEventListener('click', () => {
      this.layer = !this.layer
      el.layer.setAttribute('aria-pressed', String(this.layer))
      this.opts.onLayerChange?.(this.layer)
    })
    el.undo.addEventListener('click', () => this.opts.onUndo?.())

    const wipe = held => {
      if (this.wiping === held) return
      this.wiping = held
      if (!held) this.wipePads.clear()
      el.wipe.setAttribute('aria-pressed', String(held))
      this.opts.onWipeChange?.(held)
    }
    el.wipe.addEventListener('pointerdown', () => wipe(true))
    for (const type of ['pointerup', 'pointerleave', 'pointercancel', 'blur']) el.wipe.addEventListener(type, () => wipe(false))
    el.wipe.addEventListener('keydown', e => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) wipe(true) })
    el.wipe.addEventListener('keyup', e => { if (e.key === ' ' || e.key === 'Enter') wipe(false) })

    el.metro.addEventListener('click', () => set({ metronome: !this._pads.metronome }))
    el.countin.addEventListener('change', () => set({ countInBars: Number(el.countin.value) }))
    el.bars.addEventListener('change', () => set({ loopBars: Number(el.bars.value) }))
    const shift = e => { this._shift = e.shiftKey }
    el.groove.addEventListener('keydown', shift)
    el.groove.addEventListener('pointerdown', shift)
    // Sliders: readout follows `input`; the store is written once, on `change`.
    el.groove.addEventListener('input', () => { el.grooveOut.textContent = `${Math.round(snapGroove(Number(el.groove.value) / 100, this._shift) * 100)}%` })
    el.groove.addEventListener('change', () => set({ groove: snapGroove(Number(el.groove.value) / 100, this._shift) }))
    el.snap.addEventListener('change', () => set({ snapGrid: SNAP_GRIDS[el.snap.value] }))
    el.strength.addEventListener('input', () => { el.strengthOut.textContent = `${el.strength.value}%` })
    el.strength.addEventListener('change', () => set({ snapStrength: Number(el.strength.value) / 100 }))

    // Hold buttons: pointer + Enter/Space, like Wipe.
    const hold = (btn, fn) => {
      btn.addEventListener('pointerdown', () => fn(true))
      for (const type of ['pointerup', 'pointerleave', 'pointercancel', 'blur']) btn.addEventListener(type, () => fn(false))
      btn.addEventListener('keydown', e => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) fn(true) })
      btn.addEventListener('keyup', e => { if (e.key === ' ' || e.key === 'Enter') fn(false) })
    }
    hold(el.repeat, held => this._setRepeat(held))
    hold(el.overlay, held => this._setOverlay(held))
    el.full.addEventListener('click', () => set({ full: !this._pads.full }))
    el.ladder.addEventListener('change', () => set({ ladder: el.ladder.value || null }))
    el.rate.addEventListener('change', () => set({ repeatRate: el.rate.value }))
    el.overlayMenu.addEventListener('change', () => { this.overlayMenu = el.overlayMenu.value; this.refreshKit() })
    el.learn.addEventListener('click', () => this.opts.onAction?.('learn', {}))
    el.banks.forEach((b, i) => b.addEventListener('click', () => this.setBank(i)))

    // Knob twins: drag vertically (8 px per detent), wheel, arrow keys.
    el.knobs.forEach((k, i) => {
      let lastY = null
      k.addEventListener('pointerdown', e => { lastY = e.clientY; k.setPointerCapture?.(e.pointerId) })
      k.addEventListener('pointermove', e => {
        if (lastY === null) return
        const steps = Math.trunc((lastY - e.clientY) / 8)
        if (!steps) return
        lastY -= steps * 8
        this.opts.onKnob?.(i, steps)
      })
      for (const type of ['pointerup', 'pointercancel']) k.addEventListener(type, () => { lastY = null })
      k.addEventListener('wheel', e => { e.preventDefault(); this.opts.onKnob?.(i, e.deltaY < 0 ? 1 : -1) }, { passive: false })
      k.addEventListener('keydown', e => {
        const d = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 }[e.key]
        if (!d) return
        e.preventDefault()
        this.opts.onKnob?.(i, d)
      })
    })

    // Help tooltip: Shift held while hovering/touching a [data-help] control.
    const helpAt = e => {
      const t = e.target.closest?.('[data-help]')
      if (t && (e.shiftKey || this._shiftHeld)) this._showHelp(t)
    }
    this.container.addEventListener('pointerover', helpAt)
    this.container.addEventListener('pointerdown', helpAt, true)
    this.container.addEventListener('pointerout', () => this._showHelp(null))
    if (typeof ResizeObserver !== 'undefined') {
      this._ro = new ResizeObserver(() => this.drawStrip())
      this._ro.observe(el.strip)
    }
  }

  /** Push store settings into the controls (never rebuilds, so focus survives). */
  sync() {
    const p = this._pads
    const { el } = this
    if (!el) return
    el.metro.setAttribute('aria-pressed', String(!!p.metronome))
    el.countin.value = String(p.countInBars)
    el.bars.value = String(p.loopBars)
    const groove = Math.round(p.groove * 100)
    el.groove.value = String(groove)
    el.grooveOut.textContent = `${groove}%`
    el.snap.value = gridKey(p.snapGrid)
    const strength = Math.round(p.snapStrength * 100)
    el.strength.value = String(strength)
    el.strengthOut.textContent = `${strength}%`
    el.full.setAttribute('aria-pressed', String(!!p.full))
    el.ladder.value = p.ladder ?? ''
    el.rate.value = p.repeatRate
    this._syncKnobs()
    this.refreshKit()
  }

  // ─── Loop strip ─────────────────────────────────────────────────────────
  _loop() {
    const run = this.active && this.playing
    if (run && this.raf === null) {
      const frame = () => {
        this.drawStrip()
        this.raf = this.active && this.playing ? requestAnimationFrame(frame) : null
      }
      this.raf = requestAnimationFrame(frame)
    } else if (!run && this.raf !== null) {
      cancelAnimationFrame(this.raf)
      this.raf = null
    }
  }

  drawStrip() {
    const canvas = this.el?.strip
    if (!canvas) return
    this.el.undo.disabled = !(this.opts.canUndo?.() ?? true)
    const { loopBars } = this._pads
    const bpb = this._beatsPerBar
    const loopBeats = loopBars * bpb
    const beat = this.playing ? (this.opts.getBeat?.() ?? null) : null
    const pos = beat === null ? 0 : ((beat % loopBeats) + loopBeats) % loopBeats
    this.el.pos.textContent = beat !== null && beat < 0
      ? 'count-in'
      : `bar ${Math.floor(pos / bpb) + 1}/${loopBars}`

    const g = canvas.getContext?.('2d')
    if (!g) return // jsdom has no canvas
    const dpr = window.devicePixelRatio || 1
    const w = canvas.clientWidth
    const h = canvas.clientHeight
    if (!w || !h) return
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(h * dpr)
    }
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    const c = (this._colours ??= readThemeColors(STRIP_TOKENS, themeStyle()))
    const ruler = 16
    const x = b => (b / loopBeats) * w
    g.fillStyle = c['canvas-bg']; g.fillRect(0, 0, w, h)
    g.fillStyle = c['canvas-ruler-bg']; g.fillRect(0, 0, w, ruler)
    g.font = `10px ${c['font-mono']}`; g.textBaseline = 'middle'
    for (let b = 0; b < loopBeats; b++) {
      const bar = b % bpb === 0
      g.fillStyle = bar ? c['canvas-grid-bar'] : c['canvas-grid-beat']
      g.fillRect(x(b), bar ? 0 : ruler, 1, h)
      if (bar) { g.fillStyle = c['canvas-ruler-ink']; g.fillText(String(b / bpb + 1), x(b) + 3, ruler / 2) }
    }
    const rowH = (h - ruler) / 16
    const kit = this.opts.getKit?.()
    for (const n of this.opts.getNotes?.() ?? []) {
      const row = n.pitch - this._noteOf(0)
      if (row < 0 || row > 15) continue
      g.fillStyle = c[`track-${VOICE_TRACK[kit?.slots?.[n.pitch]?.voice] ?? 1}`]
      g.globalAlpha = 0.45 + 0.55 * (n.velocity ?? 0.8)
      g.fillRect(x(n.startBeat), h - (row + 1) * rowH + 1, Math.max(3, x(n.duration ?? 0.25)), Math.max(2, rowH - 2))
    }
    g.globalAlpha = 1
    if (beat !== null && beat >= 0) {
      g.fillStyle = withAlpha(c['canvas-playhead'], 0.95)
      g.fillRect(x(pos), 0, 2, h)
    }
  }
}
