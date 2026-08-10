// SCOPE — dual-trace oscilloscope you can patch through.
//
// A -> analyser (tap) and A -> A OUT, in parallel. The analyser must be a leaf:
// Chrome only renders a subgraph that reaches the destination, and an
// AnalyserNode escapes that rule via automatic-pull ONLY while it has no
// outgoing connections. Wiring it inline as A -> analyser -> A OUT disqualifies
// it, so the trace goes dead the moment nothing is patched into A OUT — which is
// how a scope gets used most of the time.
//
// create() captures and triggers on the shared poll and hands the result to
// uiFrame(); panel() only paints. Same split as algo.js — the module stays
// testable with no DOM, and the panel is throwaway.

import { findTrigger, levels, fftSizeFor } from '../viz.js'

const LIVE = 0.01 // peak below this and a jack counts as unpatched

export default {
  type: 'scope',
  name: 'SCOPE',
  group: 'io',
  hp: 12,
  tier: 'native',
  poly: false,
  ports: [
    { id: 'a', dir: 'in', kind: 'audio', label: 'A' },
    { id: 'b', dir: 'in', kind: 'audio', label: 'B' },
    { id: 'trig', dir: 'in', kind: 'gate', label: 'TRIG' },
    { id: 'outa', dir: 'out', kind: 'audio', label: 'A' },
    { id: 'outb', dir: 'out', kind: 'audio', label: 'B' }
  ],
  params: [
    { key: 'time', label: 'TIME', min: 1, max: 500, step: 1, def: 50, fmt: 'ms' },
    { key: 'scale', label: 'SCALE', min: .1, max: 2, step: .1, def: 1, fmt: '' },
    { key: 'mode', label: 'MODE', options: ['wave', 'xy', 'spectrum'], def: 'wave' },
    { key: 'level', label: 'LEVEL', min: -1, max: 1, step: 0.01, def: 0, fmt: '' },
    { key: 'slope', label: 'SLOPE', options: ['rising', 'falling'], def: 'rising' }
  ],

  create(ctx, { params = {}, poll = null } = {}) {
    const chain = (withOut) => {
      const input = ctx.createGain(), analyser = ctx.createAnalyser()
      const out = withOut ? ctx.createGain() : null
      input.connect(analyser)
      if (out) input.connect(out)
      return { input, analyser, out }
    }
    const a = chain(true), b = chain(true), trig = chain(false)

    // What panel() paints. Buffers are reused, not reallocated per frame — the
    // panel reads them inside the same poll tick, so sharing is safe.
    const frame = {
      mode: 'wave', start: 0, count: 2, triggered: false, bLive: false, bins: 0,
      a: new Float32Array(0), b: new Float32Array(0), spectrum: new Uint8Array(0)
    }
    let trigBuf = new Float32Array(0), size = 0

    const seconds = () => Math.max(0.001, (Number(params.time) || 50) / 1000)

    // Capture twice the display window so findTrigger always has a full window
    // of samples left behind whatever edge it lands on.
    const resize = () => {
      const want = fftSizeFor(seconds() * 2, ctx.sampleRate)
      if (want === size) return
      size = want
      for (const n of [a.analyser, b.analyser, trig.analyser]) n.fftSize = want
      frame.a = new Float32Array(want)
      frame.b = new Float32Array(want)
      frame.spectrum = new Uint8Array(want / 2)
      trigBuf = new Float32Array(want)
    }
    resize()

    const capture = () => {
      resize()
      const mode = params.mode || 'wave'
      frame.mode = mode

      if (mode === 'spectrum') {
        a.analyser.getByteFrequencyData?.(frame.spectrum)
        frame.bins = frame.spectrum.length
        return
      }

      a.analyser.getFloatTimeDomainData?.(frame.a)
      b.analyser.getFloatTimeDomainData?.(frame.b)
      frame.count = Math.max(2, Math.min(Math.round(seconds() * ctx.sampleRate), frame.a.length >> 1))
      frame.bLive = levels(frame.b).peak > LIVE

      if (mode === 'xy') { frame.start = 0; frame.triggered = true; return }

      // TRIG is a real input, not decoration: if something is patched into it,
      // it wins over channel A as the trigger source.
      trig.analyser.getFloatTimeDomainData?.(trigBuf)
      const source = levels(trigBuf).peak > LIVE ? trigBuf : frame.a
      const at = findTrigger(source, frame.count, Number(params.level) || 0, params.slope || 'rising')
      frame.triggered = at >= 0
      frame.start = at >= 0 ? at : 0
    }
    const removePoll = poll?.add(capture)

    return {
      inputs: { a: [a.input], b: [b.input], trig: [trig.input] },
      outputs: { outa: [a.out], outb: [b.out] },
      analysers: { a: a.analyser, b: b.analyser, trig: trig.analyser },
      uiFrame: () => frame,
      setParam(key, value) {
        params[key] = value
        if (key === 'time') resize()
      },
      dispose() {
        removePoll?.()
        for (const part of [a, b, trig]) {
          part.input.disconnect()
          part.analyser.disconnect()
          part.out?.disconnect()
        }
      }
    }
  },

  panel(module, { params, getInstance, addPoll }) {
    const wrapper = document.createElement('div')
    wrapper.className = 'rack-scope'
    const canvas = document.createElement('canvas')
    wrapper.append(canvas)
    const g = context2d(canvas)

    // Self-unregisters once RackView drops the panel — it rebuilds panels
    // wholesale and never tears them down.
    const removePoll = addPoll(() => {
      if (!wrapper.isConnected) { removePoll(); return }
      const frame = getInstance()?.uiFrame?.()
      if (!g || !frame) return
      const { w, h } = fit(canvas, g, 176, 96)
      if (w < 4 || h < 4) return
      g.clearRect(0, 0, w, h)
      grid(g, w, h)
      const scale = Number(params().scale) || 1
      if (frame.mode === 'spectrum') paintSpectrum(g, w, h, frame)
      else if (frame.mode === 'xy') paintXY(g, w, h, frame, scale)
      else paintWave(g, w, h, frame, scale)
    })

    return wrapper
  }
}

// ─── Canvas plumbing ───
// jsdom has no 2D context and reports it as a jsdom error rather than a value.
function context2d(canvas) {
  try { return canvas.getContext('2d') || null } catch { return null }
}

// Backing store in device pixels, drawing in CSS pixels — anything less and
// every trace looks soft on a HiDPI screen.
function fit(canvas, g, fallbackW, fallbackH) {
  const dpr = window.devicePixelRatio || 1
  const w = canvas.clientWidth || fallbackW, h = canvas.clientHeight || fallbackH
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr)
    canvas.height = Math.round(h * dpr)
  }
  g.setTransform(dpr, 0, 0, dpr, 0, 0)
  return { w, h }
}

function grid(g, w, h) {
  g.strokeStyle = '#ffffff14'
  g.lineWidth = 1
  g.beginPath()
  for (let i = 1; i < 4; i++) {
    const x = Math.round(i * w / 4) + .5, y = Math.round(i * h / 4) + .5
    g.moveTo(x, 0); g.lineTo(x, h)
    g.moveTo(0, y); g.lineTo(w, y)
  }
  g.stroke()
}

// One column per pixel, min..max within the column. Straight decimation aliases
// a 500 ms window of audio into moiré; this looks like a scope.
function trace(g, buf, start, count, w, h, scale, color) {
  const columns = Math.max(1, Math.min(count, Math.round(w)))
  const y = v => h / 2 - Math.max(-1, Math.min(1, v * scale)) * (h / 2 - 1)
  g.strokeStyle = color
  g.lineWidth = 1
  g.beginPath()
  for (let c = 0; c < columns; c++) {
    const from = Math.floor(c * count / columns)
    const to = Math.max(from + 1, Math.floor((c + 1) * count / columns))
    let lo = Infinity, hi = -Infinity
    for (let i = from; i < to; i++) {
      const v = buf[start + i] || 0
      if (v < lo) lo = v
      if (v > hi) hi = v
    }
    const x = columns === 1 ? 0 : c / (columns - 1) * w
    if (!c) g.moveTo(x, y(hi))
    else g.lineTo(x, y(hi))
    g.lineTo(x, y(lo))
  }
  g.stroke()
}

function paintWave(g, w, h, frame, scale) {
  trace(g, frame.a, frame.start, frame.count, w, h, scale, '#7ee0ff')
  if (frame.bLive) trace(g, frame.b, frame.start, frame.count, w, h, scale, '#ffb36b')
  if (!frame.triggered) {
    g.fillStyle = '#ff9b6b'
    g.font = '8px monospace'
    g.fillText('UNTRIG', 3, 9)
  }
}

function paintXY(g, w, h, frame, scale) {
  const step = Math.max(1, Math.floor(frame.count / 1024))
  const clamp = v => Math.max(-1, Math.min(1, v * scale))
  g.strokeStyle = '#7ee0ff'
  g.lineWidth = 1
  g.beginPath()
  for (let i = 0; i < frame.count; i += step) {
    const x = w / 2 + clamp(frame.a[i] || 0) * (w / 2 - 1)
    const y = h / 2 - clamp(frame.b[i] || 0) * (h / 2 - 1)
    i ? g.lineTo(x, y) : g.moveTo(x, y)
  }
  g.stroke()
}

function paintSpectrum(g, w, h, frame) {
  const bins = frame.bins
  if (!bins) return
  const columns = Math.max(1, Math.min(bins, Math.round(w)))
  const bw = w / columns
  g.fillStyle = '#7ee0ff'
  for (let c = 0; c < columns; c++) {
    const from = Math.floor(c * bins / columns)
    const to = Math.max(from + 1, Math.floor((c + 1) * bins / columns))
    let peak = 0
    for (let i = from; i < to; i++) if (frame.spectrum[i] > peak) peak = frame.spectrum[i]
    const bh = peak / 255 * h
    g.fillRect(c * bw, h - bh, Math.max(1, bw - 1), bh)
  }
}
