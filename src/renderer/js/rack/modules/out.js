// OUT — terminal module. `terminal: true` tells the engine to connect this
// module's `output` node to the rack's destination (its mixer channel input,
// or the insert chain's output).
//
// ponytail: mono by design, one IN jack. True stereo needs a ChannelMerger
// plus normalling (R follows L when unpatched), which needs the engine to
// tell a module which of its inputs are patched — add that when a stereo
// module (CHORUS, DELAY ping-pong) actually needs it.

export default {
  type: 'out',
  name: 'OUT',
  group: 'io',
  hp: 10,
  tier: 'native',
  util: true,
  poly: false,     // sums every poly channel that lands on it
  terminal: true,
  ports: [
    { id: 'in', dir: 'in', kind: 'audio', label: 'IN' }
  ],
  params: [
    { key: 'level', label: 'LEVEL', min: 0, max: 1, step: 0.01, def: 0.7, fmt: '' },
    { key: 'mute',  label: 'MUTE',  def: false, toggle: true }
  ],

  create(ctx, { params }) {
    const input = ctx.createGain()
    input.gain.value = 1
    const out = ctx.createGain()
    out.gain.value = params.mute ? 0 : params.level
    input.connect(out)

    return {
      inputs: { in: [input] },
      outputs: {},
      output: out,

      setParam(key, value, atTime = ctx.currentTime) {
        params[key] = value
        if (key === 'level' || key === 'mute') {
          out.gain.setTargetAtTime(params.mute ? 0 : params.level, atTime, 0.01)
        }
      },

      dispose() {
        input.disconnect()
        out.disconnect()
      }
    }
  }
}
