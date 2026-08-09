export default {
  type: 'ringmod', name: 'RINGMOD', group: 'fx', hp: 4, tier: 'native', poly: true,
  ports: [
    { id: 'x', dir: 'in', kind: 'audio', label: 'X' }, { id: 'y', dir: 'in', kind: 'audio', label: 'Y' },
    { id: 'out', dir: 'out', kind: 'audio', label: 'OUT' }
  ],
  params: [{ key: 'mix', label: 'MIX', min: 0, max: 1, step: 0.01, def: 1, fmt: '' }],
  create(ctx, { channels = 1, params }) {
    const voices = Array.from({ length: channels }, () => {
      const x = ctx.createGain(), product = ctx.createGain(), dry = ctx.createGain(), wet = ctx.createGain(), out = ctx.createGain()
      x.gain.value = dry.gain.value = 1; product.gain.value = 0; wet.gain.value = params.mix; out.gain.value = 1
      x.connect(product); x.connect(dry); product.connect(wet); dry.connect(out); wet.connect(out)
      return { x, product, dry, wet, out }
    })
    return {
      inputs: { x: voices.map(v => v.x), y: voices.map(v => v.product.gain) }, outputs: { out: voices.map(v => v.out) },
      setParam(key, value, atTime = ctx.currentTime) { params[key] = value; if (key === 'mix') voices.forEach(v => v.wet.gain.setTargetAtTime(value, atTime, 0.01)) },
      dispose() { voices.forEach(v => Object.values(v).forEach(n => n.disconnect())) }
    }
  }
}
