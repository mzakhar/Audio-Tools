// VC — quad attenuverter/offset/mixer (Intellijel Quadratt-style).
//
// One knob per strip covers every use: unpatched, the strip's input is
// normalled to a ConstantSourceNode(1), so out = knob (a DC voltage — an
// offset). Patched, the normal drops and out = knob × input — an attenuator
// for a positive knob, an attenuverter for a negative one. No separate
// uni/bipolar switch is needed because the normal already IS the "no signal"
// case. All four strips also sum into MIX, a plain four-input CV/audio mixer.

export default {
  type: 'vc',
  name: 'VC',
  group: 'util',
  hp: 24,
  tier: 'native',
  poly: true,
  util: true,
  ports: [
    { id: 'a', dir: 'in', kind: 'cv', label: 'A' },
    { id: 'b', dir: 'in', kind: 'cv', label: 'B' },
    { id: 'c', dir: 'in', kind: 'cv', label: 'C' },
    { id: 'd', dir: 'in', kind: 'cv', label: 'D' },
    { id: 'outa', dir: 'out', kind: 'cv', label: 'A' },
    { id: 'outb', dir: 'out', kind: 'cv', label: 'B' },
    { id: 'outc', dir: 'out', kind: 'cv', label: 'C' },
    { id: 'outd', dir: 'out', kind: 'cv', label: 'D' },
    { id: 'mix', dir: 'out', kind: 'cv', label: 'MIX' }
  ],
  params: [
    { key: 'lvla', label: 'A', min: -1, max: 1, step: 0.01, def: 0, fmt: '' },
    { key: 'lvlb', label: 'B', min: -1, max: 1, step: 0.01, def: 0, fmt: '' },
    { key: 'lvlc', label: 'C', min: -1, max: 1, step: 0.01, def: 0, fmt: '' },
    { key: 'lvld', label: 'D', min: -1, max: 1, step: 0.01, def: 0, fmt: '' }
  ],

  create(ctx, { channels = 1, params }) {
    const strips = ['a', 'b', 'c', 'd']

    function makeStrip(key) {
      const lvl = ctx.createGain()
      lvl.gain.value = params['lvl' + key]
      const input = ctx.createGain()
      input.gain.value = 1
      input.connect(lvl)
      const norm = ctx.createConstantSource()
      norm.offset.value = 1
      norm.start()
      norm.connect(lvl)
      return { lvl, input, norm, normalled: true }
    }

    const voices = []
    for (let i = 0; i < channels; i++) {
      const mixBus = ctx.createGain()
      mixBus.gain.value = 1
      const strip = Object.fromEntries(strips.map(key => [key, makeStrip(key)]))
      for (const key of strips) strip[key].lvl.connect(mixBus)
      voices.push({ strip, mixBus })
    }

    return {
      inputs: Object.fromEntries(strips.map(key => [key, voices.map(v => v.strip[key].input)])),
      outputs: {
        ...Object.fromEntries(strips.map(key => ['out' + key, voices.map(v => v.strip[key].lvl)])),
        mix: voices.map(v => v.mixBus)
      },

      setInputPatched(portId, patched) {
        if (!strips.includes(portId)) return
        const on = !patched
        for (const v of voices) {
          const s = v.strip[portId]
          if (on === s.normalled) continue
          if (on) s.norm.connect(s.lvl)
          else s.norm.disconnect(s.lvl)
          s.normalled = on
        }
      },

      setParam(key, value, atTime = ctx.currentTime) {
        params[key] = value
        const strip = strips.find(k => 'lvl' + k === key)
        if (!strip) return
        for (const v of voices) v.strip[strip].lvl.gain.setTargetAtTime(value, atTime, 0.01)
      },

      dispose() {
        for (const v of voices) {
          for (const key of strips) {
            const s = v.strip[key]
            s.norm.stop()
            s.input.disconnect()
            s.lvl.disconnect()
            s.norm.disconnect()
          }
          v.mixBus.disconnect()
        }
        voices.length = 0
      }
    }
  }
}
