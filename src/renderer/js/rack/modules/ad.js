// AD — event-domain attack/decay envelope.
export default {
  type: 'ad', name: 'AD', group: 'env', hp: 6, tier: 'native', poly: true,
  ports: [
    { id: 'trig', dir: 'in', kind: 'gate', label: 'TRIG' },
    { id: 'env', dir: 'out', kind: 'cv', label: 'ENV' },
    { id: 'eoc', dir: 'out', kind: 'gate', label: 'EOC' }
  ],
  params: [
    { key: 'attack', label: 'ATTACK', min: 0.001, max: 8, step: 0.001, def: 0.01, fmt: 's' },
    { key: 'decay', label: 'DECAY', min: 0.001, max: 8, step: 0.001, def: 0.2, fmt: 's' },
    { key: 'curve', label: 'CURVE', options: ['lin', 'exp'], def: 'exp' },
    { key: 'loop', label: 'LOOP', options: ['off', 'on'], def: 'off' }
  ],

  create(ctx, { channels = 1, params, emitEvent = () => {} }) {
    const loopTimers = new Set()
    const voices = Array.from({ length: channels }, () => {
      const trig = ctx.createGain()
      const env = ctx.createConstantSource()
      const out = ctx.createGain()
      const eoc = ctx.createGain()
      env.offset.value = 0
      env.connect(out)
      env.start()
      return { trig, env, out, eoc }
    })

    function fire(channel, time) {
      const v = voices[channel]
      if (!v) return
      const p = v.env.offset
      p.cancelScheduledValues(time)
      p.setValueAtTime(p.value, time)
      p.linearRampToValueAtTime(1, time + params.attack)
      if (params.curve === 'exp') p.setTargetAtTime(0, time + params.attack, params.decay / 3)
      else p.linearRampToValueAtTime(0, time + params.attack + params.decay)
      const end = time + params.attack + params.decay
      emitEvent('eoc', { type: 'trig', time: end, channel })
      if (params.loop === 'on') {
        // ponytail: timer loop until the shared event scheduler owns looping modules.
        const timer = setTimeout(() => { loopTimers.delete(timer); fire(channel, Math.max(end, ctx.currentTime)) }, Math.max(0, (end - ctx.currentTime) * 1000))
        loopTimers.add(timer)
      }
    }

    return {
      inputs: { trig: voices.map(v => v.trig) },
      outputs: { env: voices.map(v => v.out), eoc: voices.map(v => v.eoc) },
      setParam(key, value) { params[key] = value },
      onEvent(portId, event) {
        if (portId === 'trig' && (event.type === 'trig' || event.type === 'gate-on')) {
          fire(Math.min(event.channel ?? 0, voices.length - 1), event.time)
        }
      },
      dispose() {
        for (const timer of loopTimers) clearTimeout(timer)
        loopTimers.clear()
        for (const v of voices) {
          v.env.stop(); v.trig.disconnect(); v.env.disconnect(); v.out.disconnect(); v.eoc.disconnect()
        }
        voices.length = 0
      }
    }
  }
}
