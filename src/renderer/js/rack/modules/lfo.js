// LFO — low frequency oscillator.
//
// OscillatorNode at sub-audio rate into a depth GainNode for BI (bipolar
// +-1); UNI is BI * 0.5 plus a ConstantSourceNode(0.5) offset so it sits in
// 0..1. RATE CV runs through a fixed GainNode(20) into osc.frequency: 20 Hz
// per CV unit, linear — this is an LFO knob, not 1V/oct pitch tracking.
//
// ponytail: mono. Poly LFOs are rarely wanted and cost N oscillators; use
// MERGE if per-voice modulation is really needed.

const RESTART_WAVES = { sine: 'sine', square: 'square' }

export default {
  type: 'lfo',
  name: 'LFO',
  group: 'mod',
  hp: 6,
  tier: 'native',
  poly: false,
  ports: [
    { id: 'rate',  dir: 'in',  kind: 'cv', label: 'RATE', atten: true },
    { id: 'reset', dir: 'in',  kind: 'gate', label: 'RESET' },
    { id: 'bi',    dir: 'out', kind: 'cv', label: 'BI' },
    { id: 'uni',   dir: 'out', kind: 'cv', label: 'UNI' }
  ],
  params: [
    { key: 'rate',  label: 'RATE',  min: 0.01, max: 40, step: 0.01, def: 2, fmt: 'Hz' },
    { key: 'wave',  label: 'WAVE',  options: ['sine', 'tri', 'saw', 'ramp', 'square'], def: 'sine' },
    { key: 'depth', label: 'DEPTH', min: 0, max: 1, step: 0.01, def: 1, fmt: '' }
  ],

  create(ctx, { params }) {
    const rateCv = ctx.createGain()
    rateCv.gain.value = 20             // 1 CV unit = 20 Hz

    const resetIn = ctx.createGain()   // signal-domain landing pad only, ignored in native tier

    const depth = ctx.createGain()
    depth.gain.value = params.depth

    const uniScale = ctx.createGain()
    uniScale.gain.value = 0.5
    const uniOffset = ctx.createConstantSource()
    uniOffset.offset.value = 0.5
    const uniOut = ctx.createGain()
    uniOut.gain.value = 1

    depth.connect(uniScale)
    uniScale.connect(uniOut)
    uniOffset.connect(uniOut)
    uniOffset.start()

    let osc = null
    let invert = null // -1 gain used for 'ramp' (inverted saw)
    const retired = []  // stopped at a future time, so they cannot be unwired yet

    function buildOsc(startTime) {
      if (osc) {
        // A RESET event arrives ~100 ms early: the old oscillator must keep
        // running and stay wired until its scheduled stop, so it is retired,
        // not disconnected here.
        osc.stop(startTime)
        retired.push({ osc, invert })
      }
      osc = null
      invert = null

      const o = ctx.createOscillator()
      o.frequency.value = params.rate
      rateCv.connect(o.frequency)

      if (params.wave === 'ramp') {
        o.type = 'sawtooth'
        invert = ctx.createGain()
        invert.gain.value = -1
        o.connect(invert)
        invert.connect(depth)
      } else if (params.wave === 'tri') {
        o.type = 'triangle'
        o.connect(depth)
      } else {
        o.type = RESTART_WAVES[params.wave] || (params.wave === 'saw' ? 'sawtooth' : 'sine')
        o.connect(depth)
      }

      o.start(startTime)
      osc = o
    }

    buildOsc(ctx.currentTime)

    return {
      inputs: {
        rate:  [rateCv],
        reset: [resetIn]
      },
      outputs: {
        bi:  [depth],
        uni: [uniOut]
      },

      setParam(key, value, atTime = ctx.currentTime) {
        params[key] = value
        if (key === 'rate') {
          osc.frequency.setTargetAtTime(value, atTime, 0.01)
        } else if (key === 'depth') {
          depth.gain.setTargetAtTime(value, atTime, 0.01)
        } else if (key === 'wave') {
          buildOsc(atTime)
        }
      },

      onEvent(portId, event) {
        if (portId === 'reset') buildOsc(event.time)
      },

      dispose() {
        for (const r of retired) {
          r.osc.disconnect()
          if (r.invert) r.invert.disconnect()
        }
        retired.length = 0
        if (osc) { osc.stop(); osc.disconnect() }
        if (invert) invert.disconnect()
        rateCv.disconnect()
        resetIn.disconnect()
        depth.disconnect()
        uniScale.disconnect()
        uniOffset.stop()
        uniOffset.disconnect()
        uniOut.disconnect()
      }
    }
  }
}
