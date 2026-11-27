// slice-dialog.js — "Slice to 16": waveform, 16 markers from the pure slicer, a
// sensitivity slider, click-to-audition, a BPM suggestion and Apply.
// All maths is in pads/slicer.js; this is the DOM shell.

import { openDialog, closeDialog } from '../ui/dialog.js'
import { readThemeColors, themeStyle } from '../ui/theme-colors.js'
import { mono, onsetEnvelope, pickOnsets, sliceRegions, trimEnd, estimateBars } from '../pads/slicer.js'

export const SLICE_DIALOG_ID = 'slice-dialog'
const TOKENS = ['canvas-bg', 'canvas-note', 'canvas-playhead', 'canvas-grid-bar', 'text-dim', 'font-mono']
const DEBOUNCE_MS = 120

/** Peak (min,max) per pixel column. Pure. */
export function peaks(samples, columns) {
  const out = new Float32Array(columns * 2)
  const per = samples.length / Math.max(1, columns)
  for (let c = 0; c < columns; c++) {
    let lo = 0, hi = 0
    for (let i = Math.floor(c * per), e = Math.min(samples.length, Math.floor((c + 1) * per) + 1); i < e; i++) {
      if (samples[i] < lo) lo = samples[i]
      if (samples[i] > hi) hi = samples[i]
    }
    out[2 * c] = lo
    out[2 * c + 1] = hi
  }
  return out
}

/** Index of the region containing sample `at`, or -1. Pure. */
export const regionAt = (regions, at) => regions.findIndex(r => at >= r.start && at < r.end)

export function createSliceDialog({ root = document, onApply = () => {}, onSetBpm = () => {}, audition = () => {}, onClose = () => {} } = {}) {
  const $ = sel => root.querySelector(`#${SLICE_DIALOG_ID} ${sel}`)
  const canvas = $('.slice-canvas'), sens = $('.slice-sens'), info = $('.slice-info')
  const bpmBtn = $('.slice-setbpm'), applyBtn = $('.slice-apply'), msg = $('.slice-msg')
  let st = null, timer = null, active = -1

  function draw() {
    const g = canvas.getContext?.('2d')
    if (!g || !st) return
    const w = canvas.clientWidth, h = canvas.clientHeight
    if (!w || !h) return
    const dpr = window.devicePixelRatio || 1
    if (canvas.width !== Math.round(w * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr) }
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    const c = readThemeColors(TOKENS, themeStyle())
    g.fillStyle = c['canvas-bg']; g.fillRect(0, 0, w, h)
    const total = st.samples.length
    if (st.peaksW !== w) { st.peaksW = w; st.peaks = peaks(st.samples, w) }
    g.fillStyle = c['canvas-note']
    for (let x = 0; x < w; x++) {
      const y0 = h / 2 - st.peaks[2 * x + 1] * h / 2, y1 = h / 2 - st.peaks[2 * x] * h / 2
      g.fillRect(x, y0, 1, Math.max(1, y1 - y0))
    }
    g.font = `10px ${c['font-mono']}`; g.textBaseline = 'top'
    st.regions.forEach((r, i) => {
      const x = Math.round(r.start / total * w)
      g.fillStyle = i === active ? c['canvas-playhead'] : c['canvas-grid-bar']
      g.fillRect(x, 0, 1, h)
      g.fillStyle = c['text-dim']; g.fillText(String(i + 1), x + 3, 2)
    })
  }

  const compute = () => {
    const onsets = pickOnsets(st.env.env, st.env.hop, st.sampleRate, { sensitivity: Number(sens.value) / 100 })
    st.regions = sliceRegions(st.samples, st.sampleRate, onsets, { count: 16 })
    canvas.dataset.regions = String(st.regions.length)
    draw()
  }

  const refreshInfo = () => {
    const sec = st.trimmed / st.sampleRate
    st.est = estimateBars(sec)
    const est = st.est
    info.textContent = `${st.name} · ${sec.toFixed(1)} s` + (est ? ` · ≈ ${est.bars} bar${est.bars > 1 ? 's' : ''} at ${est.bpm} BPM` : '')
    bpmBtn.hidden = !est
    bpmBtn.textContent = est ? `SET BPM TO ${est.bpm}` : ''
  }

  sens.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => st && compute(), DEBOUNCE_MS) })
  canvas.addEventListener('click', e => {
    if (!st) return
    const rect = canvas.getBoundingClientRect()
    const at = Math.floor((e.clientX - rect.left) / (rect.width || 1) * st.samples.length)
    const i = regionAt(st.regions, at)
    if (i < 0) return
    active = i
    draw()
    audition(st.buffer, st.regions[i].start / st.sampleRate, st.regions[i].end / st.sampleRate)
  })
  bpmBtn.addEventListener('click', () => { if (st?.est) onSetBpm(st.est.bpm) })
  applyBtn.addEventListener('click', () => {
    if (!st) return
    onApply({ regions: st.regions, sampleRate: st.sampleRate, name: st.name, bytes: st.bytes })
    closeDialog(SLICE_DIALOG_ID)
  })
  root.querySelector(`#${SLICE_DIALOG_ID}`).addEventListener('close', () => { clearTimeout(timer); st = null; onClose() })

  return {
    open({ name, buffer, bytes }) {
      const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i))
      const samples = mono(channels)
      st = { name, buffer, bytes, samples, sampleRate: buffer.sampleRate, trimmed: trimEnd(samples), env: null, regions: [], peaks: null, peaksW: 0 }
      st.env = onsetEnvelope(samples, st.sampleRate)
      active = -1
      msg.textContent = ''
      sens.value = '50'
      refreshInfo()
      compute()
      openDialog(SLICE_DIALOG_ID)
      draw()   // canvas has a size only once the dialog is visible
    },
    regions: () => st?.regions ?? [],
  }
}
