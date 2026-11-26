// kit-voices.js — shell: plays a kit's 909 voices. One instance per
// (kit, ctx, output); no globals, so the offline bounce builds its own.
// Shared by live-instrument.js and timeline-player.js.

import { createTr909Voice, metalBuffer } from '../drums/tr909-kit.js'
import { slotParams, velocityTimbre } from './kit.js'

const CHOKE_TC = 0.005 // seconds, duck time constant

export function kitInstrument(kit, { ctx, output }) {
  const open = new Map() // group → gain node carrying the sounding open voice

  const duck = (group, t) => {
    const gain = open.get(group)
    if (!gain) return
    open.delete(group)
    gain.gain.cancelScheduledValues(t)
    gain.gain.setTargetAtTime(0, t, CHOKE_TC)
  }

  /** vel01 0..1, time in ctx seconds. */
  function hit(pitch, vel01, time = ctx.currentTime) {
    const def = kit.slots[pitch]
    if (!def || !(vel01 > 0)) return
    const t = Math.max(time, ctx.currentTime)
    const { params, accent } = velocityTimbre(vel01, slotParams(def))
    let target = output
    if (def.group) {
      if (def.open) {
        // ponytail: a replaced open-hat gain stays connected but silent; GC takes it.
        duck(def.group, t)
        target = ctx.createGain()
        target.connect(output)
        open.set(def.group, target)
      } else duck(def.group, t)
    }
    createTr909Voice(ctx, target, def.voice, { [def.voice]: params }, { velocity: vel01, accent }, t)
  }

  return {
    hit,
    noteOn: (pitch, velocity, time) => hit(pitch, velocity / 127, time),
    noteOff() {},
    send() {},
    // Build the ROM buffers now so the first hat/crash is not a synth stall.
    prewarm() { for (const kind of ['hat', 'crash', 'ride']) metalBuffer(ctx, kind) },
    dispose() { for (const group of [...open.keys()]) duck(group, ctx.currentTime) }
  }
}
