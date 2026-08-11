// DRIFT — slow correlated randomness: random walk, smoothed walk, or Lorenz
// chaos on three outputs.
//
// Nothing here runs at audio rate. The module keeps ~200 ms of scheduled ramp
// segments on each ConstantSourceNode and tops them up from the shared 30 Hz
// poll, so a 0.3 Hz drift costs three AudioParam events a second.

import { walkStep, lorenzStep, LORENZ_SCALE, LORENZ_SEED } from '../drift.js'
import { clampCv } from '../../utils/cv.js'

const AXES = ['x', 'y', 'z']
const LOOKAHEAD = 0.2
const MAX_SEGMENTS = 64   // a suspended tab must not schedule an hour of ramps
const WALK_STEP = 0.3     // raw walk step; DEPTH scales the output, not the walk
const LORENZ_DT = 0.01
const LORENZ_SUB = 4      // Euler substeps per segment — dt small enough to stay bounded

export default {
  type: 'drift',
  name: 'DRIFT',
  group: 'mod',
  hp: 6,
  tier: 'native',
  poly: false,
  ports: [
    { id: 'rate', dir: 'in', kind: 'cv', label: 'RATE', atten: true },
    { id: 'rst', dir: 'in', kind: 'gate', label: 'RST' },
    { id: 'x', dir: 'out', kind: 'cv', label: 'X' },
    { id: 'y', dir: 'out', kind: 'cv', label: 'Y' },
    { id: 'z', dir: 'out', kind: 'cv', label: 'Z' }
  ],
  params: [
    { key: 'rate', label: 'RATE', min: 0.01, max: 10, step: 0.01, def: 0.3, fmt: 'Hz' },
    { key: 'depth', label: 'DEPTH', min: 0, max: 1, step: 0.01, def: 1, fmt: '' },
    { key: 'mode', label: 'MODE', options: ['walk', 'lorenz', 'smooth'], def: 'walk' },
    { key: 'bipolar', label: 'BIPOLAR', options: ['off', 'on'], def: 'off' }
  ],

  create(ctx, { params = {}, poll = null, ctxTime = 0, random = Math.random } = {}) {
    params = { rate: 0.3, depth: 1, mode: 'walk', bipolar: 'off', ...params }
    const rateIn = ctx.createGain()
    const rst = ctx.createGain()
    const srcs = Object.fromEntries(AXES.map(k => [k, ctx.createConstantSource()]))
    const outs = Object.fromEntries(AXES.map(k => [k, ctx.createGain()]))

    // ponytail: RATE jack sampled at poll rate, same as TURING's LOCK. Audio-rate
    // FM of a 0.3 Hz drift is not a thing anyone asks for.
    const analyser = ctx.createAnalyser?.() || null
    const scan = analyser ? new Float32Array(analyser.fftSize) : null
    let rateCv = 0
    if (analyser) rateIn.connect(analyser)

    let walk = { x: 0, y: 0, z: 0 }
    let lorenz = { ...LORENZ_SEED }
    let nextTime = ctxTime || ctx.currentTime || 0

    for (const k of AXES) {
      srcs[k].offset.value = params.bipolar === 'on' ? 0 : 0.5 * params.depth
      srcs[k].connect(outs[k])
      srcs[k].start()
    }

    // Raw ±1 → the jack's actual range. DEPTH scales, BIPOLAR decides whether
    // the unipolar output rests at half scale or at zero.
    const shape = v => (params.bipolar === 'on' ? clampCv(v) : (clampCv(v) + 1) / 2) * params.depth

    function advance() {
      if (params.mode === 'lorenz') {
        for (let i = 0; i < LORENZ_SUB; i++) lorenz = lorenzStep(lorenz, LORENZ_DT)
        return {
          x: lorenz.x / LORENZ_SCALE.x,
          y: lorenz.y / LORENZ_SCALE.y,
          z: (lorenz.z - LORENZ_SCALE.z) / LORENZ_SCALE.z
        }
      }
      walk = Object.fromEntries(AXES.map(k => [k, walkStep(walk[k], WALK_STEP, random)]))
      return walk
    }

    function fill(now) {
      if (analyser) { analyser.getFloatTimeDomainData?.(scan); rateCv = scan[scan.length - 1] || 0 }
      const rate = Math.min(10, Math.max(0.01, params.rate + rateCv * 10))
      const dt = 1 / rate
      if (!(nextTime > now)) nextTime = now
      for (let n = 0; n < MAX_SEGMENTS && nextTime < now + LOOKAHEAD; n++) {
        const raw = advance()
        for (const k of AXES) {
          const target = shape(raw[k])
          // `walk` steps, `smooth`/`lorenz` interpolate. Same generator, and the
          // only difference the ear cares about.
          if (params.mode === 'walk') srcs[k].offset.setValueAtTime(target, nextTime)
          else srcs[k].offset.linearRampToValueAtTime(target, nextTime + dt)
        }
        nextTime += dt
      }
    }

    fill(ctx.currentTime || 0)
    const removePoll = poll?.add(() => fill(ctx.currentTime || 0))

    return {
      inputs: { rate: [rateIn], rst: [rst] },
      outputs: Object.fromEntries(AXES.map(k => [k, [outs[k]]])),
      setParam(key, value) { params[key] = value },
      onEvent(portId, event) {
        if (portId !== 'rst' || event.type === 'gate-off') return
        const time = event.time ?? ctx.currentTime
        walk = { x: 0, y: 0, z: 0 }
        lorenz = { ...LORENZ_SEED }
        for (const k of AXES) {
          srcs[k].offset.cancelScheduledValues(time)
          srcs[k].offset.setValueAtTime(shape(0), time)
        }
        nextTime = time
        fill(time)
      },
      dispose() {
        removePoll?.()
        for (const k of AXES) { srcs[k].stop(); srcs[k].disconnect(); outs[k].disconnect() }
        rateIn.disconnect()
        rst.disconnect()
        analyser?.disconnect()
      }
    }
  }
}
