// FOLLOW — envelope follower. RMS off an AnalyserNode tap, smoothed into a
// ConstantSourceNode so the ENV jack is a normal CV output, plus a GATE event
// when the level crosses THRESHOLD.
//
// The analyser is a leaf (IN -> analyser only, nothing downstream) so it keeps
// pulling automatically even when nothing else in the subgraph reaches the
// destination — same rule METER documents.
//
// ponytail: the level is read on the shared 30 Hz poll. Fine for filter sweeps,
// ducking and slow VCA rides; useless for transient tracking — a drum attack
// lives and dies inside one poll frame. Audio-rate following needs a worklet.

import { levels } from '../viz.js'

export default {
  type: 'follow', name: 'FOLLOW', group: 'mod', hp: 4, tier: 'native', poly: false,
  ports: [
    { id: 'in', dir: 'in', kind: 'audio', label: 'IN' },
    { id: 'env', dir: 'out', kind: 'cv', label: 'ENV' },
    { id: 'gate', dir: 'out', kind: 'gate', label: 'GATE' }
  ],
  params: [
    { key: 'gain', label: 'GAIN', min: 0, max: 4, step: 0.01, def: 1, fmt: '' },
    { key: 'attack', label: 'ATTACK', min: 1, max: 500, step: 1, def: 10, fmt: 'ms' },
    { key: 'release', label: 'RELEASE', min: 10, max: 2000, step: 1, def: 200, fmt: 'ms' },
    { key: 'threshold', label: 'THRESH', min: 0, max: 1, step: 0.01, def: 0.2, fmt: '' }
  ],

  create(ctx, { params = {}, poll = null, emitEvent = () => {} } = {}) {
    const input = ctx.createGain()
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 512
    const envSrc = ctx.createConstantSource()
    const env = ctx.createGain()
    const gate = ctx.createGain()
    envSrc.offset.value = 0
    input.connect(analyser)
    envSrc.connect(env)
    envSrc.start()

    const buf = new Float32Array(analyser.fftSize)
    let level = 0, open = false

    const removePoll = poll?.add(() => {
      analyser.getFloatTimeDomainData?.(buf)
      const target = Math.min(1, levels(buf).rms * Math.SQRT2 * params.gain)
      const tau = Math.max(0.001, (target > level ? params.attack : params.release) / 3000)
      level = target
      const now = ctx.currentTime
      envSrc.offset.setTargetAtTime(target, now, tau)
      // Hysteresis so a signal sitting on the threshold does not chatter gates.
      const thresh = params.threshold
      // Absolute floor, not a percentage: at THRESH 0 a relative 0.9 gives a
      // close condition of `target < 0`, which an RMS can never satisfy — the
      // gate would open once and never shut, holding a downstream ADSR forever.
      const closeAt = Math.max(0.001, thresh * 0.9 - 0.005)
      if (!open && target > thresh) { open = true; emitEvent('gate', { type: 'gate-on', time: now, channel: 0 }) }
      else if (open && target < closeAt) { open = false; emitEvent('gate', { type: 'gate-off', time: now, channel: 0 }) }
    })

    return {
      inputs: { in: [input] },
      outputs: { env: [env], gate: [gate] },
      setParam(key, value) { params[key] = value },
      uiEnv() { return level },
      dispose() {
        removePoll?.()
        // Close the gate on the way out, or whatever it was holding open stays
        // open after FOLLOW is gone.
        if (open) { open = false; emitEvent('gate', { type: 'gate-off', time: ctx.currentTime, channel: 0 }) }
        envSrc.stop()
        for (const node of [input, analyser, envSrc, env, gate]) node.disconnect()
      }
    }
  }
}
