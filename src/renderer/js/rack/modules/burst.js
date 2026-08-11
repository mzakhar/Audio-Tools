import { burstTimes } from '../burst.js'

// BURST — one trigger in, n out. All the timing is pure (rack/burst.js); this
// only turns the resulting times into scheduled events.
export default {
  type: 'burst', name: 'BURST', group: 'seq', hp: 4, tier: 'native', poly: false,
  ports: [
    { id: 'trig', dir: 'in', kind: 'gate', label: 'TRIG' },
    { id: 'cnt', dir: 'in', kind: 'cv', label: 'CNT', atten: true },
    { id: 'out', dir: 'out', kind: 'gate', label: 'OUT' },
    { id: 'eob', dir: 'out', kind: 'gate', label: 'EOB' }
  ],
  params: [
    { key: 'count', label: 'COUNT', min: 1, max: 16, step: 1, def: 4, fmt: '' },
    { key: 'spacing', label: 'SPACING', min: 10, max: 500, step: 1, def: 60, fmt: 'ms' },
    { key: 'curve', label: 'CURVE', min: -1, max: 1, step: 0.01, def: 0, fmt: '' },
    { key: 'prob', label: 'PROB', min: 0, max: 1, step: 0.01, def: 1, fmt: '' }
  ],

  create(ctx, { params, emitEvent = () => {}, poll = null, random = Math.random }) {
    const trig = ctx.createGain(), out = ctx.createGain(), eob = ctx.createGain()
    // CNT rides the shared poll: a count is an integer decision made once per
    // burst, so audio-rate would buy nothing.
    const cnt = ctx.createAnalyser()
    cnt.fftSize = 32
    const frame = new Float32Array(32)
    let cntCv = 0
    const remove = poll?.add(() => { cnt.getFloatTimeDomainData?.(frame); cntCv = frame[0] || 0 })

    return {
      inputs: { trig: [trig], cnt: [cnt] },
      outputs: { out: [out], eob: [eob] },
      setParam(key, value) { params[key] = value },
      onEvent(port, event) {
        if (port !== 'trig' || (event.type !== 'trig' && event.type !== 'gate-on')) return
        const time = event.time ?? ctx.currentTime
        // 1 V per repeat on the CV jack, same scaling as every other integer CV.
        const count = Math.max(1, Math.min(16, Math.round(params.count + cntCv * 16)))
        const times = burstTimes(time, count, params.spacing / 1000, params.curve)
        times.forEach((at, i) => {
          // The first hit always fires: PROB thins the ratchet, it does not
          // swallow the trigger that caused it.
          if (i > 0 && random() >= params.prob) return
          emitEvent('out', { type: 'trig', time: at, channel: 0, velocity: event.velocity ?? 1 })
        })
        emitEvent('eob', { type: 'trig', time: times[times.length - 1], channel: 0 })
      },
      dispose() { remove?.(); trig.disconnect(); cnt.disconnect(); out.disconnect(); eob.disconnect() }
    }
  }
}
