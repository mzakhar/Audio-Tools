export default {
  type: 'split', name: 'SPLIT', group: 'util', hp: 6, tier: 'native', poly: false,
  ports: [
    { id: 'in', dir: 'in', kind: 'audio', label: 'IN' },
    ...Array.from({ length: 8 }, (_, i) => ({ id: `out${i + 1}`, dir: 'out', kind: 'audio', label: String(i + 1) }))
  ],
  params: [],
  create(ctx) {
    const input = ctx.createGain(); input.gain.value = 1
    const outs = Array.from({ length: 8 }, () => { const out = ctx.createGain(); out.gain.value = 1; input.connect(out); return out })
    return {
      inputs: { in: [input] },
      outputs: Object.fromEntries(outs.map((out, i) => [`out${i + 1}`, [out]])),
      setParam() {},
      dispose() { input.disconnect(); outs.forEach(out => out.disconnect()) }
    }
  }
}
