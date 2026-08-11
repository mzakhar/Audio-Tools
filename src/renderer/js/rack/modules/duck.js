// DUCK — sidechain ducker. A trigger pulls the gain down to (1 − depth) over
// ATTACK and lets it settle back with a time constant, which is what a
// compressor keyed off a kick actually sounds like, without needing the kick's
// audio at all.
export default {
  type: 'duck', name: 'DUCK', group: 'fx', hp: 6, tier: 'native', poly: false,
  ports: [
    { id: 'in', dir: 'in', kind: 'audio', label: 'IN' },
    { id: 'trig', dir: 'in', kind: 'gate', label: 'TRIG' },
    { id: 'depth', dir: 'in', kind: 'cv', label: 'DEPTH', atten: true },
    { id: 'out', dir: 'out', kind: 'audio', label: 'OUT' }
  ],
  params: [
    { key: 'depth', label: 'DEPTH', min: 0, max: 1, step: 0.01, def: 0.8, fmt: '' },
    { key: 'attack', label: 'ATTACK', min: 1, max: 100, step: 1, def: 5, fmt: 'ms' },
    { key: 'release', label: 'RELEASE', min: 20, max: 1000, step: 1, def: 200, fmt: 'ms' },
    { key: 'curve', label: 'CURVE', options: ['lin', 'exp'], def: 'lin' }
  ],

  create(ctx, { params, poll = null }) {
    const input = ctx.createGain(), duck = ctx.createGain(), out = ctx.createGain(), trig = ctx.createGain()
    duck.gain.value = 1
    input.connect(duck); duck.connect(out)

    const depthIn = ctx.createAnalyser()
    depthIn.fftSize = 32
    const frame = new Float32Array(32)
    let depthCv = 0
    const remove = poll?.add(() => { depthIn.getFloatTimeDomainData?.(frame); depthCv = frame[0] || 0 })

    return {
      inputs: { in: [input], trig: [trig], depth: [depthIn] },
      outputs: { out: [out] },
      setParam(key, value) { params[key] = value },
      onEvent(port, event) {
        if (port !== 'trig' || (event.type !== 'trig' && event.type !== 'gate-on')) return
        const time = event.time ?? ctx.currentTime
        const depth = Math.max(0, Math.min(1, params.depth + depthCv))
        const attack = params.attack / 1000, release = params.release / 1000
        // exponentialRamp cannot reach 0, so a full-depth exp duck floors just
        // under it rather than throwing.
        const floor = Math.max(0.0001, 1 - depth)
        // No setValueAtTime anchor: the ramp picks up from whatever the previous
        // duck's release had reached, so overlapping triggers glide instead of
        // clicking back to unity.
        duck.gain.cancelScheduledValues(time)
        if (params.curve === 'exp') duck.gain.exponentialRampToValueAtTime(floor, time + attack)
        else duck.gain.linearRampToValueAtTime(floor, time + attack)
        duck.gain.setTargetAtTime(1, time + attack, Math.max(0.001, release / 3))
      },
      dispose() { remove?.(); input.disconnect(); duck.disconnect(); out.disconnect(); trig.disconnect(); depthIn.disconnect() }
    }
  }
}
