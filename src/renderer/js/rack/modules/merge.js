// MERGE — up to 8 mono inputs into one poly cable (specs/modular-rack.md §7).
//
// Jack N is channel N. The jacks are therefore always present — all 8 of them,
// whatever the channel count — while the output carries only as many channels
// as there are occupied jacks. A jack past the channel count is a dead end, the
// way an unassigned input is on hardware.

const JACKS = 8

// Channels come from the highest occupied jack, not the number of cables:
// patching in1 and in5 has to yield 5 channels, or in5 lands on a voice that
// was never built and goes silent.
function highestJack(mod, rack) {
  return rack.cables.reduce((max, cable) => {
    if (cable.to.moduleId !== mod.id) return max
    return Math.max(max, Number(cable.to.port.replace('in', '')) || 0)
  }, 0)
}

export default {
  type: 'merge', name: 'MERGE', group: 'util', hp: 6, tier: 'native', poly: true,
  polySource: highestJack,
  ports: [
    ...Array.from({ length: JACKS }, (_, i) => ({ id: `in${i + 1}`, dir: 'in', kind: 'audio', label: String(i + 1) })),
    { id: 'out', dir: 'out', kind: 'audio', label: 'OUT' }
  ],
  params: [],
  create(ctx, { channels = 1 }) {
    const outs = Array.from({ length: channels }, () => { const g = ctx.createGain(); g.gain.value = 1; return g })
    const ins = Array.from({ length: JACKS }, (_, i) => {
      const g = ctx.createGain(); g.gain.value = 1
      if (outs[i]) g.connect(outs[i])
      return g
    })
    return {
      inputs: Object.fromEntries(ins.map((g, i) => [`in${i + 1}`, [g]])),
      outputs: { out: outs },
      setParam() {},
      dispose() { for (const g of [...ins, ...outs]) g.disconnect() }
    }
  }
}
