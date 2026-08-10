// NOISE — white/pink noise source.
//
// One AudioBufferSourceNode looping a 2 s white-noise buffer. Pink is the
// same source through cascaded BiquadFilterNode lowshelfs approximating
// -3 dB/octave — not a real pink filter, just close enough to be usable.
//
// ponytail: mono by design. Poly noise is wasted CPU; poly destinations get
// this same mono source fanned out to every channel by the engine.

export default {
  type: 'noise',
  name: 'NOISE',
  group: 'source',
  hp: 4,
  tier: 'native',
  poly: false,
  ports: [
    { id: 'wht', dir: 'out', kind: 'audio', label: 'WHT' },
    { id: 'pnk', dir: 'out', kind: 'audio', label: 'PNK' }
  ],
  params: [
    { key: 'level', label: 'LEVEL', min: 0, max: 1, step: 0.01, def: 0.8, fmt: '' }
  ],

  create(ctx, { params }) {
    const buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate)
    const data = buf.getChannelData(0)
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1

    const src = ctx.createBufferSource()
    src.buffer = buf
    src.loop = true

    // pink approximation: two cascaded lowshelf-ish biquads, not a real 1/f filter
    const pink1 = ctx.createBiquadFilter()
    pink1.type = 'lowpass'
    pink1.frequency.value = 4000
    pink1.Q.value = 0.5
    const pink2 = ctx.createBiquadFilter()
    pink2.type = 'lowshelf'
    pink2.frequency.value = 500
    pink2.gain.value = 6

    const whtOut = ctx.createGain()
    whtOut.gain.value = params.level
    const pnkOut = ctx.createGain()
    pnkOut.gain.value = params.level

    src.connect(whtOut)
    src.connect(pink1)
    pink1.connect(pink2)
    pink2.connect(pnkOut)

    src.start()

    return {
      inputs: {},
      outputs: {
        wht: [whtOut],
        pnk: [pnkOut]
      },

      setParam(key, value, atTime = ctx.currentTime) {
        params[key] = value
        if (key === 'level') {
          whtOut.gain.setTargetAtTime(value, atTime, 0.01)
          pnkOut.gain.setTargetAtTime(value, atTime, 0.01)
        }
      },

      dispose() {
        src.stop()
        src.disconnect()
        pink1.disconnect()
        pink2.disconnect()
        whtOut.disconnect()
        pnkOut.disconnect()
      }
    }
  }
}
