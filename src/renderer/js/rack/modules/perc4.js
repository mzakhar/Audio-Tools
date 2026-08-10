// PERC4 — quad percussive decay + VCA + mixer (Befaco Percall). Built poly,
// not four hardcoded lanes: in/trig/dcv/env are one jack each carrying 4
// channels through the ordinary poly contract.
//
// Decay is sampled off the DCV input at trigger time, not modulated
// continuously — decay is a scheduling value fed to setTargetAtTime, there is
// no AudioParam for "envelope time" to drive at audio rate. Percussive means
// no attack stage: fire() snaps straight to peak, mirroring ad.js otherwise.

export function chokeTargets(mode, channel, count) {
  if (mode === 'pairs') {
    return (channel % 2 === 1 && channel - 1 >= 0 && channel - 1 < count) ? [channel - 1] : []
  }
  if (mode === 'cascade') {
    const targets = []
    for (let c = 0; c < channel && c < count; c++) targets.push(c)
    return targets
  }
  return []
}

export default {
  type: 'perc4',
  name: 'PERC4',
  group: 'env',
  hp: 12,
  tier: 'native',
  poly: true,
  polySource: () => 4,
  ports: [
    { id: 'in', dir: 'in', kind: 'audio', label: 'IN' },
    { id: 'trig', dir: 'in', kind: 'gate', label: 'TRIG' },
    { id: 'dcv', dir: 'in', kind: 'cv', label: 'DCV', atten: true },
    { id: 'str', dir: 'in', kind: 'cv', label: 'STR', atten: true },
    { id: 'out', dir: 'out', kind: 'audio', label: 'MIX' },
    { id: 'env', dir: 'out', kind: 'cv', label: 'ENV' }
  ],
  params: [
    { key: 'decay', label: 'DECAY', min: 0.01, max: 4, step: 0.01, def: 0.25, fmt: 's' },
    { key: 'curve', label: 'CURVE', options: ['lin', 'exp'], def: 'exp' },
    { key: 'strength', label: 'STRENGTH', min: 0, max: 1, step: 0.01, def: 1, fmt: '' },
    { key: 'choke', label: 'CHOKE', options: ['off', 'pairs', 'cascade'], def: 'off' },
    { key: 'level', label: 'LEVEL', min: 0, max: 1, step: 0.01, def: 0.8, fmt: '' }
  ],

  create(ctx, { channels = 4, params, poll } = {}) {
    const chans = Array.from({ length: channels }, () => {
      const trigIn = ctx.createGain()

      const env = ctx.createConstantSource()
      env.offset.value = 0
      env.start()
      const envOut = ctx.createGain()
      env.connect(envOut)

      const strGain = ctx.createGain()
      strGain.gain.value = 0
      env.connect(strGain)

      const vca = ctx.createGain()
      vca.gain.value = 0
      strGain.connect(vca.gain)

      const dcvIn = ctx.createGain()
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 32
      dcvIn.connect(analyser)

      return { trigIn, env, envOut, strGain, vca, dcvIn, analyser }
    })

    const strIn = ctx.createGain()
    const strKnob = ctx.createConstantSource()
    strKnob.offset.value = params.strength
    strKnob.start()
    for (const c of chans) {
      strIn.connect(c.strGain.gain)
      strKnob.connect(c.strGain.gain)
    }

    const mix = ctx.createGain()
    mix.gain.value = params.level
    for (const c of chans) c.vca.connect(mix)

    function fire(channel, time) {
      const c = chans[channel]
      if (!c) return
      const buf = new Float32Array(c.analyser.fftSize)
      c.analyser.getFloatTimeDomainData(buf)
      const cv = buf[buf.length - 1] || 0
      const decay = Math.max(0.005, params.decay * Math.pow(2, cv * 2)) // ±2 octaves of decay time

      const p = c.env.offset
      p.cancelScheduledValues(time)
      p.setValueAtTime(p.value, time)
      p.setValueAtTime(1, time) // percussive: snap to peak, no attack stage
      if (params.curve === 'exp') p.setTargetAtTime(0, time, decay / 3)
      else p.linearRampToValueAtTime(0, time + decay)

      for (const t of chokeTargets(params.choke, channel, chans.length)) {
        const tp = chans[t].env.offset
        tp.cancelScheduledValues(time)
        tp.setValueAtTime(tp.value, time)
        tp.linearRampToValueAtTime(0, time + 0.005) // fast ramp, not an instant jump — clicks otherwise
      }
    }

    return {
      inputs: {
        in: chans.map(c => c.vca),
        trig: chans.map(c => c.trigIn),
        dcv: chans.map(c => c.dcvIn),
        str: [strIn]
      },
      outputs: {
        out: [mix],
        env: chans.map(c => c.envOut)
      },
      onEvent(portId, event) {
        if (portId !== 'trig' || (event.type !== 'trig' && event.type !== 'gate-on')) return
        fire(Math.min(event.channel ?? 0, chans.length - 1), event.time ?? ctx.currentTime)
      },
      setParam(key, value, atTime = ctx.currentTime) {
        params[key] = value
        if (key === 'level') mix.gain.setTargetAtTime(value, atTime, 0.01)
        else if (key === 'strength') strKnob.offset.setTargetAtTime(value, atTime, 0.01)
      },
      dispose() {
        strKnob.stop()
        strIn.disconnect()
        strKnob.disconnect()
        mix.disconnect()
        for (const c of chans) {
          c.env.stop()
          c.trigIn.disconnect()
          c.env.disconnect()
          c.envOut.disconnect()
          c.strGain.disconnect()
          c.vca.disconnect()
          c.dcvIn.disconnect()
          c.analyser.disconnect()
        }
      }
    }
  }
}
