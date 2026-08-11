// FOLD — wavefolder. Was a worklet placeholder; it never needed to be one.
//
// A triangle-folding WaveShaper at 4x oversample, fed by a pre-gain. Folding
// amount *is* input drive, so the AMT jack lands straight on that pre-gain's
// AudioParam and modulates at true audio rate — no poll, no worklet.
//
// The curve is rebuilt only when FOLD or SYM change (knob rate). WaveShaper
// clamps its input to [-1, 1] before the table lookup, so GAIN/AMT above unity
// drives deeper into the folds baked into the curve and then stops at the
// outermost one — a saturation ceiling, not a fold count that grows forever.

// Triangle fold: identity for |y| <= 1, folds back on itself beyond it.
const tri = y => (2 / Math.PI) * Math.asin(Math.sin(y * Math.PI / 2))

export function foldCurve(fold, symmetry, n = 2049) {
  const curve = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1
    curve[i] = tri(x * fold + symmetry)
  }
  return curve
}

export default {
  type: 'fold', name: 'FOLD', group: 'fx', hp: 6, tier: 'native', poly: true,
  ports: [
    { id: 'in', dir: 'in', kind: 'audio', label: 'IN' },
    { id: 'amt', dir: 'in', kind: 'cv', label: 'AMT', atten: true },
    { id: 'out', dir: 'out', kind: 'audio', label: 'OUT' }
  ],
  params: [
    { key: 'fold', label: 'FOLD', min: 1, max: 8, step: .1, def: 2, fmt: '' },
    { key: 'symmetry', label: 'SYM', min: -1, max: 1, step: .01, def: 0, fmt: '' },
    { key: 'gain', label: 'GAIN', min: 0, max: 2, step: .01, def: 1, fmt: '' }
  ],

  create(ctx, { channels = 1, params }) {
    const voices = Array.from({ length: channels }, () => {
      const input = ctx.createGain(), pre = ctx.createGain(), shaper = ctx.createWaveShaper(), out = ctx.createGain()
      input.gain.value = out.gain.value = 1
      pre.gain.value = params.gain
      shaper.curve = foldCurve(params.fold, params.symmetry)
      shaper.oversample = '4x'
      input.connect(pre); pre.connect(shaper); shaper.connect(out)
      return { input, pre, shaper, out }
    })

    return {
      inputs: { in: voices.map(v => v.input), amt: voices.map(v => v.pre.gain) },
      outputs: { out: voices.map(v => v.out) },
      setParam(key, value, atTime = ctx.currentTime) {
        params[key] = value
        if (key === 'gain') { voices.forEach(v => v.pre.gain.setTargetAtTime(value, atTime, 0.01)); return }
        if (key !== 'fold' && key !== 'symmetry') return
        const curve = foldCurve(params.fold, params.symmetry)
        voices.forEach(v => { v.shaper.curve = curve })
      },
      dispose() { voices.forEach(v => Object.values(v).forEach(n => n.disconnect())) }
    }
  }
}
