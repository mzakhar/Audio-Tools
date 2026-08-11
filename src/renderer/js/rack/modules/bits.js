// BITS — bit-depth crusher. A quantizing WaveShaper curve plus dry/wet.
//
// Bit depth only. Sample-rate reduction — the other half of a real bitcrusher —
// needs a per-sample hold across render quanta, which a WaveShaper cannot do;
// it stays on the deferred worklet list (spec §8).
//
// ponytail: the curve table is 8193 points, so above ~12 bits the steps are
// finer than the table can resolve and the effect fades to clean. That is the
// correct-sounding end of the knob anyway; exact 16-bit quantization would need
// a 65537-point table or a worklet.

export function bitsCurve(bits, n = 8193) {
  const levels = Math.pow(2, Math.max(1, bits)) / 2
  const curve = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1
    curve[i] = Math.max(-1, Math.min(1, Math.round(x * levels) / levels))
  }
  return curve
}

export default {
  type: 'bits', name: 'BITS', group: 'fx', hp: 6, tier: 'native', poly: true,
  ports: [
    { id: 'in', dir: 'in', kind: 'audio', label: 'IN' },
    { id: 'amt', dir: 'in', kind: 'cv', label: 'AMT', atten: true },
    { id: 'out', dir: 'out', kind: 'audio', label: 'OUT' }
  ],
  params: [
    { key: 'bits', label: 'BITS', min: 2, max: 16, step: 1, def: 8, fmt: '' },
    { key: 'mix', label: 'MIX', min: 0, max: 1, step: 0.01, def: 1, fmt: '' }
  ],

  create(ctx, { channels = 1, params }) {
    const voices = Array.from({ length: channels }, () => {
      const input = ctx.createGain(), shaper = ctx.createWaveShaper(), dry = ctx.createGain(), wet = ctx.createGain(), out = ctx.createGain()
      input.gain.value = out.gain.value = 1
      shaper.curve = bitsCurve(params.bits)
      shaper.oversample = 'none'   // oversampling would interpolate the staircase away
      dry.gain.value = 1 - params.mix
      wet.gain.value = params.mix  // AMT rides this param at audio rate
      input.connect(shaper); shaper.connect(wet); input.connect(dry)
      wet.connect(out); dry.connect(out)
      return { input, shaper, dry, wet, out }
    })

    return {
      inputs: { in: voices.map(v => v.input), amt: voices.map(v => v.wet.gain) },
      outputs: { out: voices.map(v => v.out) },
      setParam(key, value, atTime = ctx.currentTime) {
        params[key] = value
        if (key === 'bits') {
          const curve = bitsCurve(value)
          voices.forEach(v => { v.shaper.curve = curve })
        } else if (key === 'mix') {
          voices.forEach(v => { v.wet.gain.setTargetAtTime(value, atTime, 0.01); v.dry.gain.setTargetAtTime(1 - value, atTime, 0.01) })
        }
      },
      dispose() { voices.forEach(v => Object.values(v).forEach(n => n.disconnect())) }
    }
  }
}
