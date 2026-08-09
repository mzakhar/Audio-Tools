export default {
  type: 'sum', name: 'SUM', group: 'util', hp: 4, tier: 'native', poly: false,
  ports: [
    { id: 'in', dir: 'in', kind: 'audio', label: 'IN' },
    { id: 'out', dir: 'out', kind: 'audio', label: 'OUT' }
  ],
  params: [{ key: 'normalize', label: 'NORMALIZE', def: false, toggle: true }],
  create(ctx, { params }) {
    const input = ctx.createGain(); input.gain.value = 1
    const out = ctx.createGain(); out.gain.value = 1
    input.connect(out)
    return {
      inputs: { in: [input] }, outputs: { out: [out] },
      // The engine owns cable fan-in, so source count is unavailable here.
      setParam(key, value) { params[key] = value },
      dispose() { input.disconnect(); out.disconnect() }
    }
  }
}
