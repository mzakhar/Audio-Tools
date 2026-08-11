import { FILE_PARAM, filePanel } from './sample-file.js'

// SAMPLR — one-shot sample player. The buffer arrives through `opts.getBuffer`,
// which may still be decoding when a trigger lands: a missing buffer is silence
// and a warning badge, never a throw and never a half-built voice.

const CHOKE_FADE = 0.005   // click guard on a choked voice, in seconds
const clamp = (v, lo, hi) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo)

export default {
  // panelInline: the drawn panel is one file-button row, so the knobs wrap above
  // it across the full width instead of being squeezed into a side column.
  type: 'sampler', name: 'SAMPLR', group: 'source', hp: 20, tier: 'native', poly: false, panelInline: true,
  ports: [
    { id: 'trig', dir: 'in', kind: 'gate', label: 'TRIG' },
    { id: 'pitch', dir: 'in', kind: 'cv', label: 'PITCH' },
    { id: 'start', dir: 'in', kind: 'cv', label: 'START', atten: true },
    { id: 'out', dir: 'out', kind: 'audio', label: 'OUT' }
  ],
  params: [
    FILE_PARAM,
    { key: 'start', label: 'START', min: 0, max: 1, step: 0.001, def: 0, fmt: '' },
    { key: 'end', label: 'END', min: 0, max: 1, step: 0.001, def: 1, fmt: '' },
    { key: 'pitch', label: 'PITCH', min: -24, max: 24, step: 1, def: 0, fmt: '' },
    { key: 'decay', label: 'DECAY', min: 0.01, max: 4, step: 0.01, def: 4, fmt: 's' },
    { key: 'choke', label: 'CHOKE', min: 0, max: 4, step: 1, def: 0, fmt: '' },
    { key: 'level', label: 'LEVEL', min: 0, max: 1, step: 0.01, def: 0.8, fmt: '' },
    { key: 'reverse', label: 'REV', def: false, toggle: true },
    { key: 'loop', label: 'LOOP', def: false, toggle: true }
  ],

  create(ctx, { params, poll = null, getBuffer = () => null }) {
    const trig = ctx.createGain(), out = ctx.createGain()
    out.gain.value = 1
    // PITCH and START are read once, when a voice starts, so they cannot be
    // AudioParams on a node that does not exist yet — analyser taps on the
    // shared 30 Hz poll, the E1 convention, 1.0 CV = full knob range.
    // ponytail: 30 Hz control rate. Per-trigger CV finer than a poll tick needs
    // an audio-rate read, which means a worklet.
    const cvIn = { pitch: ctx.createAnalyser(), start: ctx.createAnalyser() }
    for (const node of Object.values(cvIn)) node.fftSize = 32
    const frame = new Float32Array(32)
    const cv = { pitch: 0, start: 0 }
    const remove = poll?.add(() => {
      for (const key of ['pitch', 'start']) {
        cvIn[key].getFloatTimeDomainData?.(frame)
        cv[key] = frame[0] || 0
      }
    })

    const live = new Set()
    // A reversed take is a whole second copy of the file. Build it once per
    // fileKey, not once per trigger.
    let revKey = null, revBuffer = null
    const reversed = (buffer) => {
      if (revKey === params.fileKey && revBuffer) return revBuffer
      const copy = ctx.createBuffer(buffer.numberOfChannels, buffer.length, buffer.sampleRate || ctx.sampleRate)
      for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
        const from = buffer.getChannelData(ch), to = copy.getChannelData(ch)
        for (let i = 0, n = from.length; i < n; i++) to[i] = from[n - 1 - i]
      }
      revKey = params.fileKey
      revBuffer = copy
      return copy
    }

    const choke = (group, time) => {
      for (const voice of live) {
        if (voice.group !== group) continue
        voice.vca.gain.cancelScheduledValues(time)
        voice.vca.gain.setTargetAtTime(0, time, CHOKE_FADE / 3)
        voice.src.stop(time + CHOKE_FADE)
        live.delete(voice)
      }
    }

    return {
      inputs: { trig: [trig], pitch: [cvIn.pitch], start: [cvIn.start] },
      outputs: { out: [out] },
      setParam(key, value) {
        params[key] = value
        if (key === 'fileKey') { revKey = null; revBuffer = null }
      },
      // What the panel shows: which file, and whether its buffer has landed yet.
      uiState() { return { file: params.fileKey || '', ready: !!getBuffer(params.fileKey) } },
      onEvent(port, event) {
        if (port !== 'trig' || (event.type !== 'trig' && event.type !== 'gate-on')) return
        const time = event.time ?? ctx.currentTime
        const source = getBuffer(params.fileKey)
        if (!source) return                      // no file, or still decoding
        for (const voice of live) if (voice.end <= ctx.currentTime) live.delete(voice)

        const group = Math.round(params.choke) || 0   // group 0 chokes nothing
        if (group) choke(group, time)

        const buffer = params.reverse ? reversed(source) : source
        const duration = buffer.duration || 0
        const lo = clamp(params.start + cv.start, 0, 1)
        const hi = clamp(params.end, 0, 1)
        // Reverse mirrors the window too, or the START knob would run backwards.
        const window = Math.max(0, hi - lo) * duration
        const offset = (params.reverse ? 1 - hi : lo) * duration
        if (!(window > 0)) return

        const rate = Math.pow(2, (params.pitch + cv.pitch * 120) / 12)
        const src = ctx.createBufferSource()
        src.buffer = buffer
        src.playbackRate.value = rate
        const vca = ctx.createGain()
        src.connect(vca)
        vca.connect(out)
        const decay = clamp(params.decay, 0.01, 4)
        vca.gain.setValueAtTime(clamp(params.level, 0, 1), time)
        vca.gain.setTargetAtTime(0, time, decay / 4)
        // `duration` on start() is measured in buffer seconds, so the played
        // length is window/rate. A short decay is the chop; a long one just
        // lets the slice run out.
        const played = params.loop ? decay : Math.min(window / rate, decay)
        if (params.loop) {
          src.loop = true
          src.loopStart = offset
          src.loopEnd = offset + window
          src.start(time, offset)
        } else {
          src.start(time, offset, window)
        }
        src.stop(time + played + CHOKE_FADE)
        live.add({ src, vca, group, end: time + played })
      },
      dispose() {
        remove?.()
        const now = ctx.currentTime
        for (const voice of live) {
          try { voice.src.stop(now) } catch { /* already ended */ }
          voice.src.disconnect()
          voice.vca.disconnect()
        }
        live.clear()
        for (const node of [trig, out, ...Object.values(cvIn)]) node.disconnect()
      }
    }
  },

  panel(module, ctx) { return filePanel(ctx) }
}
