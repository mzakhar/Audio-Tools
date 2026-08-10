// MIX — 4-input mixer.
//
// Four level GainNodes sum into one node (Web Audio input summing is free),
// then a MASTER GainNode, then a GainNode(-1) tap for the inverted sum.

export default {
  type: 'mix',
  name: 'MIX',
  group: 'util',
  hp: 6,
  tier: 'native',
  poly: true,
  ports: [
    { id: 'in1', dir: 'in',  kind: 'audio', label: 'IN1' },
    { id: 'in2', dir: 'in',  kind: 'audio', label: 'IN2' },
    { id: 'in3', dir: 'in',  kind: 'audio', label: 'IN3' },
    { id: 'in4', dir: 'in',  kind: 'audio', label: 'IN4' },
    { id: 'out', dir: 'out', kind: 'audio', label: 'OUT' },
    { id: 'inv', dir: 'out', kind: 'audio', label: 'SUM−' }
  ],
  params: [
    { key: 'lvl1',   label: 'LVL1',   min: 0, max: 1, step: 0.01, def: 0.8, fmt: '' },
    { key: 'lvl2',   label: 'LVL2',   min: 0, max: 1, step: 0.01, def: 0.8, fmt: '' },
    { key: 'lvl3',   label: 'LVL3',   min: 0, max: 1, step: 0.01, def: 0.8, fmt: '' },
    { key: 'lvl4',   label: 'LVL4',   min: 0, max: 1, step: 0.01, def: 0.8, fmt: '' },
    { key: 'master', label: 'MASTER', min: 0, max: 1, step: 0.01, def: 0.8, fmt: '' }
  ],

  create(ctx, { channels = 1, params }) {
    const voices = []
    for (let i = 0; i < channels; i++) {
      const lvl1 = ctx.createGain()
      lvl1.gain.value = params.lvl1
      const lvl2 = ctx.createGain()
      lvl2.gain.value = params.lvl2
      const lvl3 = ctx.createGain()
      lvl3.gain.value = params.lvl3
      const lvl4 = ctx.createGain()
      lvl4.gain.value = params.lvl4

      const sum = ctx.createGain()
      sum.gain.value = 1
      const master = ctx.createGain()
      master.gain.value = params.master
      const inv = ctx.createGain()
      inv.gain.value = -1

      lvl1.connect(sum)
      lvl2.connect(sum)
      lvl3.connect(sum)
      lvl4.connect(sum)
      sum.connect(master)
      master.connect(inv)

      voices.push({ lvl1, lvl2, lvl3, lvl4, sum, master, inv })
    }

    return {
      inputs: {
        in1: voices.map(v => v.lvl1),
        in2: voices.map(v => v.lvl2),
        in3: voices.map(v => v.lvl3),
        in4: voices.map(v => v.lvl4)
      },
      outputs: {
        out: voices.map(v => v.master),
        inv: voices.map(v => v.inv)
      },

      setParam(key, value, atTime = ctx.currentTime) {
        params[key] = value
        for (const v of voices) {
          if (key === 'lvl1') v.lvl1.gain.setTargetAtTime(value, atTime, 0.01)
          else if (key === 'lvl2') v.lvl2.gain.setTargetAtTime(value, atTime, 0.01)
          else if (key === 'lvl3') v.lvl3.gain.setTargetAtTime(value, atTime, 0.01)
          else if (key === 'lvl4') v.lvl4.gain.setTargetAtTime(value, atTime, 0.01)
          else if (key === 'master') v.master.gain.setTargetAtTime(value, atTime, 0.01)
        }
      },

      dispose() {
        for (const v of voices) {
          for (const node of Object.values(v)) node.disconnect()
        }
        voices.length = 0
      }
    }
  }
}
