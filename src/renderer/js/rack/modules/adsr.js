// ADSR — envelope generator.
//
// Pure event domain: gate-on/gate-off/trig events (scheduler-timed, not read
// off the signal graph) schedule ramps on a ConstantSourceNode.offset per
// poly channel. Sample-accurate on every host with no worklet — this is why
// ADSR sits on the basic-voice path.
//
// GATE/RETRIG inputs still need connectable nodes so a signal-domain cable
// can physically land on them, but native tier ignores the signal — events
// drive the envelope.

export default {
  type: 'adsr',
  name: 'ADSR',
  group: 'env',
  hp: 8,
  tier: 'native',
  poly: true,
  ports: [
    { id: 'gate',   dir: 'in',  kind: 'gate', label: 'GATE' },
    { id: 'retrig', dir: 'in',  kind: 'gate', label: 'RETRIG' },
    { id: 'env',    dir: 'out', kind: 'cv',   label: 'ENV' },
    { id: 'inv',    dir: 'out', kind: 'cv',   label: 'INV' }
  ],
  params: [
    { key: 'attack',  label: 'ATTACK',  min: 0.001, max: 8,  step: 0.001, def: 0.01, fmt: 's' },
    { key: 'decay',   label: 'DECAY',   min: 0.001, max: 8,  step: 0.001, def: 0.2,  fmt: 's' },
    { key: 'sustain', label: 'SUSTAIN', min: 0,     max: 1,  step: 0.01,  def: 0.7,  fmt: '' },
    { key: 'release', label: 'RELEASE', min: 0.001, max: 12, step: 0.001, def: 0.4,  fmt: 's' },
    { key: 'curve',   label: 'CURVE',   options: ['lin', 'exp'], def: 'exp' }
  ],

  create(ctx, { channels = 1, params }) {
    const voices = []
    for (let i = 0; i < channels; i++) {
      const gateIn = ctx.createGain()     // pass-through landing pad, signal ignored in native tier
      const retrigIn = ctx.createGain()

      const env = ctx.createConstantSource()
      env.offset.value = 0
      env.start()

      const envOut = ctx.createGain()
      envOut.gain.value = 1
      const invOut = ctx.createGain()
      invOut.gain.value = -1

      env.connect(envOut)
      env.connect(invOut)

      voices.push({ gateIn, retrigIn, env, envOut, invOut })
    }

    function attackStage(v, t) {
      const p = v.env.offset
      p.cancelScheduledValues(t)
      p.setValueAtTime(p.value, t) // hold whatever value was ramping, avoid a click
      p.linearRampToValueAtTime(1, t + params.attack)
      if (params.curve === 'exp') {
        p.setTargetAtTime(params.sustain, t + params.attack, params.decay / 3)
      } else {
        p.linearRampToValueAtTime(params.sustain, t + params.attack + params.decay)
      }
    }

    function releaseStage(v, t) {
      const p = v.env.offset
      p.cancelScheduledValues(t)
      p.setValueAtTime(params.sustain, t) // approximation: assumes gate-off lands post-decay
      if (params.curve === 'exp') {
        p.setTargetAtTime(0, t, params.release / 3)
      } else {
        p.linearRampToValueAtTime(0, t + params.release)
      }
    }

    return {
      inputs: {
        gate:   voices.map(v => v.gateIn),
        retrig: voices.map(v => v.retrigIn)
      },
      outputs: {
        env: voices.map(v => v.envOut),
        inv: voices.map(v => v.invOut)
      },

      setParam(key, value, atTime = ctx.currentTime) {
        params[key] = value
      },

      onEvent(portId, event) {
        const ch = Math.min(event.channel ?? 0, voices.length - 1)
        const v = voices[ch]
        if (!v) return
        if (portId === 'gate' && event.type === 'gate-on') attackStage(v, event.time)
        else if (portId === 'gate' && event.type === 'gate-off') releaseStage(v, event.time)
        // A trigger is a very short gate, and that is how hardware treats one on a
        // gate input. Without this an ALGO/SEQ8 lane in trig mode lands on GATE and
        // does nothing at all, while the same trigger drives an AD envelope fine.
        else if (portId === 'gate' && event.type === 'trig') {
          attackStage(v, event.time)
          releaseStage(v, event.time + (event.pulseWidth ?? 0.01))
        }
        else if (portId === 'retrig' && event.type === 'trig') attackStage(v, event.time)
      },

      dispose() {
        for (const v of voices) {
          v.env.stop()
          v.gateIn.disconnect()
          v.retrigIn.disconnect()
          v.env.disconnect()
          v.envOut.disconnect()
          v.invOut.disconnect()
        }
        voices.length = 0
      }
    }
  }
}
