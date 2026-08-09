export default {
  type: 'merge', name: 'MERGE', group: 'util', hp: 6, tier: 'native', poly: true,
  polySource: (mod, rack) => rack.cables.filter(c => c.to.moduleId === mod.id).length,
  ports: [
    ...Array.from({ length: 8 }, (_, i) => ({ id: `in${i + 1}`, dir: 'in', kind: 'audio', label: String(i + 1) })),
    { id: 'out', dir: 'out', kind: 'audio', label: 'OUT' }
  ],
  params: [],
  create(ctx, { channels = 1 }) {
    const voices = Array.from({ length: channels }, () => { const input = ctx.createGain(); const out = ctx.createGain(); input.gain.value = out.gain.value = 1; input.connect(out); return { input, out } })
    return {
      inputs: Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`in${i + 1}`, voices.map(v => v.input)])),
      outputs: { out: voices.map(v => v.out) }, setParam() {},
      dispose() { voices.forEach(v => { v.input.disconnect(); v.out.disconnect() }) }
    }
  }
}
