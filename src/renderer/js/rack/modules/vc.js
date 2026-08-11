// VC — quad attenuverter/offset/mixer (Intellijel Quadratt-style).
//
// Two normals do all the work, and between them they replace every extra jack
// this module used to have:
//
//   1. Each input is normalled to a ConstantSourceNode(1) — the +5V reference on
//      the hardware. Unpatched, out = knob, so a strip is a DC offset and the
//      knob is a performance macro. Patched, the normal lifts and out =
//      knob x input: an attenuator for a positive knob, an attenuverter for a
//      negative one.
//
//   2. Each output is normalled into the strip to its right, so A sums into B,
//      B into C, C into D. D is therefore the mix of everything above it and no
//      separate MIX jack is needed — which is why the hardware has none either.
//      Plugging into an output lifts that strip out of the sub-mix to its right,
//      giving sub-mixes in groups of 2, 3 or 4.
//
// Between them: bipolar envelopes, unipolar LFOs, a stereo pair, or a four-into-
// one mixer, from four knobs and eight jacks.

const STRIPS = ['a', 'b', 'c', 'd']

export default {
  type: 'vc',
  name: 'VC',
  group: 'util',
  // 24 -> 20 HP: dropping the MIX jack took a whole jack column with it. Four
  // 40px knob columns plus four 28px jack columns and the panel padding come to
  // 288px, so 20 HP (320px) carries them with slack; 18 wraps the D jacks.
  hp: 20,
  tier: 'native',
  poly: true,
  util: true,
  cascading: true,
  ports: [
    ...STRIPS.map(key => ({ id: key, dir: 'in', kind: 'cv', label: key.toUpperCase() })),
    ...STRIPS.map(key => ({ id: 'out' + key, dir: 'out', kind: 'cv', label: key.toUpperCase() }))
  ],
  params: STRIPS.map(key => ({ key: 'lvl' + key, label: key.toUpperCase(), min: -1, max: 1, step: 0.01, def: 0, fmt: '' })),

  create(ctx, { channels = 1, params }) {
    function makeStrip(key) {
      const input = ctx.createGain()
      input.gain.value = 1
      const lvl = ctx.createGain()
      lvl.gain.value = params['lvl' + key]
      // The strip's output: its own attenuated signal plus whatever cascades in
      // from the left. Separate from `lvl` so the cascade can be broken without
      // touching the strip's own path.
      const sum = ctx.createGain()
      sum.gain.value = 1
      const norm = ctx.createConstantSource()
      norm.offset.value = 1
      norm.start()
      input.connect(lvl)
      norm.connect(lvl)
      lvl.connect(sum)
      return { input, lvl, sum, norm, normalled: true, cascading: false }
    }

    const voices = []
    for (let i = 0; i < channels; i++) {
      const strip = Object.fromEntries(STRIPS.map(key => [key, makeStrip(key)]))
      // A -> B -> C -> D, each link liftable on its own.
      for (let s = 0; s < STRIPS.length - 1; s++) {
        const from = strip[STRIPS[s]], to = strip[STRIPS[s + 1]]
        from.sum.connect(to.sum)
        from.cascading = true
      }
      voices.push(strip)
    }

    const nextOf = key => STRIPS[STRIPS.indexOf(key) + 1]

    return {
      inputs: Object.fromEntries(STRIPS.map(key => [key, voices.map(v => v[key].input)])),
      outputs: Object.fromEntries(STRIPS.map(key => ['out' + key, voices.map(v => v[key].sum)])),

      setPortPatched(portId, patched) {
        // An input: patched lifts the +5V normal so the cable replaces it
        // rather than adding to it.
        if (STRIPS.includes(portId)) {
          const on = !patched
          for (const v of voices) {
            const s = v[portId]
            if (on === s.normalled) continue
            if (on) s.norm.connect(s.lvl); else s.norm.disconnect(s.lvl)
            s.normalled = on
          }
          return
        }
        // An output: patched lifts this strip out of the strip to its right,
        // which is what makes sub-mixes possible. D has nothing to its right.
        if (!portId.startsWith('out')) return
        const key = portId.slice(3)
        const next = nextOf(key)
        if (!next) return
        const on = !patched
        for (const v of voices) {
          const from = v[key], to = v[next]
          if (on === from.cascading) continue
          if (on) from.sum.connect(to.sum); else from.sum.disconnect(to.sum)
          from.cascading = on
        }
      },

      setParam(key, value, atTime = ctx.currentTime) {
        params[key] = value
        const strip = STRIPS.find(k => 'lvl' + k === key)
        if (!strip) return
        for (const v of voices) v[strip].lvl.gain.setTargetAtTime(value, atTime, 0.01)
      },

      dispose() {
        for (const v of voices) {
          for (const key of STRIPS) {
            const s = v[key]
            s.norm.stop()
            s.input.disconnect()
            s.lvl.disconnect()
            s.sum.disconnect()
            s.norm.disconnect()
          }
        }
        voices.length = 0
      }
    }
  }
}
