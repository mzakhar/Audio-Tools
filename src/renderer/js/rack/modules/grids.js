import { gridsLevel, gridsHit, STEPS } from '../grids.js'

// GRIDS — turns a clock into a whole beat. The pattern map is pure and lives in
// rack/grids.js; this file is only the jacks, the CV taps and the XY pad.

const CHANS = [['bd', 'dBd'], ['sd', 'dSd'], ['hh', 'dHh']]
const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v) || 0

export default {
  type: 'grids', name: 'GRIDS', group: 'seq', hp: 12, tier: 'native', poly: false,
  ports: [
    { id: 'clk', dir: 'in', kind: 'gate', label: 'CLK' },
    { id: 'rst', dir: 'in', kind: 'gate', label: 'RST' },
    { id: 'x', dir: 'in', kind: 'cv', label: 'X', atten: true },
    { id: 'y', dir: 'in', kind: 'cv', label: 'Y', atten: true },
    { id: 'chaos', dir: 'in', kind: 'cv', label: 'CHAOS', atten: true },
    { id: 'bd', dir: 'out', kind: 'gate', label: 'BD' },
    { id: 'sd', dir: 'out', kind: 'gate', label: 'SD' },
    { id: 'hh', dir: 'out', kind: 'gate', label: 'HH' },
    { id: 'acc', dir: 'out', kind: 'gate', label: 'ACC' }
  ],
  params: [
    { key: 'x', label: 'X', min: 0, max: 1, step: 0.01, def: 0.5, fmt: '' },
    { key: 'y', label: 'Y', min: 0, max: 1, step: 0.01, def: 0.5, fmt: '' },
    { key: 'dBd', label: 'BD', min: 0, max: 1, step: 0.01, def: 0.5, fmt: '' },
    { key: 'dSd', label: 'SD', min: 0, max: 1, step: 0.01, def: 0.5, fmt: '' },
    { key: 'dHh', label: 'HH', min: 0, max: 1, step: 0.01, def: 0.5, fmt: '' },
    { key: 'chaos', label: 'CHAOS', min: 0, max: 1, step: 0.01, def: 0, fmt: '' },
    { key: 'swing', label: 'SWING', min: 0, max: 0.75, step: 0.01, def: 0, fmt: '' },
    { key: 'accentThresh', label: 'ACCENT', min: 0, max: 1, step: 0.01, def: 0.8, fmt: '' }
  ],

  create(ctx, { params, emitEvent = () => {}, poll = null, random = Math.random }) {
    const clk = ctx.createGain(), rst = ctx.createGain()
    const outs = { bd: ctx.createGain(), sd: ctx.createGain(), hh: ctx.createGain(), acc: ctx.createGain() }
    // The X/Y/CHAOS jacks are control-rate ideas, so they are read off the shared
    // 30 Hz poll through an analyser rather than becoming AudioParams. Nothing
    // patched reads 0 and the knob stands alone.
    const cvIn = { x: ctx.createAnalyser(), y: ctx.createAnalyser(), chaos: ctx.createAnalyser() }
    for (const node of Object.values(cvIn)) node.fftSize = 32
    const frame = new Float32Array(32)
    const cv = { x: 0, y: 0, chaos: 0 }
    const remove = poll?.add(() => {
      for (const key of ['x', 'y', 'chaos']) {
        cvIn[key].getFloatTimeDomainData?.(frame)
        cv[key] = frame[0] || 0
      }
    })

    let step = -1
    let last = -1

    return {
      inputs: { clk: [clk], rst: [rst], x: [cvIn.x], y: [cvIn.y], chaos: [cvIn.chaos] },
      outputs: { bd: [outs.bd], sd: [outs.sd], hh: [outs.hh], acc: [outs.acc] },
      setParam(key, value) { params[key] = value },
      uiStep() { return step },
      onEvent(port, event) {
        if (port === 'rst' && event.type !== 'gate-off') { step = -1; last = -1; return }
        if (port !== 'clk' || (event.type !== 'trig' && event.type !== 'gate-on')) return
        const time = event.time ?? ctx.currentTime
        // ponytail: swing rides the previous clock interval, so the first tick
        // after a tempo change swings by the old amount. Transport-aware timing
        // via rack-clock.js if it ever shows.
        const interval = last >= 0 ? Math.max(0, time - last) : 0
        last = time
        step = (step + 1) % STEPS
        const swing = Math.min(0.75, Math.max(0, params.swing || 0))
        const at = time + (step % 2 ? swing * interval * 0.5 : 0)
        const x = clamp01(params.x + cv.x), y = clamp01(params.y + cv.y)
        const chaos = clamp01(params.chaos + cv.chaos)
        let peak = 0
        for (const [ch, densityKey] of CHANS) {
          const level = gridsLevel(x, y, ch, step)
          // random() is drawn for every channel every step, hit or not: a
          // seeded bounce has to consume the same sequence whatever the knobs say.
          if (!gridsHit(level, params[densityKey], chaos, random())) continue
          emitEvent(ch, { type: 'trig', time: at, channel: 0, velocity: level / 255 })
          peak = Math.max(peak, level)
        }
        // `peak > 0` guards the accent-knob-at-zero case: with no hits at all,
        // peak is 0 and would otherwise clear a 0 threshold on every step.
        if (peak > 0 && peak >= params.accentThresh * 255) emitEvent('acc', { type: 'trig', time: at, channel: 0 })
      },
      dispose() {
        remove?.()
        for (const node of [clk, rst, ...Object.values(outs), ...Object.values(cvIn)]) node.disconnect()
      }
    }
  },

  // X and Y are one gesture on hardware and one gesture here — the generic
  // renderer would give them two unrelated knobs.
  panel(module, { params, setParam }) {
    const pad = document.createElement('div')
    pad.className = 'grids-xy'
    const puck = document.createElement('span')
    puck.className = 'grids-puck'
    pad.append(puck)

    const paint = () => {
      const p = params()
      puck.style.left = `${clamp01(p.x ?? 0.5) * 100}%`
      puck.style.top = `${(1 - clamp01(p.y ?? 0.5)) * 100}%`
    }
    const move = e => {
      const box = pad.getBoundingClientRect()
      if (!box.width || !box.height) return
      setParam('x', Math.round(clamp01((e.clientX - box.left) / box.width) * 100) / 100)
      setParam('y', Math.round(clamp01(1 - (e.clientY - box.top) / box.height) * 100) / 100)
      paint()
    }
    pad.addEventListener('pointerdown', e => { e.stopPropagation(); pad.setPointerCapture?.(e.pointerId); move(e) })
    pad.addEventListener('pointermove', e => { if (pad.hasPointerCapture?.(e.pointerId)) move(e) })

    paint()
    pad.refresh = paint
    return pad
  }
}
