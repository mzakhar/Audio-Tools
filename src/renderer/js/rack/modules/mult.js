export default {
  type: 'mult', name: 'MULT', group: 'util', hp: 2, tier: 'native', poly: true,
  ports: [
    { id: 'in', dir: 'in', kind: 'audio', label: 'IN' },
    { id: 'out1', dir: 'out', kind: 'audio', label: 'OUT1' },
    { id: 'out2', dir: 'out', kind: 'audio', label: 'OUT2' },
    { id: 'out3', dir: 'out', kind: 'audio', label: 'OUT3' }
  ],
  params: [],
  create(ctx, { channels = 1 }) {
    const voices = Array.from({ length: channels }, () => {
      const input = ctx.createGain(); input.gain.value = 1
      const outs = [ctx.createGain(), ctx.createGain(), ctx.createGain()]
      outs.forEach(out => { out.gain.value = 1; input.connect(out) })
      return { input, outs }
    })
    return {
      inputs: { in: voices.map(v => v.input) },
      outputs: Object.fromEntries([1, 2, 3].map(n => [`out${n}`, voices.map(v => v.outs[n - 1])])),
      setParam() {},
      dispose() { voices.forEach(v => { v.input.disconnect(); v.outs.forEach(n => n.disconnect()) }) }
    }
  }
}
