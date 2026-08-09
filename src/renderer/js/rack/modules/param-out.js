// PARAM OUT — host polls analyser at control rate and applies the mapped value.

export default {
  type: 'param-out', name: 'PARAM OUT', group: 'io', hp: 6, tier: 'native', poly: false,
  ports: [{ id: 'in', dir: 'in', kind: 'cv', label: 'IN' }],
  params: [
    { key: 'target', label: 'TARGET', options: ['none'], def: 'none' },
    { key: 'min', label: 'MIN', min: -1, max: 1, step: 0.01, def: 0, fmt: '' },
    { key: 'max', label: 'MAX', min: -1, max: 1, step: 0.01, def: 1, fmt: '' },
    { key: 'smoothing', label: 'SMOOTH', min: 0, max: 500, step: 1, def: 50, fmt: 'ms' }
  ],
  create(ctx, { params = {}, onParam = null, poll: rackPoll = null } = {}) {
    const input = ctx.createGain()
    const analyser = ctx.createAnalyser()
    input.connect(analyser)
    const values = new Float32Array(analyser.fftSize)
    const poll = () => {
      if (!onParam || params.target === 'none' || !analyser.getFloatTimeDomainData) return
      analyser.getFloatTimeDomainData(values)
      const cv = values.reduce((sum, value) => sum + value, 0) / values.length
      onParam(params.target, params.min + (cv + 1) / 2 * (params.max - params.min), params.smoothing)
    }
    const removePoll = rackPoll?.add(poll)
    return {
      inputs: { in: [input] }, outputs: {}, analyser,
      setParam(key, value) { params[key] = value },
      dispose() { removePoll?.(); input.disconnect(); analyser.disconnect() }
    }
  }
}
