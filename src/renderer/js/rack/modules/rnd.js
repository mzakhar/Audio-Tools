// RND — event-domain random sample-and-hold.
export default {
  type: 'rnd', name: 'RND', group: 'mod', hp: 4, tier: 'native', poly: false,
  ports: [
    { id: 'trig', dir: 'in', kind: 'gate', label: 'TRIG' },
    { id: 'cv', dir: 'out', kind: 'cv', label: 'CV' },
    { id: 'gate', dir: 'out', kind: 'gate', label: 'GATE' }
  ],
  params: [
    { key: 'range', label: 'RANGE', min: 0, max: 1, step: 0.01, def: 1, fmt: '' },
    { key: 'bipolar', label: 'BIPOLAR', options: ['off', 'on'], def: 'off' },
    { key: 'probability', label: 'PROB', min: 0, max: 1, step: 0.01, def: 1, fmt: '' }
  ],

  create(ctx, { params, emitEvent = () => {}, random = Math.random }) {
    const trig = ctx.createGain()
    const value = ctx.createConstantSource()
    const cv = ctx.createGain()
    const gate = ctx.createGain()
    value.offset.value = 0
    value.connect(cv)
    value.start()
    return {
      inputs: { trig: [trig] }, outputs: { cv: [cv], gate: [gate] },
      setParam(key, next) { params[key] = next },
      onEvent(portId, event) {
        if (portId !== 'trig' || (event.type !== 'trig' && event.type !== 'gate-on')) return
        const roll = random()
        const next = params.bipolar === 'on' ? (roll * 2 - 1) * params.range : roll * params.range
        value.offset.setValueAtTime(next, event.time)
        if (random() < params.probability) emitEvent('gate', { type: 'trig', time: event.time, channel: 0 })
      },
      dispose() { value.stop(); trig.disconnect(); value.disconnect(); cv.disconnect(); gate.disconnect() }
    }
  }
}
