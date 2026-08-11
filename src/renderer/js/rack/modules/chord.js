// CHORD — one root pitch CV in, four voiced pitch CVs out. Drives four VCOs or
// one poly VCO, and sits happily after QUANT.
//
// Unlike QUANT (which reads pitch off the trigger event) this is a real CV
// processor: the V/OCT jack is sampled through an AnalyserNode on the shared
// 30 Hz poll, so the chord tracks a slowly moving root with no gate at all.
//
// ponytail: 30 Hz sampling of V/OCT means a stepped root arriving between polls
// lands up to 33 ms late. Fine for chords; audio-rate tracking needs a worklet.

import { chordVoltages, CHORD_TYPES } from '../chord.js'
import { quantizePitchCv, SCALES } from './quantizer.js'

const TYPES = Object.keys(CHORD_TYPES)
const VOICINGS = ['close', 'open', 'drop2']

export default {
  type: 'chord',
  name: 'CHORD',
  group: 'util',
  hp: 8,
  tier: 'native',
  poly: false,
  ports: [
    { id: 'voct', dir: 'in', kind: 'cv', label: 'V/OCT' },
    { id: 'type', dir: 'in', kind: 'cv', label: 'TYPE', atten: true },
    { id: 'inv', dir: 'in', kind: 'cv', label: 'INV', atten: true },
    { id: 'gate', dir: 'in', kind: 'gate', label: 'GATE' },
    { id: 'out1', dir: 'out', kind: 'cv', label: '1' },
    { id: 'out2', dir: 'out', kind: 'cv', label: '2' },
    { id: 'out3', dir: 'out', kind: 'cv', label: '3' },
    { id: 'out4', dir: 'out', kind: 'cv', label: '4' },
    { id: 'gateOut', dir: 'out', kind: 'gate', label: 'GATE' }
  ],
  params: [
    { key: 'type', label: 'TYPE', options: TYPES, def: 'maj' },
    { key: 'inversion', label: 'INV', min: 0, max: 3, step: 1, def: 0, fmt: '' },
    { key: 'voicing', label: 'VOICING', options: VOICINGS, def: 'close' },
    { key: 'scaleLock', label: 'LOCK', options: ['off', 'on'], def: 'off' },
    { key: 'scale', label: 'SCALE', options: Object.keys(SCALES), def: 'major' }
  ],

  create(ctx, { params = {}, poll = null, emitEvent = () => {} } = {}) {
    params = { type: 'maj', inversion: 0, voicing: 'close', scaleLock: 'off', scale: 'major', ...params }
    const gate = ctx.createGain()
    const gateOut = ctx.createGain()
    const srcs = Array.from({ length: 4 }, () => ctx.createConstantSource())
    const outs = Array.from({ length: 4 }, () => ctx.createGain())

    // One analyser per CV jack. `read()` returns the most recent sample, which
    // for a DC control signal is simply its current value.
    const probe = () => {
      const node = ctx.createGain()
      const analyser = ctx.createAnalyser?.() || null
      if (analyser) node.connect(analyser)
      const buf = analyser ? new Float32Array(analyser.fftSize) : null
      return {
        node,
        analyser,
        read() {
          if (!analyser) return 0
          analyser.getFloatTimeDomainData?.(buf)
          return buf[buf.length - 1] || 0
        }
      }
    }
    const voct = probe()
    const typeCv = probe()
    const invCv = probe()

    srcs.forEach((src, i) => { src.offset.value = 0; src.connect(outs[i]); src.start() })

    let last = ''
    function update(time, force = false) {
      const root = voct.read()
      // A whole type list across 1 CV unit, quantized — the jack steps chords,
      // it does not glide between them.
      const typeIndex = Math.max(0, Math.min(TYPES.length - 1,
        TYPES.indexOf(params.type) + Math.round(typeCv.read() * TYPES.length)))
      const inversion = Math.max(0, Math.min(3, Math.round(params.inversion + invCv.read() * 4)))
      const key = `${root.toFixed(5)}|${typeIndex}|${inversion}|${params.voicing}|${params.scaleLock}|${params.scale}`
      if (key === last && !force) return
      last = key
      const cvs = chordVoltages(root, TYPES[typeIndex], inversion, params.voicing)
      cvs.forEach((value, i) => {
        const final = params.scaleLock === 'on' ? quantizePitchCv(value, params.scale) : value
        srcs[i].offset.setTargetAtTime(final, time, 0.005)
      })
    }

    const removePoll = poll?.add(() => update(ctx.currentTime || 0))

    return {
      inputs: { voct: [voct.node], type: [typeCv.node], inv: [invCv.node], gate: [gate] },
      outputs: {
        out1: [outs[0]], out2: [outs[1]], out3: [outs[2]], out4: [outs[3]],
        gateOut: [gateOut]
      },
      setParam(key, value) { params[key] = value },
      onEvent(portId, event) {
        if (portId !== 'gate') return
        const time = event.time ?? ctx.currentTime
        // Voice the chord at the gate's timestamp, then pass the gate on — the
        // VCAs downstream open on the same event that set the pitches.
        update(time, true)
        emitEvent('gateOut', { ...event, time })
      },
      dispose() {
        removePoll?.()
        for (const src of srcs) { src.stop(); src.disconnect() }
        for (const out of outs) out.disconnect()
        for (const p of [voct, typeCv, invCv]) { p.node.disconnect(); p.analyser?.disconnect() }
        gate.disconnect()
        gateOut.disconnect()
      }
    }
  }
}
