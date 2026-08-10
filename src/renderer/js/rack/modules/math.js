export default {
  type: 'math', name: 'MATH', group: 'util', hp: 6, tier: 'native', poly: true,
  ports: [
    { id: 'a', dir: 'in', kind: 'cv', label: 'A' }, { id: 'b', dir: 'in', kind: 'cv', label: 'B' },
    { id: 'add', dir: 'out', kind: 'cv', label: 'A+B' }, { id: 'sub', dir: 'out', kind: 'cv', label: 'A−B' },
    { id: 'mul', dir: 'out', kind: 'cv', label: 'A×B' },
    { id: 'min', dir: 'out', kind: 'cv', label: 'MIN', disabled: true, tooltip: 'Requires AudioWorklet' },
    { id: 'max', dir: 'out', kind: 'cv', label: 'MAX', disabled: true, tooltip: 'Requires AudioWorklet' }
  ],
  params: [{ key: 'scale', label: 'SCALE', min: 0, max: 2, step: 0.01, def: 1, fmt: '' }],
  create(ctx, { channels = 1, params }) {
    const voices = Array.from({ length: channels }, () => {
      const a = ctx.createGain(), b = ctx.createGain(), add = ctx.createGain(), invert = ctx.createGain(), sub = ctx.createGain(), multiply = ctx.createGain(), addScale = ctx.createGain(), subScale = ctx.createGain(), mulScale = ctx.createGain(), min = ctx.createGain(), max = ctx.createGain()
      a.gain.value = b.gain.value = add.gain.value = sub.gain.value = addScale.gain.value = subScale.gain.value = mulScale.gain.value = 1; invert.gain.value = -1; multiply.gain.value = 0; min.gain.value = max.gain.value = 0
      a.connect(add); b.connect(add); add.connect(addScale); a.connect(sub); b.connect(invert); invert.connect(sub); sub.connect(subScale); a.connect(multiply); b.connect(multiply.gain); multiply.connect(mulScale)
      return { a, b, add, invert, sub, multiply, addScale, subScale, mulScale, min, max }
    })
    return {
      inputs: { a: voices.map(v => v.a), b: voices.map(v => v.b) },
      outputs: { add: voices.map(v => v.addScale), sub: voices.map(v => v.subScale), mul: voices.map(v => v.mulScale), min: voices.map(v => v.min), max: voices.map(v => v.max) },
      setParam(key, value, atTime = ctx.currentTime) { params[key] = value; if (key === 'scale') voices.forEach(v => [v.addScale, v.subScale, v.mulScale].forEach(n => n.gain.setTargetAtTime(value, atTime, 0.01))) },
      dispose() { voices.forEach(v => Object.values(v).forEach(n => n.disconnect())) }
    }
  }
}
