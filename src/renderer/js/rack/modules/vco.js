// VCO — voltage controlled oscillator.
//
// V/OCT runs through a fixed GainNode(12000) into `osc.detune`: 0.1 in =
// 1200 cents = one octave, so 1 V/oct tracking is exact and free. TUNE/FINE
// are a ConstantSourceNode into the same param — summing costs nothing.
//
// ponytail: no PW (needs the two-saw phase-difference trick with an
// frequency-tracking DelayNode) and no SYNC (needs oscillator recreation at a
// scheduled time). Both are worth adding once the panel UI exists to show them.

import { C4_HZ, PITCH_CV_GAIN } from '../../utils/cv.js'

const WAVE = { saw: 'sawtooth', square: 'square', tri: 'triangle', sine: 'sine' }

export default {
  type: 'vco',
  name: 'VCO',
  group: 'source',
  hp: 10,
  tier: 'native',
  poly: true,
  ports: [
    { id: 'v_oct', dir: 'in',  kind: 'cv',    label: 'V/OCT' },
    { id: 'fm',    dir: 'in',  kind: 'cv',    label: 'FM', atten: true },
    { id: 'out',   dir: 'out', kind: 'audio', label: 'OUT' },
    { id: 'sub',   dir: 'out', kind: 'audio', label: 'SUB' }
  ],
  params: [
    { key: 'tune',   label: 'TUNE', min: -24,  max: 24,  step: 1, def: 0, fmt: 'st' },
    { key: 'fine',   label: 'FINE', min: -100, max: 100, step: 1, def: 0, fmt: 'c' },
    { key: 'wave',   label: 'WAVE', options: ['saw', 'square', 'tri', 'sine'], def: 'saw' },
    { key: 'suboct', label: 'SUB',  options: [-1, -2], def: -1 },
    { key: 'level',  label: 'LEVEL', min: 0, max: 1, step: 0.01, def: 0.8, fmt: '' }
  ],

  create(ctx, { channels = 1, params }) {
    const voices = []
    for (let i = 0; i < channels; i++) {
      const pitch = ctx.createGain()
      pitch.gain.value = PITCH_CV_GAIN

      const fm = ctx.createGain()
      fm.gain.value = 1200            // 1 unit of FM CV = one octave

      const offset = ctx.createConstantSource()
      offset.offset.value = params.tune * 100 + params.fine

      const subOffset = ctx.createConstantSource()
      subOffset.offset.value = params.suboct * 1200

      const osc = ctx.createOscillator()
      osc.type = WAVE[params.wave] || 'sawtooth'
      osc.frequency.value = C4_HZ

      const sub = ctx.createOscillator()
      sub.type = 'square'
      sub.frequency.value = C4_HZ

      const out = ctx.createGain()
      out.gain.value = params.level
      const subOut = ctx.createGain()
      subOut.gain.value = params.level

      pitch.connect(osc.detune)
      pitch.connect(sub.detune)
      fm.connect(osc.detune)
      offset.connect(osc.detune)
      offset.connect(sub.detune)
      subOffset.connect(sub.detune)
      osc.connect(out)
      sub.connect(subOut)

      osc.start()
      sub.start()
      offset.start()
      subOffset.start()

      voices.push({ pitch, fm, offset, subOffset, osc, sub, out, subOut })
    }

    return {
      inputs: {
        v_oct: voices.map(v => v.pitch),
        fm:    voices.map(v => v.fm)
      },
      outputs: {
        out: voices.map(v => v.out),
        sub: voices.map(v => v.subOut)
      },

      setParam(key, value, atTime = ctx.currentTime) {
        for (const v of voices) {
          if (key === 'tune' || key === 'fine') {
            const cents = (key === 'tune' ? value : params.tune) * 100 +
                          (key === 'fine' ? value : params.fine)
            v.offset.offset.setTargetAtTime(cents, atTime, 0.01)
          } else if (key === 'wave') {
            v.osc.type = WAVE[value] || 'sawtooth'
          } else if (key === 'suboct') {
            v.subOffset.offset.setTargetAtTime(value * 1200, atTime, 0.01)
          } else if (key === 'level') {
            v.out.gain.setTargetAtTime(value, atTime, 0.01)
            v.subOut.gain.setTargetAtTime(value, atTime, 0.01)
          }
        }
        params[key] = value
      },

      dispose() {
        for (const v of voices) {
          v.osc.stop()
          v.sub.stop()
          v.offset.stop()
          v.subOffset.stop()
          for (const node of Object.values(v)) node.disconnect()
        }
        voices.length = 0
      }
    }
  }
}
