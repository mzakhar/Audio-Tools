// METER — four independent level meters, each patched inline.
//
// IN n -> analyser (tap) and IN n -> OUT n, in parallel. The analyser must be a
// leaf: Chrome only renders a subgraph that reaches the destination, and an
// AnalyserNode escapes that rule via automatic-pull ONLY while it has no
// outgoing connections. Wiring it inline as IN -> analyser -> OUT disqualifies
// it, so a meter reads zero whenever its OUT is unpatched — i.e. most of the
// time. Four small analysers, one per channel; a shared multi-channel node would
// sum what should stay separate.
//
// Two metering laws, because this rack carries both kinds of signal:
//   audio — dB ladder to a -60 dBFS floor, peak-hold cap, clip latch.
//   cv    — bipolar centre-zero linear scale. A control voltage legitimately
//           sits at a steady negative DC (0.1 CV = 1 octave, 0.0 = C4); abs()
//           kills the sign and a dB floor is meaningless for a valid -0.4 V.
//
// create() runs the ballistics on the shared poll; panel() only paints what
// uiMeters() hands it, the same split algo.js uses.

import { levels, bipolar, dbfs, dbToFraction, approach, peakHold } from '../viz.js'

const FLOOR = -60      // dBFS
const ATTACK = 0.01    // s
const RELEASE = 0.3    // s
const CV_TAU = 0.03    // s
const CLIP_HOLD = 1.5  // s
const CHANNELS = 4

export default {
  type: 'meter',
  name: 'METER',
  group: 'io',
  hp: 8,
  tier: 'native',
  poly: false,
  ports: [
    ...Array.from({ length: CHANNELS }, (_, i) => ({ id: `in${i + 1}`, dir: 'in', kind: 'audio', label: `${i + 1}` })),
    ...Array.from({ length: CHANNELS }, (_, i) => ({ id: `out${i + 1}`, dir: 'out', kind: 'audio', label: `${i + 1}` }))
  ],
  params: [
    { key: 'mode', label: 'MODE', options: ['audio', 'cv'], def: 'audio' },
    { key: 'source', label: 'SRC', options: ['peak', 'rms'], def: 'peak' }
  ],

  create(ctx, { params = {}, poll = null } = {}) {
    const chans = Array.from({ length: CHANNELS }, () => {
      const input = ctx.createGain(), analyser = ctx.createAnalyser(), out = ctx.createGain()
      analyser.fftSize = 512
      input.connect(analyser)
      input.connect(out)
      return {
        input, analyser, out,
        buf: new Float32Array(analyser.fftSize),
        db: FLOOR, hold: { value: FLOOR, hold: 0 }, clip: 0, cv: 0
      }
    })

    // Real elapsed time, not a fixed 1/30 — RackPoll's interval drifts and the
    // ballistics are defined in seconds.
    let last = performance.now() / 1000
    const tick = () => {
      const t = performance.now() / 1000
      const dt = Math.min(0.25, Math.max(0, t - last))
      last = t
      const cv = params.mode === 'cv'
      for (const ch of chans) {
        ch.analyser.getFloatTimeDomainData?.(ch.buf)
        if (cv) {
          ch.cv = approach(ch.cv, bipolar(ch.buf).mean, dt, CV_TAU)
          ch.clip = 0
          continue
        }
        const { peak, rms } = levels(ch.buf)
        const target = dbfs(params.source === 'rms' ? rms : peak, FLOOR)
        ch.db = approach(ch.db, target, dt, target > ch.db ? ATTACK : RELEASE)
        ch.hold = peakHold(ch.hold, dbfs(peak, FLOOR), dt, { floor: FLOOR })
        ch.clip = peak >= 1 ? CLIP_HOLD : Math.max(0, ch.clip - dt)
      }
    }
    const removePoll = poll?.add(tick)

    const port = (prefix, pick) => Object.fromEntries(chans.map((ch, i) => [`${prefix}${i + 1}`, [pick(ch)]]))

    return {
      inputs: port('in', ch => ch.input),
      outputs: port('out', ch => ch.out),
      analysers: chans.map(ch => ch.analyser),
      uiMeters: () => chans.map(ch => ({ db: ch.db, hold: ch.hold.value, clip: ch.clip > 0, cv: ch.cv })),
      setParam(key, value) { params[key] = value },
      dispose() {
        removePoll?.()
        for (const ch of chans) { ch.input.disconnect(); ch.analyser.disconnect(); ch.out.disconnect() }
      }
    }
  },

  panel(module, { params, getInstance, addPoll }) {
    const wrapper = document.createElement('div')
    wrapper.className = 'rack-meter'
    const canvas = document.createElement('canvas')
    wrapper.append(canvas)
    const g = context2d(canvas)

    // Self-unregisters once RackView drops the panel — it rebuilds panels
    // wholesale and never tears them down.
    const removePoll = addPoll(() => {
      if (!wrapper.isConnected) { removePoll(); return }
      const meters = getInstance()?.uiMeters?.()
      if (!g || !meters) return
      const { w, h } = fit(canvas, g, 112, 88)
      if (w < 4 || h < 4) return
      g.clearRect(0, 0, w, h)
      const cv = params().mode === 'cv'
      if (cv) { g.fillStyle = '#ffffff1a'; g.fillRect(0, Math.round(h / 2), w, 1) }
      else ladder(g, w, h)
      const slot = w / meters.length
      const bw = Math.max(3, slot - 4)
      meters.forEach((m, i) => {
        const x = i * slot + (slot - bw) / 2
        if (cv) paintCv(g, x, bw, h, m)
        else paintDb(g, x, bw, h, m)
      })
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
// every edge looks soft on a HiDPI screen.
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

function ladder(g, w, h) {
  g.fillStyle = '#ffffff14'
  for (const db of [0, -6, -12, -24, -48]) {
    g.fillRect(0, Math.round(h - dbToFraction(db, FLOOR) * h), w, 1)
  }
}

function paintDb(g, x, bw, h, m) {
  const fill = dbToFraction(m.db, FLOOR) * h
  const hot = dbToFraction(-6, FLOOR) * h
  g.fillStyle = '#6ee07a'
  g.fillRect(x, h - fill, bw, fill)
  if (fill > hot) {
    g.fillStyle = '#ffcf5c'
    g.fillRect(x, h - fill, bw, fill - hot)
  }
  const cap = dbToFraction(m.hold, FLOOR) * h
  if (cap > 0) {
    g.fillStyle = '#e8f4ff'
    g.fillRect(x, Math.max(0, h - cap - 1), bw, 2)
  }
  if (m.clip) {
    g.fillStyle = '#ff5a4d'
    g.fillRect(x, 0, bw, 3)
  }
}

function paintCv(g, x, bw, h, m) {
  const mid = h / 2
  const v = Math.max(-1, Math.min(1, m.cv))
  const span = Math.abs(v) * (mid - 1)
  g.fillStyle = v < 0 ? '#ffb36b' : '#7ee0ff'
  g.fillRect(x, v < 0 ? mid : mid - span, bw, Math.max(1, span))
}
