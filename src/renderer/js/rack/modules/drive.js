const curves = Object.fromEntries(['soft', 'hard', 'asym'].map(kind => {
  const curve = new Float32Array(1025)
  for (let i = 0; i < curve.length; i++) {
    const x = (i / (curve.length - 1)) * 2 - 1
    curve[i] = kind === 'hard' ? Math.max(-1, Math.min(1, x * 3)) : kind === 'asym' ? Math.tanh(x * (x < 0 ? 1.5 : 3)) : Math.tanh(x * 2)
  }
  return [kind, curve]
}))

export default {
  type: 'drive', name: 'DRIVE', group: 'filter', hp: 6, tier: 'native', poly: true,
  ports: [{ id: 'in', dir: 'in', kind: 'audio', label: 'IN' }, { id: 'amt', dir: 'in', kind: 'cv', label: 'AMT', atten: true }, { id: 'out', dir: 'out', kind: 'audio', label: 'OUT' }],
  params: [
    { key: 'drive', label: 'DRIVE', min: 0, max: 1, step: 0.01, def: 0.5, fmt: '' },
    { key: 'tone', label: 'TONE', min: 0, max: 1, step: 0.01, def: 0.5, fmt: '' },
    { key: 'mix', label: 'MIX', min: 0, max: 1, step: 0.01, def: 1, fmt: '' },
    { key: 'curve', label: 'CURVE', options: ['soft', 'hard', 'asym'], def: 'soft' }
  ],
  create(ctx, { channels = 1, params }) {
    const voices = Array.from({ length: channels }, () => {
      const input = ctx.createGain(), pre = ctx.createGain(), shaper = ctx.createWaveShaper(), tone = ctx.createBiquadFilter(), dry = ctx.createGain(), wet = ctx.createGain(), out = ctx.createGain()
      input.gain.value = dry.gain.value = out.gain.value = 1; pre.gain.value = 1 + params.drive * 19; shaper.curve = curves[params.curve]; shaper.oversample = '4x'; tone.type = 'lowpass'; tone.frequency.value = 500 + params.tone * 11500; wet.gain.value = params.mix
      input.connect(pre); input.connect(dry); pre.connect(shaper); shaper.connect(tone); tone.connect(wet); dry.connect(out); wet.connect(out)
      return { input, pre, shaper, tone, dry, wet, out }
    })
    return {
      inputs: { in: voices.map(v => v.input), amt: voices.map(v => v.pre.gain) }, outputs: { out: voices.map(v => v.out) },
      setParam(key, value, atTime = ctx.currentTime) { params[key] = value; voices.forEach(v => { if (key === 'drive') v.pre.gain.setTargetAtTime(1 + value * 19, atTime, 0.01); else if (key === 'tone') v.tone.frequency.setTargetAtTime(500 + value * 11500, atTime, 0.01); else if (key === 'mix') v.wet.gain.setTargetAtTime(value, atTime, 0.01); else if (key === 'curve') v.shaper.curve = curves[value] }) },
      dispose() { voices.forEach(v => Object.values(v).forEach(n => n.disconnect())) }
    }
  }
}
