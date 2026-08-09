// VCA — voltage controlled amplifier.
//
// Two gain stages in series, because a VCA multiplies: audio → knob stage →
// CV stage → out. CV connects straight to the second stage's gain AudioParam,
// the canonical Web Audio patch. Summing knob and CV into one param would make
// them add instead of scale, and an unpatched VCA would sit above unity.
// exp response runs the CV through a WaveShaperNode with a quadratic
// (sign-preserving x^2) curve; curve = null for lin is an identity
// pass-through, so response switches without rewiring.
//
// The CV input is normalled to unity via a ConstantSourceNode(1) so an
// unpatched VCA passes audio at the GAIN knob. The engine calls
// setInputPatched() to drop that normal when a cable lands on CV — otherwise
// the patched envelope would add to unity instead of replacing it, and the VCA
// would sit wide open.

export default {
  type: 'vca',
  name: 'VCA',
  group: 'util',
  hp: 6,
  tier: 'native',
  poly: true,
  ports: [
    { id: 'in',  dir: 'in',  kind: 'audio', label: 'IN' },
    { id: 'cv',  dir: 'in',  kind: 'cv',    label: 'CV', atten: true },
    { id: 'out', dir: 'out', kind: 'audio', label: 'OUT' }
  ],
  params: [
    { key: 'gain',     label: 'GAIN',     min: 0, max: 1, step: 0.01, def: 0.8, fmt: '' },
    { key: 'response', label: 'RESPONSE', options: ['lin', 'exp'], def: 'lin' }
  ],

  create(ctx, { channels = 1, params }) {
    const expCurve = new Float32Array(257)
    for (let i = 0; i < expCurve.length; i++) {
      const t = (i / (expCurve.length - 1)) * 2 - 1
      expCurve[i] = Math.sign(t) * t * t
    }

    const voices = []
    for (let i = 0; i < channels; i++) {
      const knob = ctx.createGain()
      knob.gain.value = params.gain

      const vca = ctx.createGain()
      vca.gain.value = 0            // driven entirely by the normal + CV

      const cvPass = ctx.createGain()
      cvPass.gain.value = 1

      const shaper = ctx.createWaveShaper()
      shaper.curve = params.response === 'exp' ? expCurve : null

      const normalSource = ctx.createConstantSource()
      normalSource.offset.value = 1
      normalSource.start()

      knob.connect(vca)
      cvPass.connect(shaper)
      shaper.connect(vca.gain)
      normalSource.connect(vca.gain)   // normal ON by default

      voices.push({ knob, vca, cvPass, shaper, normalSource, normalled: true })
    }

    return {
      inputs: {
        in: voices.map(v => v.knob),
        cv: voices.map(v => v.cvPass)
      },
      outputs: {
        out: voices.map(v => v.vca)
      },

      setInputPatched(portId, patched) {
        if (portId !== 'cv') return
        const on = !patched
        for (const v of voices) {
          if (on === v.normalled) continue
          if (on) v.normalSource.connect(v.vca.gain)
          else v.normalSource.disconnect(v.vca.gain)
          v.normalled = on
        }
      },

      setParam(key, value, atTime = ctx.currentTime) {
        params[key] = value
        for (const v of voices) {
          if (key === 'gain') {
            v.knob.gain.setTargetAtTime(value, atTime, 0.01)
          } else if (key === 'response') {
            v.shaper.curve = value === 'exp' ? expCurve : null
          }
        }
      },

      dispose() {
        for (const v of voices) {
          v.normalSource.stop()
          v.knob.disconnect()
          v.vca.disconnect()
          v.cvPass.disconnect()
          v.shaper.disconnect()
          v.normalSource.disconnect()
        }
        voices.length = 0
      }
    }
  }
}
