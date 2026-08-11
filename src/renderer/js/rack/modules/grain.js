import { LookaheadScheduler } from '../scheduler.js'
import { FILE_PARAM, filePanel } from './sample-file.js'

// GRAIN — granular cloud over one buffer. Free-running: the grain clock is the
// existing lookahead scheduler, so grains are stamped ~100 ms ahead of the audio
// clock instead of being fired from a poll tick.

// ponytail: hard cap of 64 concurrent grains — at 100 Hz with 500 ms grains the
// honest number is 50, and past the cap new grains are dropped rather than
// stealing. Raise it, or move grain scheduling into a worklet, only if a real
// patch starves.
export const MAX_GRAINS = 64
const HANN_POINTS = 64
const HANN = Float32Array.from({ length: HANN_POINTS }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (HANN_POINTS - 1)))
const clamp = (v, lo, hi) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo)

export default {
  type: 'grain', name: 'GRAIN', group: 'source', hp: 12, tier: 'native', poly: false,
  ports: [
    { id: 'trig', dir: 'in', kind: 'gate', label: 'TRIG' },
    { id: 'pos', dir: 'in', kind: 'cv', label: 'POS', atten: true },
    { id: 'dens', dir: 'in', kind: 'cv', label: 'DENS', atten: true },
    { id: 'pitch', dir: 'in', kind: 'cv', label: 'PITCH' },
    { id: 'out', dir: 'out', kind: 'audio', label: 'OUT' }
  ],
  params: [
    FILE_PARAM,
    { key: 'position', label: 'POS', min: 0, max: 1, step: 0.001, def: 0, fmt: '' },
    { key: 'size', label: 'SIZE', min: 10, max: 500, step: 1, def: 80, fmt: 'ms' },
    { key: 'density', label: 'DENS', min: 1, max: 100, step: 1, def: 20, fmt: 'Hz' },
    { key: 'spray', label: 'SPRAY', min: 0, max: 1, step: 0.01, def: 0, fmt: '' },
    { key: 'pitch', label: 'PITCH', min: -24, max: 24, step: 1, def: 0, fmt: '' },
    { key: 'jitter', label: 'JITTER', min: 0, max: 1, step: 0.01, def: 0, fmt: '' },
    { key: 'spread', label: 'SPREAD', min: 0, max: 1, step: 0.01, def: 0.5, fmt: '' },
    { key: 'level', label: 'LEVEL', min: 0, max: 1, step: 0.01, def: 0.8, fmt: '' }
  ],

  create(ctx, { params, poll = null, getBuffer = () => null, random = Math.random }) {
    const trig = ctx.createGain(), out = ctx.createGain()
    out.gain.value = clamp(params.level, 0, 1)
    // POS/DENS/PITCH land on grains that do not exist yet, so they are analyser
    // taps on the shared 30 Hz poll, 1.0 CV = full knob range (the E1 rule).
    // ponytail: 30 Hz control rate on the cloud's own controls. Audio-rate
    // grain modulation is a worklet.
    const cvIn = { pos: ctx.createAnalyser(), dens: ctx.createAnalyser(), pitch: ctx.createAnalyser() }
    for (const node of Object.values(cvIn)) node.fftSize = 32
    const frame = new Float32Array(32)
    const cv = { pos: 0, dens: 0, pitch: 0 }
    const removePoll = poll?.add(() => {
      for (const key of ['pos', 'dens', 'pitch']) {
        cvIn[key].getFloatTimeDomainData?.(frame)
        cv[key] = frame[0] || 0
      }
    })

    const live = new Set()

    const spawn = (time) => {
      // Grains retire by their own end time rather than by an `onended` handler:
      // one sweep per spawn, no per-grain callback to leak. Retiring against the
      // time being scheduled, not `ctx.currentTime`, is what makes the cap mean
      // "grains overlapping this one" — and it is the only reading that works in
      // an OfflineAudioContext, where currentTime does not move during a render.
      for (const grain of live) if (grain.end <= time) live.delete(grain)
      const buffer = getBuffer(params.fileKey)
      if (!buffer || live.size >= MAX_GRAINS) return    // still decoding, or full
      const duration = buffer.duration || 0
      if (!(duration > 0)) return

      const size = clamp(params.size, 10, 500) / 1000
      const position = clamp(params.position + cv.pos, 0, 1)
      const spray = clamp(params.spray, 0, 1)
      const offset = clamp(position * duration + (random() * 2 - 1) * spray * duration, 0, duration)
      const rate = Math.pow(2, (params.pitch + cv.pitch * 120) / 12)

      const src = ctx.createBufferSource()
      src.buffer = buffer
      src.playbackRate.value = rate
      const win = ctx.createGain()
      win.gain.value = 0
      const pan = ctx.createStereoPanner()
      pan.pan.value = (random() * 2 - 1) * clamp(params.spread, 0, 1)
      src.connect(win)
      win.connect(pan)
      pan.connect(out)
      // The Hann window is the whole reason a grain is not a click.
      win.gain.setValueCurveAtTime?.(HANN, time, size)
      // start()'s third argument is buffer seconds, so a grain of `size` output
      // seconds eats size*rate of the file — clipped at the end of the buffer.
      src.start(time, offset, Math.min(size * rate, duration - offset))
      src.stop(time + size + 0.01)
      live.add({ src, win, pan, end: time + size })
    }

    // Grain spacing, shared by the live scheduler and the offline pre-roll.
    const gap = () => {
      const density = clamp(params.density + cv.dens * 99, 1, 100)
      const jitter = clamp(params.jitter, 0, 1)
      return Math.max(0.005, (1 / density) * (1 + (random() * 2 - 1) * jitter * 0.5))
    }

    // A bounce renders faster than wall clock, so a setTimeout-driven grain clock
    // never fires and the cloud comes out silent. An OfflineAudioContext knows its
    // whole length up front, so lay every grain down at mount instead.
    const offlineSeconds = typeof ctx.startRendering === 'function' && ctx.length ? ctx.length / ctx.sampleRate : 0
    if (offlineSeconds > 0) {
      for (let time = 0; time < offlineSeconds; time += gap()) spawn(time)
    }

    const scheduler = new LookaheadScheduler({
      getCurrentTime: () => ctx.currentTime,
      // steps: 1 — the step counter is unused here, and the default Infinity
      // grows the scheduler's stepTimes array forever at 100 grains a second.
      steps: 1,
      // A grain stamped in the past would play late and out of window; the
      // scheduler can hand one back after a tab throttle or a re-sync.
      schedule: (step, time) => { if (time >= ctx.currentTime - 0.05) spawn(time) },
      advance: gap
    })
    if (!offlineSeconds) scheduler.start({ time: ctx.currentTime })

    return {
      inputs: { trig: [trig], pos: [cvIn.pos], dens: [cvIn.dens], pitch: [cvIn.pitch] },
      outputs: { out: [out] },
      setParam(key, value, atTime = ctx.currentTime) {
        params[key] = value
        if (key === 'level') out.gain.setTargetAtTime(clamp(value, 0, 1), atTime, 0.01)
      },
      uiState() { return { file: params.fileKey || '', ready: !!getBuffer(params.fileKey), grains: live.size } },
      // TRIG re-seeds the cloud: the grain clock restarts at the event time, so a
      // free-running cloud can still be pulled back onto the beat.
      onEvent(port, event) {
        if (port !== 'trig' || (event.type !== 'trig' && event.type !== 'gate-on')) return
        scheduler.stop()
        scheduler.start({ time: event.time ?? ctx.currentTime })
      },
      dispose() {
        scheduler.stop()
        removePoll?.()
        const now = ctx.currentTime
        for (const grain of live) {
          try { grain.src.stop(now) } catch { /* already ended */ }
          grain.src.disconnect()
          grain.win.disconnect()
          grain.pan.disconnect()
        }
        live.clear()
        for (const node of [trig, out, ...Object.values(cvIn)]) node.disconnect()
      }
    }
  },

  panel(module, ctx) { return filePanel(ctx) }
}
