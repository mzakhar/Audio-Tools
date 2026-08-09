// VCF — voltage controlled filter.
//
// CUT CV runs through a GainNode(PITCH_CV_GAIN) into filter.detune — same
// 1 V/oct trick as VCO's pitch input, so filter tracking is exact and free.
// RES CV modulates Q linearly through a GainNode(10). 24 dB slope cascades
// two biquads fed the same detune/Q CV, with base Q split (Q/2 each) so the
// stack doesn't ring twice as hard.
//
// ponytail: slope change rebuilds the biquad chain (build()) rather than
// crossfading — a click is possible on slope switch, acceptable for a knob
// nobody automates mid-note.

import { PITCH_CV_GAIN } from '../../utils/cv.js'

const TYPE = { lp: 'lowpass', hp: 'highpass', bp: 'bandpass', notch: 'notch' }

export default {
  type: 'vcf',
  name: 'VCF',
  group: 'filter',
  hp: 10,
  tier: 'native',
  poly: true,
  ports: [
    { id: 'in',  dir: 'in',  kind: 'audio', label: 'IN' },
    { id: 'cut', dir: 'in',  kind: 'cv',    label: 'CUT', atten: true },
    { id: 'res', dir: 'in',  kind: 'cv',    label: 'RES', atten: true },
    { id: 'out', dir: 'out', kind: 'audio', label: 'OUT' }
  ],
  params: [
    { key: 'cutoff', label: 'CUTOFF', min: 20, max: 18000, step: 1,    def: 1200, fmt: 'Hz' },
    { key: 'res',    label: 'RES',    min: 0,  max: 0.95,  step: 0.01, def: 0.2,  fmt: '' },
    { key: 'mode',   label: 'MODE',   options: ['lp', 'hp', 'bp', 'notch'], def: 'lp' },
    { key: 'slope',  label: 'SLOPE',  options: [12, 24], def: 12 }
  ],

  create(ctx, { channels = 1, params }) {
    function build(v) {
      if (v.filters) {
        v.in.disconnect()
        v.cutGain.disconnect()
        v.resGain.disconnect()
        for (const f of v.filters) f.disconnect()
      }
      const count = params.slope === 24 ? 2 : 1
      const filters = []
      for (let i = 0; i < count; i++) {
        const f = ctx.createBiquadFilter()
        f.type = TYPE[params.mode] || 'lowpass'
        f.frequency.value = params.cutoff
        f.Q.value = (params.res * 10) / count
        filters.push(f)
      }
      let node = v.in
      for (const f of filters) { node.connect(f); node = f }
      node.connect(v.out)
      for (const f of filters) {
        v.cutGain.connect(f.detune)
        v.resGain.connect(f.Q)
      }
      v.filters = filters
    }

    const voices = []
    for (let i = 0; i < channels; i++) {
      const inNode = ctx.createGain()
      inNode.gain.value = 1
      const out = ctx.createGain()
      out.gain.value = 1
      const cutGain = ctx.createGain()
      cutGain.gain.value = PITCH_CV_GAIN
      const resGain = ctx.createGain()
      resGain.gain.value = 10

      const v = { in: inNode, out, cutGain, resGain, filters: null }
      build(v)
      voices.push(v)
    }

    return {
      inputs: {
        in:  voices.map(v => v.in),
        cut: voices.map(v => v.cutGain),
        res: voices.map(v => v.resGain)
      },
      outputs: {
        out: voices.map(v => v.out)
      },

      setParam(key, value, atTime = ctx.currentTime) {
        params[key] = value
        for (const v of voices) {
          if (key === 'cutoff') {
            for (const f of v.filters) f.frequency.setTargetAtTime(value, atTime, 0.01)
          } else if (key === 'res') {
            const q = (value * 10) / v.filters.length
            for (const f of v.filters) f.Q.setTargetAtTime(q, atTime, 0.01)
          } else if (key === 'mode') {
            const type = TYPE[value] || 'lowpass'
            for (const f of v.filters) f.type = type
          } else if (key === 'slope') {
            build(v)
          }
        }
      },

      dispose() {
        for (const v of voices) {
          v.in.disconnect()
          v.out.disconnect()
          v.cutGain.disconnect()
          v.resGain.disconnect()
          for (const f of v.filters) f.disconnect()
        }
        voices.length = 0
      }
    }
  }
}
