import ProjectStore, { SetPadsSettings, DEFAULT_PADS } from '../store/ProjectStore.js'
import { snapGroove, SNAP_GRIDS } from '../pads/groove.js'
import { readThemeColors, themeStyle, onThemeChange } from '../ui/theme-colors.js'
import { withAlpha } from './canvas-colors.js'

const FIRST_NOTE = 36
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
    this._flashTimers = new Map()
    const state = ProjectStore.getState()
    this._pads = state.pads ?? DEFAULT_PADS
    this._beatsPerBar = state.timeSignature?.[0] ?? 4
    this._colours = null
    this._unsubTheme = onThemeChange(() => { this._colours = null; this.drawStrip() })
    this._unsub = ProjectStore.subscribe(next => {
      this._pads = next.pads ?? DEFAULT_PADS
      this._beatsPerBar = next.timeSignature?.[0] ?? 4
      this.sync()
    })
    this.render()
  }

  destroy() {
    this.setActive(false)
    this._unsub?.()
    this._unsubTheme?.()
    this._ro?.disconnect()
    for (const id of this._flashTimers.values()) clearTimeout(id)
    this._flashTimers.clear()
    this.container.innerHTML = ''
  }

  // ─── Public ─────────────────────────────────────────────────────────────
  layerOn() { return this.layer }
  isWiping() { return this.wiping }
  /** Pads touched while Wipe was held (null = none touched, meaning every pad). */
  wipePitches() { return this.wipePads.size ? this.wipePads : null }

  trigger(padIndex) {
    this.opts.triggerPad?.(FIRST_NOTE + padIndex, VELOCITY_DEFAULT)
  }

  /** Hit feedback — from a twin, the PC keys or hardware. */
  flashPad(note, velocity) {
    if (this.wiping) this.wipePads.add(note)
    const el = this.padEls?.get(note)
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
  setActive(active) { this.active = active; this._loop(); if (active) this.refreshKit() }
  setPlaying(playing) { this.playing = playing; this._loop(); this.drawStrip() }

  refreshKit() {
    const kit = this.opts.getKit?.() ?? null
    this.padEls.forEach((el, note) => {
      const slot = kit?.slots?.[note]
      const voice = slot?.voice ?? ''
      el.dataset.voice = voice
      el.setAttribute('aria-disabled', slot ? 'false' : 'true')
      el.querySelector('.pads-pad-name').textContent = voice.toUpperCase()
      el.setAttribute('aria-label', `Pad ${note - FIRST_NOTE + 1}${voice ? ` ${voice.toUpperCase()}` : ' empty'}`)
    })
    this.drawStrip()
  }

  // ─── DOM ────────────────────────────────────────────────────────────────
  render() {
    const grids = Object.keys(SNAP_GRIDS).map(k => `<option value="${k}">${k}</option>`).join('')
    const pads = PAD_ROWS.map((row, r) => row.map((i, c) =>
      `<button type="button" class="pads-pad" data-pad="${i}" aria-label="Pad ${i + 1}"><span class="pads-pad-num">${i + 1}</span><span class="pads-pad-name"></span><span class="pads-pad-key">${PAD_KEY_ROWS[r][c].toUpperCase()}</span></button>`
    ).join('')).join('')
    this.container.innerHTML = `
      <div class="pads-shell panel">
        <div class="pads-header">
          <span class="micro-label">LOOP</span>
          <output class="lcd pads-pos" aria-label="Loop position">bar 1/2</output>
          <button type="button" class="btn btn--danger pads-layer" aria-pressed="false" aria-label="Layer (overdub)">● LAYER</button>
          <button type="button" class="btn pads-undo" aria-label="Undo last pass">UNDO</button>
          <button type="button" class="btn btn--danger pads-wipe" aria-pressed="false" aria-label="Wipe (hold, then touch pads)">WIPE</button>
          <button type="button" class="btn btn--toggle pads-metro" aria-pressed="false" aria-label="Metronome">CLICK</button>
          <label class="pads-field"><span class="micro-label">COUNT-IN</span>
            <select class="pads-countin" aria-label="Count-in bars"><option value="0">0</option><option value="1">1</option><option value="2">2</option></select></label>
          <label class="pads-field"><span class="micro-label">BARS</span>
            <select class="pads-bars" aria-label="Loop length in bars">${[1, 2, 4, 8].map(n => `<option value="${n}">${n}</option>`).join('')}</select></label>
        </div>
        <canvas class="pads-strip" aria-label="Loop hits"></canvas>
        <div class="pads-body">
          <div class="pads-grid" role="group" aria-label="Pads">${pads}</div>
          <div class="pads-controls">
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
      </div>`
    const $ = sel => this.container.querySelector(sel)
    this.el = {
      pos: $('.pads-pos'), layer: $('.pads-layer'), undo: $('.pads-undo'), wipe: $('.pads-wipe'),
      metro: $('.pads-metro'), countin: $('.pads-countin'), bars: $('.pads-bars'),
      groove: $('.pads-groove'), grooveOut: $('.pads-groove-out'), snap: $('.pads-snap'),
      strength: $('.pads-strength'), strengthOut: $('.pads-strength-out'), strip: $('.pads-strip'),
    }
    this.padEls = new Map([...this.container.querySelectorAll('.pads-pad')].map(el => [FIRST_NOTE + Number(el.dataset.pad), el]))
    this._bind()
    this.refreshKit()
    this.sync()
  }

  _bind() {
    const { el } = this
    const set = patch => ProjectStore.dispatch(SetPadsSettings(patch))

    this.padEls.forEach((pad, note) => {
      pad.addEventListener('pointerdown', e => {
        e.preventDefault()
        this.opts.triggerPad?.(note, VELOCITY_DEFAULT)
      })
      // Focused pad: Enter/Space plays it. stopPropagation keeps the global Space (transport) out.
      pad.addEventListener('keydown', e => {
        if (e.key !== 'Enter' && e.key !== ' ') return
        e.preventDefault()
        e.stopPropagation()
        if (!e.repeat) this.opts.triggerPad?.(note, 100)
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
    this.drawStrip()
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
      const row = n.pitch - FIRST_NOTE
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
