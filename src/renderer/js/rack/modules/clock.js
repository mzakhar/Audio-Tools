// CLOCK — event-domain clock. Audio nodes are only cable landing pads.

import { LookaheadScheduler } from '../scheduler.js'

const defaults = { bpm: 120, source: 'internal', swing: 0, pulseWidth: 0.5 }

export default {
  type: 'clock',
  name: 'CLOCK',
  group: 'seq',
  hp: 6,
  tier: 'native',
  poly: false,
  ports: [
    { id: 'run', dir: 'in', kind: 'gate', label: 'RUN' },
    { id: 'ext', dir: 'in', kind: 'gate', label: 'EXT' },
    { id: 'out', dir: 'out', kind: 'gate', label: 'OUT' },
    { id: 'div2', dir: 'out', kind: 'gate', label: '÷2' },
    { id: 'div4', dir: 'out', kind: 'gate', label: '÷4' },
    { id: 'reset', dir: 'out', kind: 'gate', label: 'RESET' }
  ],
  params: [
    // One tick per beat, so a 16th-note pattern runs at a quarter of this —
    // 480 is what a sequencer needs to reach fast step rates, not a tempo.
    { key: 'bpm', label: 'BPM', min: 20, max: 480, step: 1, def: 120, fmt: 'BPM' },
    { key: 'source', label: 'SOURCE', options: ['internal', 'transport'], def: 'internal' },
    { key: 'swing', label: 'SWING', min: 0, max: 0.75, step: 0.01, def: 0, fmt: '' },
    { key: 'pulseWidth', label: 'WIDTH', min: 0.05, max: 0.9, step: 0.01, def: 0.5, fmt: '' }
  ],

  create(ctx, { params = {}, emitEvent = () => {} } = {}) {
    params = { ...defaults, ...params }
    const run = ctx.createGain()
    const ext = ctx.createGain()
    const out = ctx.createGain()
    const div2 = ctx.createGain()
    const div4 = ctx.createGain()
    const reset = ctx.createGain()
    let running = true
    let count = 0

    const fire = (port, time, width) => {
      emitEvent(port, { type: 'gate-on', time })
      emitEvent(port, { type: 'gate-off', time: time + width })
    }
    const tick = (time = ctx.currentTime) => {
      if (!running) return
      const step = 60 / params.bpm
      const at = time + (count % 2 ? params.swing * step / 2 : 0)
      const width = step * params.pulseWidth
      fire('out', at, width)
      if (count % 2 === 0) fire('div2', at, width)
      if (count % 4 === 0) fire('div4', at, width)
      count += 1
    }
    const scheduler = new LookaheadScheduler({
      getCurrentTime: () => ctx.currentTime,
      schedule: (_, time) => tick(time),
      advance: () => 60 / params.bpm
    })
    const startScheduler = () => {
      scheduler.stop()
      if (params.source !== 'internal') return
      scheduler.start({ time: ctx.currentTime })
    }
    startScheduler()

    return {
      inputs: { run: [run], ext: [ext] },
      outputs: { out: [out], div2: [div2], div4: [div4], reset: [reset] },
      setParam(key, value) {
        params[key] = value
        if (key === 'source' || key === 'bpm') startScheduler()
      },
      onEvent(portId, event) {
        const time = event.time ?? ctx.currentTime
        if (portId === 'run' && (event.type === 'gate-on' || event.type === 'trig')) {
          running = true; count = 0; emitEvent('reset', { type: 'trig', time }); startScheduler()
        } else if (portId === 'run' && event.type === 'gate-off') {
          running = false; scheduler.stop()
        } else if (portId === 'ext' && params.source === 'transport' && event.type === 'ppqn' && event.tick % 24 === 0) {
          tick(time)
        }
      },
      dispose() {
        scheduler.stop()
        for (const node of [run, ext, out, div2, div4, reset]) node.disconnect()
      }
    }
  }
}
