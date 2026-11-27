// kit-voices.js — shell: plays a kit's 909 voices. One instance per
// (kit, ctx, output); no globals, so the offline bounce builds its own.
// Shared by live-instrument.js and timeline-player.js.

import { createTr909Voice, metalBuffer } from '../drums/tr909-kit.js'
import { slotParams, velocityTimbre } from './kit.js'
import { velocityGain } from '../utils/velocity.js'

const CHOKE_TC = 0.005 // seconds, duck time constant
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

/** Performance layer: tuneSt (semitones; 12 = the tune knob's whole range; `tune` itself is never touched), decayMul, filterMul (tone), level (multiplier). */
function combine(a, b) {
  if (!a || !b) return a || b || null
  return {
    tuneSt: (a.tuneSt ?? 0) + (b.tuneSt ?? 0),
    decayMul: (a.decayMul ?? 1) * (b.decayMul ?? 1),
    filterMul: (a.filterMul ?? 1) * (b.filterMul ?? 1),
    level: (a.level ?? 1) * (b.level ?? 1)
  }
}

/** Fresh params with the layer applied; voices without a knob for a key ignore it. */
function perform(params, o) {
  if (!o) return params
  const out = { ...params }
  if (o.tuneSt && out.tune != null) out.tune = clamp(out.tune + o.tuneSt / 12, 0, 1)
  if (o.decayMul != null && out.decay != null) out.decay = clamp(out.decay * o.decayMul, 0.03, 1.8)
  if (o.filterMul != null && out.tone != null) out.tone = clamp(out.tone * o.filterMul, 0, 1)
  if (o.level != null && out.level != null) out.level = clamp(out.level * o.level, 0, 1)
  return out
}

/** perfFor(note) -> the slot's current perf layer; lets a live instrument follow knob moves without being rebuilt (default: the layer the kit carried at build time). */
/** One-shot region of a decoded buffer. Tune bends the rate, decayMul shortens the tail, level scales gain. */
function playSample(ctx, target, def, vel01, t, perf, buffer) {
  const start = clamp(def.start ?? 0, 0, buffer.duration)
  const end = clamp(def.end ?? buffer.duration, start, buffer.duration)
  const rate = 2 ** ((perf?.tuneSt ?? 0) / 12)
  const len = Math.max((end - start) / rate * Math.min(1, perf?.decayMul ?? 1), 0.005)
  const fade = Math.min(0.02, len / 2)
  const level = velocityGain(vel01 * 127) * (def.gain ?? 1) * (perf?.level ?? 1)
  const gain = ctx.createGain()
  gain.gain.setValueAtTime(level, t)
  gain.gain.setValueAtTime(level, t + len - fade)
  gain.gain.linearRampToValueAtTime(0, t + len)
  gain.connect(target)
  const src = ctx.createBufferSource()
  src.buffer = buffer
  src.playbackRate.value = rate
  src.connect(gain)
  src.start(t, start, len * rate)
  src.stop(t + len + 0.01)
}

const misses = new WeakMap()
/** Per-sample-store set of ids whose load failed: a missing sample is not re-read on every hit. */
export function missesOf(store) {
  if (!misses.has(store)) misses.set(store, new Set())
  return misses.get(store)
}

export function kitInstrument(kit, { ctx, output, perfFor, sampleStore }) {
  const open = new Map() // group → gain node carrying the sounding open voice

  const duck = (group, t) => {
    const gain = open.get(group)
    if (!gain) return
    open.delete(group)
    gain.gain.cancelScheduledValues(t)
    gain.gain.setTargetAtTime(0, t, CHOKE_TC)
  }

  /** vel01 0..1, time in ctx seconds. override: per-hit performance layer, combined with the slot's `perf`. */
  function hit(pitch, vel01, time = ctx.currentTime, override) {
    const def = kit.slots[pitch]
    if (!def || !(vel01 > 0)) return
    const t = Math.max(time, ctx.currentTime)
    const { params, accent } = velocityTimbre(vel01, perform(slotParams(def), combine(perfFor ? perfFor(pitch) : def.perf, override)))
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
    if (def.voice === 'sample') {
      const buffer = sampleStore?.peek(def.sampleId)
      if (buffer) playSample(ctx, target, def, vel01, t, combine(perfFor ? perfFor(pitch) : def.perf, override), buffer)
      else if (sampleStore && !missesOf(sampleStore).has(def.sampleId)) {
        sampleStore.get(def.sampleId).catch(() => missesOf(sampleStore).add(def.sampleId)) // silent this hit; the next one plays
      }
      return
    }
    createTr909Voice(ctx, target, def.voice, { [def.voice]: params }, { velocity: vel01, accent }, t)
  }

  return {
    hit,
    noteOn: (pitch, velocity, time, override) => hit(pitch, velocity / 127, time, override),
    noteOff() {},
    send() {},
    // Build the ROM buffers now so the first hat/crash is not a synth stall.
    // Resolves once this kit's user samples are decoded; a missing one must not fail the rest.
    prewarm() {
      for (const kind of ['hat', 'crash', 'ride']) metalBuffer(ctx, kind)
      const ids = Object.values(kit.slots).filter(d => d.voice === 'sample').map(d => d.sampleId)
      if (!sampleStore || !ids.length) return Promise.resolve()
      const miss = missesOf(sampleStore)
      return Promise.allSettled([...new Set(ids)].map(id => {
        miss.delete(id) // prewarm retries
        return sampleStore.get(id).catch(error => { miss.add(id); throw error })
      })).then(() => {})
    },
    dispose() { for (const group of [...open.keys()]) duck(group, ctx.currentTime) }
  }
}
