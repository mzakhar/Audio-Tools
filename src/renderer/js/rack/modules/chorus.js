export default {
  type: 'chorus', name: 'CHORUS', group: 'fx', hp: 6, tier: 'native', poly: true,
  ports: [{ id: 'in', dir: 'in', kind: 'audio', label: 'IN' }, { id: 'rate', dir: 'in', kind: 'cv', label: 'RATE', atten: true }, { id: 'out', dir: 'out', kind: 'audio', label: 'OUT' }],
  params: [
    { key: 'rate', label: 'RATE', min: 0.05, max: 8, step: 0.01, def: 0.8, fmt: 'Hz' },
    { key: 'depth', label: 'DEPTH', min: 0, max: 1, step: 0.01, def: 0.5, fmt: '' },
    { key: 'voices', label: 'VOICES', options: [2, 3], def: 2 },
    { key: 'mix', label: 'MIX', min: 0, max: 1, step: 0.01, def: 0.5, fmt: '' }
  ],
  create(ctx, { channels = 1, params }) {
    const makeVoice = () => {
      const input = ctx.createGain(), dry = ctx.createGain(), wet = ctx.createGain(), out = ctx.createGain(), lfo = ctx.createOscillator(), rate = ctx.createGain()
      const delays = [ctx.createDelay(0.05), ctx.createDelay(0.05), ctx.createDelay(0.05)]
      input.gain.value = dry.gain.value = out.gain.value = 1; wet.gain.value = params.mix; lfo.frequency.value = params.rate; rate.gain.value = params.rate
      input.connect(dry); dry.connect(out); input.connect(delays[0]); input.connect(delays[1]); input.connect(delays[2]); delays.forEach((delay, i) => { delay.delayTime.value = 0.012 + i * 0.003; delay.connect(wet) }); wet.connect(out)
      const depth = 0.001 + params.depth * 0.009
      delays.forEach((delay, i) => { const mod = ctx.createGain(); mod.gain.value = i < params.voices ? depth : 0; lfo.connect(mod); mod.connect(delay.delayTime); delay.mod = mod })
      lfo.start()
      return { input, dry, wet, out, lfo, rate, delays }
    }
    const voices = Array.from({ length: channels }, makeVoice)
    const setDepth = value => voices.forEach(v => v.delays.forEach((delay, i) => delay.mod.gain.setTargetAtTime(i < params.voices ? 0.001 + value * 0.009 : 0, ctx.currentTime, 0.01)))
    return {
      inputs: { in: voices.map(v => v.input), rate: voices.map(v => v.rate.gain) }, outputs: { out: voices.map(v => v.out) },
      setParam(key, value, atTime = ctx.currentTime) { params[key] = value; if (key === 'rate') voices.forEach(v => v.lfo.frequency.setTargetAtTime(value, atTime, 0.01)); else if (key === 'depth' || key === 'voices') setDepth(params.depth); else if (key === 'mix') voices.forEach(v => v.wet.gain.setTargetAtTime(value, atTime, 0.01)) },
      dispose() { voices.forEach(v => { v.lfo.stop(); [v.input, v.dry, v.wet, v.out, v.lfo, v.rate, ...v.delays].forEach(n => n.disconnect()); v.delays.forEach(delay => delay.mod.disconnect()) }) }
    }
  }
}
