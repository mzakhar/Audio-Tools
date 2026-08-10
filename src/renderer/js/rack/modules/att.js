// ATT — dual attenuverter/offset.
//
// Per strip: input GainNode with gain = attenuvert (negative gain inverts,
// exactly an attenuverter) summed with a ConstantSourceNode(offset) into the
// output GainNode.

export default {
  type: 'att',
  name: 'ATT',
  group: 'util',
  hp: 4,
  tier: 'native',
  poly: true,
  ports: [
    { id: 'in1',  dir: 'in',  kind: 'cv', label: 'IN1' },
    { id: 'in2',  dir: 'in',  kind: 'cv', label: 'IN2' },
    { id: 'out1', dir: 'out', kind: 'cv', label: 'OUT1' },
    { id: 'out2', dir: 'out', kind: 'cv', label: 'OUT2' }
  ],
  params: [
    { key: 'att1', label: 'ATT1', min: -1, max: 1, step: 0.01, def: 0, fmt: '' },
    { key: 'off1', label: 'OFF1', min: -1, max: 1, step: 0.01, def: 0, fmt: '' },
    { key: 'att2', label: 'ATT2', min: -1, max: 1, step: 0.01, def: 0, fmt: '' },
    { key: 'off2', label: 'OFF2', min: -1, max: 1, step: 0.01, def: 0, fmt: '' }
  ],

  create(ctx, { channels = 1, params }) {
    function makeStrip(att, off) {
      const attGain = ctx.createGain()
      attGain.gain.value = att
      const offset = ctx.createConstantSource()
      offset.offset.value = off
      offset.start()
      const out = ctx.createGain()
      out.gain.value = 1
      attGain.connect(out)
      offset.connect(out)
      return { attGain, offset, out }
    }

    const voices = []
    for (let i = 0; i < channels; i++) {
      voices.push({
        s1: makeStrip(params.att1, params.off1),
        s2: makeStrip(params.att2, params.off2)
      })
    }

    return {
      inputs: {
        in1: voices.map(v => v.s1.attGain),
        in2: voices.map(v => v.s2.attGain)
      },
      outputs: {
        out1: voices.map(v => v.s1.out),
        out2: voices.map(v => v.s2.out)
      },

      setParam(key, value, atTime = ctx.currentTime) {
        params[key] = value
        for (const v of voices) {
          if (key === 'att1') v.s1.attGain.gain.setTargetAtTime(value, atTime, 0.01)
          else if (key === 'off1') v.s1.offset.offset.setTargetAtTime(value, atTime, 0.01)
          else if (key === 'att2') v.s2.attGain.gain.setTargetAtTime(value, atTime, 0.01)
          else if (key === 'off2') v.s2.offset.offset.setTargetAtTime(value, atTime, 0.01)
        }
      },

      dispose() {
        for (const v of voices) {
          v.s1.offset.stop()
          v.s2.offset.stop()
          v.s1.attGain.disconnect()
          v.s1.offset.disconnect()
          v.s1.out.disconnect()
          v.s2.attGain.disconnect()
          v.s2.offset.disconnect()
          v.s2.out.disconnect()
        }
        voices.length = 0
      }
    }
  }
}
