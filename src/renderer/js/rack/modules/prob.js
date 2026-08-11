// PROB — Bernoulli gate. One trigger in, out A or out B.
//
// `toggle` is the useful second mode: at p = .5 it is strict A-B-A-B, and p
// biases it toward repeating the last output instead (p = 1 locks onto one
// side). Below .5 it stays a clean alternation — there is nothing under strict
// alternation to bias toward.
export default {
  type: 'prob', name: 'PROB', group: 'seq', hp: 4, tier: 'native', poly: false,
  ports: [
    { id: 'trig', dir: 'in', kind: 'gate', label: 'TRIG' },
    { id: 'p', dir: 'in', kind: 'cv', label: 'P', atten: true },
    { id: 'a', dir: 'out', kind: 'gate', label: 'A' },
    { id: 'b', dir: 'out', kind: 'gate', label: 'B' }
  ],
  params: [
    { key: 'p', label: 'P', min: 0, max: 1, step: 0.01, def: 0.5, fmt: '' },
    { key: 'mode', label: 'MODE', options: ['coin', 'toggle'], def: 'coin' }
  ],

  create(ctx, { params, emitEvent = () => {}, poll = null, random = Math.random }) {
    const trig = ctx.createGain(), a = ctx.createGain(), b = ctx.createGain()
    const pIn = ctx.createAnalyser()
    pIn.fftSize = 32
    const frame = new Float32Array(32)
    let pCv = 0
    const remove = poll?.add(() => { pIn.getFloatTimeDomainData?.(frame); pCv = frame[0] || 0 })
    let lastA = false

    return {
      inputs: { trig: [trig], p: [pIn] },
      outputs: { a: [a], b: [b] },
      setParam(key, value) { params[key] = value },
      onEvent(port, event) {
        if (port !== 'trig' || (event.type !== 'trig' && event.type !== 'gate-on')) return
        const p = Math.max(0, Math.min(1, params.p + pCv))
        const roll = random()
        const toA = params.mode === 'toggle'
          ? (roll < (p - 0.5) * 2 ? lastA : !lastA)
          : roll < p
        lastA = toA
        emitEvent(toA ? 'a' : 'b', { type: 'trig', time: event.time ?? ctx.currentTime, channel: 0, velocity: event.velocity ?? 1 })
      },
      dispose() { remove?.(); trig.disconnect(); pIn.disconnect(); a.disconnect(); b.disconnect() }
    }
  }
}
