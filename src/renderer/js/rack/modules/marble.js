// MARBLE — Marbles-lite. A clock in, three correlated gates and three
// correlated CVs out, with DEJA VU deciding how much of the last loop comes
// back. The maths is all in rack/marble.js; this file is jacks, taps and
// scheduling.
//
// The T events carry their matching X value as `cv` (the TURING/ARP
// convention), so T1 → drum trig and X1 → v/oct stay in step even if the two
// cables take different routes.

import { gatePattern, dejaVuValue, resizeLoop, xValue, MAX_LOOP } from '../marble.js'
import { quantizePitchCv, SCALES } from './quantizer.js'

const OUTS = ['x1', 'x2', 'x3']
const CV_IN = ['rate', 'spread', 'deja']
const MAX_DIV = 8
const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v) || 0

export default {
  type: 'marble',
  name: 'MARBLE',
  group: 'mod',
  // 24 HP: nine controls need three knob columns, which left 50px of display at
  // 16. The hardware this follows is 18 HP with a smaller control set.
  hp: 24,
  tier: 'native',
  poly: false,
  ports: [
    { id: 'clk', dir: 'in', kind: 'gate', label: 'CLK' },
    { id: 'rate', dir: 'in', kind: 'cv', label: 'RATE', atten: true },
    { id: 'spread', dir: 'in', kind: 'cv', label: 'SPREAD', atten: true },
    { id: 'deja', dir: 'in', kind: 'cv', label: 'DEJA', atten: true },
    { id: 't1', dir: 'out', kind: 'gate', label: 'T1' },
    { id: 't2', dir: 'out', kind: 'gate', label: 'T2' },
    { id: 't3', dir: 'out', kind: 'gate', label: 'T3' },
    { id: 'x1', dir: 'out', kind: 'cv', label: 'X1' },
    { id: 'x2', dir: 'out', kind: 'cv', label: 'X2' },
    { id: 'x3', dir: 'out', kind: 'cv', label: 'X3' }
  ],
  params: [
    { key: 'tBias', label: 'T BIAS', min: 0, max: 1, step: 0.01, def: 0.5, fmt: '' },
    { key: 'tJitter', label: 'T JITTER', min: 0, max: 1, step: 0.01, def: 0, fmt: '' },
    { key: 'tMode', label: 'T MODE', options: ['coin', 'divmult', 'drums'], def: 'coin' },
    { key: 'dejaVu', label: 'DEJA VU', min: 0, max: 1, step: 0.01, def: 0, fmt: '' },
    { key: 'loopLen', label: 'LOOP', min: 1, max: MAX_LOOP, step: 1, def: 8, fmt: '' },
    { key: 'xSpread', label: 'X SPREAD', min: 0, max: 1, step: 0.01, def: 0.5, fmt: '' },
    { key: 'xBias', label: 'X BIAS', min: 0, max: 1, step: 0.01, def: 0.5, fmt: '' },
    { key: 'xSteps', label: 'X STEPS', min: 0, max: 1, step: 0.01, def: 0, fmt: '' },
    { key: 'scale', label: 'SCALE', options: Object.keys(SCALES), def: 'pent-min' }
  ],

  create(ctx, { params = {}, poll = null, emitEvent = () => {}, random = Math.random } = {}) {
    params = {
      tBias: 0.5, tJitter: 0, tMode: 'coin', dejaVu: 0, loopLen: 8,
      xSpread: 0.5, xBias: 0.5, xSteps: 0, scale: 'pent-min', ...params
    }
    const clk = ctx.createGain()
    const gates = { t1: ctx.createGain(), t2: ctx.createGain(), t3: ctx.createGain() }
    const srcs = OUTS.map(() => ctx.createConstantSource())
    const outs = OUTS.map(() => ctx.createGain())

    // ponytail: RATE / SPREAD / DEJA are read at the shared 30 Hz poll through
    // analysers, the established rule for CV jacks that cannot be AudioParams.
    // All three sit behind knobs nobody sweeps at audio rate.
    const cvIn = Object.fromEntries(CV_IN.map(k => [k, ctx.createAnalyser?.() || ctx.createGain()]))
    for (const node of Object.values(cvIn)) if ('fftSize' in node) node.fftSize = 32
    const frame = new Float32Array(32)
    const cv = { rate: 0, spread: 0, deja: 0 }
    const removePoll = poll?.add(() => {
      for (const key of CV_IN) {
        cvIn[key].getFloatTimeDomainData?.(frame)
        cv[key] = frame[0] || 0
      }
    })

    let loops = OUTS.map(() => resizeLoop([], params.loopLen))
    let step = -1
    let clocks = -1
    let lastTime = -1
    let fired = [false, false, false]

    for (let i = 0; i < OUTS.length; i++) {
      srcs[i].offset.value = 0
      srcs[i].connect(outs[i])
      srcs[i].start()
    }

    return {
      inputs: { clk: [clk], rate: [cvIn.rate], spread: [cvIn.spread], deja: [cvIn.deja] },
      outputs: {
        t1: [gates.t1], t2: [gates.t2], t3: [gates.t3],
        ...Object.fromEntries(OUTS.map((k, i) => [k, [outs[i]]]))
      },
      setParam(key, value) { params[key] = value },
      // Loop position and which T last fired, for the panel lamps.
      uiState() { return { index: step < 0 ? -1 : step % loops[0].length, len: loops[0].length, fired: fired.slice() } },
      onEvent(portId, event) {
        if (portId !== 'clk' || (event.type !== 'trig' && event.type !== 'gate-on')) return
        const time = event.time ?? ctx.currentTime
        const interval = lastTime >= 0 ? Math.max(0, time - lastTime) : 0
        lastTime = time

        // ponytail: the RATE jack divides the incoming clock (1..8) — MARBLE has
        // no internal clock to set the rate of. Multiplying would need a
        // sub-clock scheduler beyond the one ratchet divmult already uses.
        clocks++
        const div = 1 + Math.round(clamp01(cv.rate) * (MAX_DIV - 1))
        if (clocks % div) return
        step++

        loops = loops.map(h => resizeLoop(h, params.loopLen))
        const index = step % loops[0].length
        const bias = clamp01(params.tBias)
        const jitter = clamp01(params.tJitter)
        const pattern = gatePattern(params.tMode, step, bias, jitter, random)
        // JITTER nudges the gate late as well as widening the distribution;
        // forward only, because `time` is already the earliest safe timestamp.
        const at = time + interval * jitter * 0.4 * random()
        fired = [pattern.t1, pattern.t2, pattern.t3]

        const deja = clamp01(params.dejaVu + cv.deja)
        const spread = clamp01(params.xSpread + cv.spread)
        const quantize = v => quantizePitchCv(v, params.scale)

        for (let i = 0; i < OUTS.length; i++) {
          const drawn = dejaVuValue(loops[i], index, deja, random)
          loops[i] = drawn.history
          // X only moves when its own T fires, so a held note keeps its pitch.
          if (!fired[i]) continue
          const value = xValue(drawn.value, spread, params.xBias, params.xSteps, quantize)
          srcs[i].offset.setValueAtTime(value, at)
          emitEvent(`t${i + 1}`, { type: 'trig', time: at, channel: 0, cv: value })
          if (i === 2 && pattern.ratchet && interval > 0) {
            emitEvent('t3', { type: 'trig', time: at + interval / 2, channel: 0, cv: value })
          }
        }
      },
      dispose() {
        removePoll?.()
        for (let i = 0; i < OUTS.length; i++) { srcs[i].stop(); srcs[i].disconnect(); outs[i].disconnect() }
        for (const node of [clk, ...Object.values(gates), ...Object.values(cvIn)]) node.disconnect()
      }
    }
  },

  // Loop position on top, the three T lamps below. Without them DEJA VU is a
  // knob with no visible loop. Reuses TURING's LED classes rather than growing
  // the stylesheet for two rows of dots.
  panel(module, { getInstance, addPoll }) {
    const wrapper = document.createElement('div')
    const steps = document.createElement('div')
    const lamps = document.createElement('div')
    steps.className = 'turing-leds'
    lamps.className = 'turing-leds'
    const led = () => { const s = document.createElement('span'); s.className = 'turing-led'; return s }
    for (let i = 0; i < MAX_LOOP; i++) steps.append(led())
    for (let i = 0; i < 3; i++) lamps.append(led())
    wrapper.append(steps, lamps)

    let last = ''
    const removePoll = addPoll(() => {
      if (!wrapper.isConnected) { removePoll(); return }
      const state = getInstance()?.uiState?.() || { index: -1, len: MAX_LOOP, fired: [] }
      const key = `${state.index}/${state.len}/${state.fired.join('')}`
      if (key === last) return
      last = key
      for (let i = 0; i < MAX_LOOP; i++) {
        steps.children[i].classList.toggle('on', i === state.index)
        steps.children[i].style.opacity = i < state.len ? '' : '0.25'
      }
      for (let i = 0; i < 3; i++) lamps.children[i].classList.toggle('on', !!state.fired[i])
    })
    return wrapper
  }
}
