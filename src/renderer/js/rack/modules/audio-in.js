// AUDIO IN — the host supplies input; this module deliberately never opens a mic.

export default {
  type: 'audio-in', name: 'AUDIO IN', group: 'io', hp: 4, tier: 'native', poly: false,
  ports: [
    { id: 'l', dir: 'out', kind: 'audio', label: 'L' },
    { id: 'r', dir: 'out', kind: 'audio', label: 'R' }
  ],
  params: [{ key: 'gain', label: 'GAIN', min: 0, max: 2, step: 0.01, def: 1, fmt: '' }],
  create(ctx, { params = {}, input = null } = {}) {
    const inNode = input || ctx.createGain()
    const out = ctx.createGain()
    out.gain.value = params.gain ?? 1
    inNode.connect(out)
    return {
      input: inNode, inputs: {}, outputs: { l: [out], r: [out] },
      setParam(key, value, atTime = ctx.currentTime) { if (key === 'gain') out.gain.setTargetAtTime(value, atTime, 0.01) },
      dispose() { inNode.disconnect(); out.disconnect() }
    }
  }
}
