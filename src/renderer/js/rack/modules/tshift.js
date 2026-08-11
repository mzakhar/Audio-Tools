// TSHIFT — trigger delay, swing and humanize.
//
// Events already carry a future timestamp, so all three are one addition on
// `event.time`. No timer, no node, sample-accurate for free.
export default {
  type: 'tshift', name: 'TSHIFT', group: 'util', hp: 4, tier: 'native', poly: false,
  ports: [
    { id: 'in', dir: 'in', kind: 'gate', label: 'IN' },
    { id: 'dly', dir: 'in', kind: 'cv', label: 'DLY', atten: true },
    { id: 'out', dir: 'out', kind: 'gate', label: 'OUT' }
  ],
  params: [
    { key: 'delay', label: 'DELAY', min: 0, max: 500, step: 1, def: 0, fmt: 'ms' },
    { key: 'swing', label: 'SWING', min: 0, max: 75, step: 1, def: 0, fmt: '%' },
    { key: 'humanize', label: 'HUMAN', min: 0, max: 30, step: 1, def: 0, fmt: 'ms' }
  ],

  create(ctx, { params, emitEvent = () => {}, poll = null, random = Math.random }) {
    const input = ctx.createGain(), out = ctx.createGain()
    const dly = ctx.createAnalyser()
    dly.fftSize = 32
    const frame = new Float32Array(32)
    let dlyCv = 0
    const remove = poll?.add(() => { dly.getFloatTimeDomainData?.(frame); dlyCv = frame[0] || 0 })

    let index = -1, last = -1, held = 0

    return {
      inputs: { in: [input], dly: [dly] },
      outputs: { out: [out] },
      setParam(key, value) { params[key] = value },
      onEvent(port, event) {
        if (port !== 'in') return
        const time = event.time ?? ctx.currentTime
        if (event.type === 'gate-off') {
          // Reuse the offset the matching gate-on got, or the pair drifts apart
          // and a gate can end before it starts.
          emitEvent('out', { ...event, time: time + held })
          return
        }
        // ponytail: swing is a fraction of the previous inter-trigger interval,
        // so the first trigger after a tempo change swings by the old amount.
        const interval = last >= 0 ? Math.max(0, time - last) : 0
        last = time
        index++
        // 1 V = 500 ms on the DLY jack, matching the knob's full range.
        const delay = Math.max(0, params.delay / 1000 + dlyCv * 0.5)
        const swing = index % 2 ? (params.swing / 100) * interval * 0.5 : 0
        held = delay + swing + random() * (params.humanize / 1000)
        emitEvent('out', { ...event, time: time + held })
      },
      dispose() { remove?.(); input.disconnect(); dly.disconnect(); out.disconnect() }
    }
  }
}
