// Two independent gate buses in one panel — each an IN fanned to four OUTs,
// sharing nothing with the other. Same fan-out shape as mult, just twice.
export default {
  type: 'bus', name: 'BUS', group: 'util', hp: 14, tier: 'native', poly: true, util: true,
  ports: [
    { id: 'in1', dir: 'in', kind: 'gate', label: 'IN 1', row: 0 },
    { id: 'a1', dir: 'out', kind: 'gate', label: '1', row: 0 },
    { id: 'b1', dir: 'out', kind: 'gate', label: '2', row: 0 },
    { id: 'c1', dir: 'out', kind: 'gate', label: '3', row: 0 },
    { id: 'd1', dir: 'out', kind: 'gate', label: '4', row: 0 },
    { id: 'in2', dir: 'in', kind: 'gate', label: 'IN 2', row: 1 },
    { id: 'a2', dir: 'out', kind: 'gate', label: '1', row: 1 },
    { id: 'b2', dir: 'out', kind: 'gate', label: '2', row: 1 },
    { id: 'c2', dir: 'out', kind: 'gate', label: '3', row: 1 },
    { id: 'd2', dir: 'out', kind: 'gate', label: '4', row: 1 }
  ],
  params: [],
  create(ctx, { channels = 1 }) {
    function makeBus() {
      const input = ctx.createGain(); input.gain.value = 1
      const outs = [ctx.createGain(), ctx.createGain(), ctx.createGain(), ctx.createGain()]
      outs.forEach(out => { out.gain.value = 1; input.connect(out) })
      return { input, outs }
    }
    const voices = Array.from({ length: channels }, () => ({ bus1: makeBus(), bus2: makeBus() }))
    return {
      inputs: { in1: voices.map(v => v.bus1.input), in2: voices.map(v => v.bus2.input) },
      outputs: {
        ...Object.fromEntries(['a', 'b', 'c', 'd'].map((k, n) => [k + '1', voices.map(v => v.bus1.outs[n])])),
        ...Object.fromEntries(['a', 'b', 'c', 'd'].map((k, n) => [k + '2', voices.map(v => v.bus2.outs[n])]))
      },
      setParam() {},
      dispose() {
        voices.forEach(v => {
          v.bus1.input.disconnect(); v.bus1.outs.forEach(n => n.disconnect())
          v.bus2.input.disconnect(); v.bus2.outs.forEach(n => n.disconnect())
        })
      }
    }
  }
}
