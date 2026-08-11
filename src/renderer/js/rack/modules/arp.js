// ARP — arpeggiator over a held-note stack.
//
// The NOTE jack takes the same events MIDI IN and KEYS already produce: their
// note-on/note-off carry `note` and their GATE output carries `pitch`, both raw
// MIDI numbers. ARP converts once, here, and works in pitch CV from then on.

import { arpOrder, ARP_MODES } from '../arp.js'
import { midiToPitchCv } from '../../utils/cv.js'

const DEFAULT_INTERVAL = 0.125   // until two clocks have been seen

export default {
  type: 'arp',
  name: 'ARP',
  group: 'seq',
  hp: 8,
  tier: 'native',
  poly: false,
  ports: [
    { id: 'clk', dir: 'in', kind: 'gate', label: 'CLK' },
    { id: 'note', dir: 'in', kind: 'gate', label: 'NOTE' },
    { id: 'rst', dir: 'in', kind: 'gate', label: 'RST' },
    { id: 'cv', dir: 'out', kind: 'cv', label: 'CV' },
    { id: 'gate', dir: 'out', kind: 'gate', label: 'GATE' }
  ],
  params: [
    { key: 'mode', label: 'MODE', options: ARP_MODES, def: 'up' },
    { key: 'octaves', label: 'OCT', min: 1, max: 4, step: 1, def: 1, fmt: '' },
    { key: 'gateLen', label: 'GATE', min: 0.05, max: 0.95, step: 0.01, def: 0.5, fmt: '' },
    { key: 'hold', label: 'HOLD', options: ['off', 'on'], def: 'off' }
  ],

  create(ctx, { params = {}, emitEvent = () => {}, random = Math.random } = {}) {
    params = { mode: 'up', octaves: 1, gateLen: 0.5, hold: 'off', ...params }
    const clk = ctx.createGain()
    const noteIn = ctx.createGain()
    const rst = ctx.createGain()
    const cvSrc = ctx.createConstantSource()
    const cv = ctx.createGain()
    const gate = ctx.createGain()
    cvSrc.offset.value = 0
    cvSrc.connect(cv)
    cvSrc.start()

    let held = []          // pitch CVs, as played
    let index = 0
    let lastClock = null
    let interval = DEFAULT_INTERVAL

    const noteOf = event => {
      const midi = event.note ?? event.pitch
      return Number.isFinite(midi) ? midiToPitchCv(midi) : null
    }

    function note(event) {
      const value = noteOf(event)
      if (value === null) return
      const on = event.type === 'note-on' || event.type === 'gate-on' || event.type === 'trig'
      if (on) {
        if (!held.includes(value)) held.push(value)
      } else if (params.hold !== 'on') {
        // ponytail: HOLD never releases, so the stack only clears on RST. A latch
        // that resets on the next fresh note-on is the upgrade if it annoys.
        held = held.filter(v => v !== value)
      }
    }

    function clock(event) {
      const order = arpOrder(held, params.mode, params.octaves)
      if (!order.length) return
      const time = event.time ?? ctx.currentTime
      if (lastClock !== null && time > lastClock) interval = Math.min(2, time - lastClock)
      lastClock = time
      const pick = params.mode === 'random' ? Math.floor(random() * order.length) : index % order.length
      index = (index + 1) % order.length
      const value = order[pick]
      cvSrc.offset.setValueAtTime(value, time)
      emitEvent('gate', { type: 'gate-on', time, channel: 0, cv: value })
      emitEvent('gate', { type: 'gate-off', time: time + interval * params.gateLen, channel: 0 })
    }

    return {
      inputs: { clk: [clk], note: [noteIn], rst: [rst] },
      outputs: { cv: [cv], gate: [gate] },
      setParam(key, value) { params[key] = value },
      onEvent(portId, event) {
        if (portId === 'note') return note(event)
        if (portId === 'rst') { if (event.type !== 'gate-off') { index = 0; held = [] } return }
        if (portId === 'clk' && (event.type === 'trig' || event.type === 'gate-on')) clock(event)
      },
      dispose() {
        cvSrc.stop()
        for (const node of [clk, noteIn, rst, cvSrc, cv, gate]) node.disconnect()
      }
    }
  }
}
