// SEQ8 — eight stored event-domain steps; CV is held by a ConstantSourceNode.

const defaultSteps = () => Array.from({ length: 8 }, () => ({ value: 0, gate: true, slide: false, accent: false }))

export default {
  type: 'seq8',
  name: 'SEQ8',
  group: 'seq',
  hp: 16,
  tier: 'native',
  poly: false,
  ports: [
    { id: 'clk', dir: 'in', kind: 'gate', label: 'CLK' },
    { id: 'rst', dir: 'in', kind: 'gate', label: 'RST' },
    { id: 'dir', dir: 'in', kind: 'cv', label: 'DIR' },
    { id: 'cv', dir: 'out', kind: 'cv', label: 'CV' },
    { id: 'gate', dir: 'out', kind: 'gate', label: 'GATE' },
    { id: 'eoc', dir: 'out', kind: 'gate', label: 'EOC' }
  ],
  params: [
    { key: 'steps', label: 'STEPS', def: defaultSteps() },
    { key: 'length', label: 'LENGTH', min: 1, max: 8, step: 1, def: 8, fmt: '' },
    { key: 'direction', label: 'DIRECTION', options: ['fwd', 'rev', 'pend', 'rand'], def: 'fwd' },
    { key: 'quantize', label: 'QUANTIZE', options: ['off', 'scale'], def: 'off' }
  ],

  create(ctx, { params = {}, emitEvent = () => {} } = {}) {
    params = { steps: defaultSteps(), length: 8, direction: 'fwd', quantize: 'off', ...params }
    const clk = ctx.createGain()
    const rst = ctx.createGain()
    const dir = ctx.createGain()
    const cv = ctx.createConstantSource()
    cv.offset.value = params.steps[0]?.value ?? 0
    cv.start()
    const cvOut = ctx.createGain()
    const gate = ctx.createGain()
    const eoc = ctx.createGain()
    cv.connect(cvOut)
    let index = -1
    let pendulum = 1

    const advance = () => {
      const length = Math.max(1, Math.min(8, params.length | 0))
      if (params.direction === 'rand') return Math.floor(Math.random() * length)
      if (params.direction === 'rev') return (index - 1 + length) % length
      if (params.direction === 'pend') {
        if (index + pendulum >= length || index + pendulum < 0) pendulum *= -1
        return index < 0 ? 0 : index + pendulum
      }
      return (index + 1) % length
    }
    return {
      inputs: { clk: [clk], rst: [rst], dir: [dir] },
      outputs: { cv: [cvOut], gate: [gate], eoc: [eoc] },
      setParam(key, value) { params[key] = value },
      onEvent(portId, event) {
        if (portId === 'rst' && event.type !== 'gate-off') { index = -1; pendulum = 1; return }
        if (portId !== 'clk' || event.type === 'gate-off') return
        const time = event.time ?? ctx.currentTime
        index = advance()
        const step = params.steps[index] || defaultSteps()[0]
        const width = event.pulseWidth ?? 0.05
        if (step.slide) cv.offset.linearRampToValueAtTime(step.value, time + width)
        else cv.offset.setValueAtTime(step.value, time)
        if (step.gate !== false) {
          emitEvent('gate', { type: 'gate-on', time, accent: !!step.accent })
          emitEvent('gate', { type: 'gate-off', time: time + width, accent: !!step.accent })
        }
        if (index === Math.max(1, Math.min(8, params.length | 0)) - 1) emitEvent('eoc', { type: 'trig', time })
      },
      dispose() {
        cv.stop()
        for (const node of [clk, rst, dir, cv, cvOut, gate, eoc]) node.disconnect()
      }
    }
  }
}
