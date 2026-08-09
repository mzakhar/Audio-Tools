export default {
  type: 'delay', name: 'DELAY', group: 'fx', hp: 8, tier: 'native', poly: false,
  ports: [{ id: 'in', dir: 'in', kind: 'audio', label: 'IN' }, { id: 'time', dir: 'in', kind: 'cv', label: 'TIME', atten: true }, { id: 'fb', dir: 'in', kind: 'cv', label: 'FB', atten: true }, { id: 'out', dir: 'out', kind: 'audio', label: 'OUT' }, { id: 'wet', dir: 'out', kind: 'audio', label: 'WET' }],
  params: [
    { key: 'time', label: 'TIME', min: 1, max: 2000, step: 1, def: 300, fmt: 'ms' },
    { key: 'feedback', label: 'FEEDBACK', min: 0, max: 0.95, step: 0.01, def: 0.35, fmt: '' },
    { key: 'tone', label: 'TONE', min: 200, max: 12000, step: 1, def: 6000, fmt: 'Hz' },
    { key: 'mix', label: 'MIX', min: 0, max: 1, step: 0.01, def: 0.5, fmt: '' },
    { key: 'sync', label: 'SYNC', def: false, toggle: true }
  ],
  create(ctx, { params }) {
    const input = ctx.createGain(), delay = ctx.createDelay(2), feedback = ctx.createGain(), tone = ctx.createBiquadFilter(), dry = ctx.createGain(), wet = ctx.createGain(), out = ctx.createGain()
    input.gain.value = dry.gain.value = out.gain.value = 1; delay.delayTime.value = params.time / 1000; feedback.gain.value = params.feedback; tone.type = 'lowpass'; tone.frequency.value = params.tone; wet.gain.value = params.mix
    input.connect(dry); input.connect(delay); delay.connect(tone); tone.connect(feedback); feedback.connect(delay); tone.connect(wet); dry.connect(out); wet.connect(out)
    return {
      inputs: { in: [input], time: [delay.delayTime], fb: [feedback.gain] }, outputs: { out: [out], wet: [tone] },
      setParam(key, value, atTime = ctx.currentTime) { params[key] = value; if (key === 'time') delay.delayTime.setTargetAtTime(value / 1000, atTime, 0.01); else if (key === 'feedback') feedback.gain.setTargetAtTime(value, atTime, 0.01); else if (key === 'tone') tone.frequency.setTargetAtTime(value, atTime, 0.01); else if (key === 'mix') wet.gain.setTargetAtTime(value, atTime, 0.01) },
      dispose() { [input, delay, feedback, tone, dry, wet, out].forEach(n => n.disconnect()) }
    }
  }
}
