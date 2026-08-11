// CLKMUL — the missing half of `clkdiv`. A divider only ever has to count, but
// a multiplier has to know how long the next beat is before it happens, so it
// predicts the interval from the last two clock events and fills it in.
export default {
  type: 'clkmul', name: 'CLKMUL', group: 'seq', hp: 4, tier: 'native', poly: false,
  ports: [
    { id: 'clk', dir: 'in', kind: 'gate', label: 'CLK' },
    { id: 'rst', dir: 'in', kind: 'gate', label: 'RST' },
    { id: 'out', dir: 'out', kind: 'gate', label: 'OUT' }
  ],
  params: [
    { key: 'mult', label: 'MULT', options: [2, 3, 4, 6, 8], def: 2 }
  ],

  create(ctx, { params, emitEvent = () => {} }) {
    const clk = ctx.createGain(), rst = ctx.createGain(), out = ctx.createGain()
    let last = -1

    return {
      inputs: { clk: [clk], rst: [rst] },
      outputs: { out: [out] },
      setParam(key, value) { params[key] = value },
      onEvent(port, event) {
        if (port === 'rst' && event.type !== 'gate-off') { last = -1; return }
        if (port !== 'clk' || (event.type !== 'trig' && event.type !== 'gate-on')) return
        const time = event.time ?? ctx.currentTime
        // ponytail: interval prediction — the subdivisions after this tick are
        // spaced by the *previous* interval, so the first multiplied tick after
        // a tempo change lands on the stale one. Upgrade path is transport-aware
        // timing via rack-clock.js if it ever matters.
        const interval = last >= 0 ? Math.max(0, time - last) : 0
        last = time
        const mult = Math.max(1, Math.round(Number(params.mult) || 1))
        emitEvent('out', { type: 'trig', time, channel: 0 })
        if (!interval) return
        for (let i = 1; i < mult; i++) emitEvent('out', { type: 'trig', time: time + (interval * i) / mult, channel: 0 })
      },
      dispose() { clk.disconnect(); rst.disconnect(); out.disconnect() }
    }
  }
}
