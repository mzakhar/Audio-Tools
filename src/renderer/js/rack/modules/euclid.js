import { euclid } from '../euclid.js'

// EUCLID — advances one Euclidean step for each scheduled clock event.
export default {
  type: 'euclid', name: 'EUCLID', group: 'seq', hp: 8, tier: 'native', poly: false,
  ports: [
    { id: 'clk', dir: 'in', kind: 'gate', label: 'CLK' },
    { id: 'rst', dir: 'in', kind: 'gate', label: 'RST' },
    { id: 'fill', dir: 'in', kind: 'cv', label: 'FILL', atten: true },
    { id: 'out', dir: 'out', kind: 'gate', label: 'OUT' },
    { id: 'inv', dir: 'out', kind: 'gate', label: 'INV' }
  ],
  params: [
    { key: 'steps', label: 'STEPS', min: 1, max: 32, step: 1, def: 16, fmt: '' },
    { key: 'fills', label: 'FILLS', min: 0, max: 32, step: 1, def: 4, fmt: '' },
    { key: 'rotate', label: 'ROTATE', min: 0, max: 31, step: 1, def: 0, fmt: '' },
    { key: 'probability', label: 'PROB', min: 0, max: 1, step: 0.01, def: 1, fmt: '' }
  ],

  create(ctx, { params, emitEvent = () => {} }) {
    const clk = ctx.createGain(), rst = ctx.createGain(), fill = ctx.createGain()
    const out = ctx.createGain(), inv = ctx.createGain()
    let step = 0
    const pattern = () => euclid(params.steps, params.fills, params.rotate)
    return {
      inputs: { clk: [clk], rst: [rst], fill: [fill] }, outputs: { out: [out], inv: [inv] },
      setParam(key, value) { params[key] = value; if (key === 'steps') step %= Math.max(1, value) },
      onEvent(portId, event) {
        if (portId === 'rst') { step = 0; return }
        if (portId !== 'clk' || (event.type !== 'trig' && event.type !== 'gate-on')) return
        const hit = pattern()[step++ % Math.max(1, params.steps)] && Math.random() < params.probability
        emitEvent(hit ? 'out' : 'inv', { type: 'trig', time: event.time, channel: 0 })
      },
      dispose() { clk.disconnect(); rst.disconnect(); fill.disconnect(); out.disconnect(); inv.disconnect() }
    }
  }
}
