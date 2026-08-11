export const SCALES = {
  chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10], dorian: [0, 2, 3, 5, 7, 9, 10],
  'pent-min': [0, 3, 5, 7, 10], 'pent-maj': [0, 2, 4, 7, 9], whole: [0, 2, 4, 6, 8, 10],
  'harm-min': [0, 2, 3, 5, 7, 8, 11]
}

export function quantizePitchCv(value, scale = 'chromatic', root = 0, transpose = 0) {
  const semitones = value * 120 + transpose
  const notes = SCALES[scale] || SCALES.chromatic
  let nearest = 0, distance = Infinity
  for (let note = Math.floor(semitones) - 12; note <= Math.ceil(semitones) + 12; note++) {
    if (!notes.includes(((note - root) % 12 + 12) % 12)) continue
    const d = Math.abs(note - semitones)
    if (d < distance) { nearest = note; distance = d }
  }
  return nearest / 120
}

// QUANT — quantizes pitch carried by a trigger event; continuous signal
// quantization belongs to the worklet tier and is deliberately not faked here.
export default {
  type: 'quant', name: 'QUANT', group: 'util', hp: 6, tier: 'native', poly: true,
  ports: [
    { id: 'in', dir: 'in', kind: 'cv', label: 'IN' }, { id: 'trig', dir: 'in', kind: 'gate', label: 'TRIG' },
    { id: 'out', dir: 'out', kind: 'cv', label: 'OUT' }, { id: 'trigOut', dir: 'out', kind: 'gate', label: 'TRIG' }
  ],
  params: [
    { key: 'scale', label: 'SCALE', options: Object.keys(SCALES), def: 'chromatic' },
    { key: 'root', label: 'ROOT', min: 0, max: 11, step: 1, def: 0, fmt: '' },
    { key: 'transpose', label: 'TRANSPOSE', min: -24, max: 24, step: 1, def: 0, fmt: 'st' }
  ],

  create(ctx, { channels = 1, params, emitEvent = () => {} }) {
    const voices = Array.from({ length: channels }, () => {
      const input = ctx.createGain(), trig = ctx.createGain(), value = ctx.createConstantSource(), out = ctx.createGain(), trigOut = ctx.createGain()
      value.offset.value = 0; value.connect(out); value.start()
      return { input, trig, value, out, trigOut }
    })
    return {
      inputs: { in: voices.map(v => v.input), trig: voices.map(v => v.trig) },
      outputs: { out: voices.map(v => v.out), trigOut: voices.map(v => v.trigOut) },
      setParam(key, value) { params[key] = value },
      onEvent(portId, event) {
        if (portId !== 'trig' || (event.type !== 'trig' && event.type !== 'gate-on')) return
        const channel = Math.min(event.channel ?? 0, voices.length - 1)
        const pitch = quantizePitchCv(event.pitch ?? event.cv ?? event.value ?? 0, params.scale, params.root, params.transpose)
        voices[channel].value.offset.setValueAtTime(pitch, event.time)
        emitEvent('trigOut', { ...event, pitch, channel })
      },
      dispose() {
        for (const v of voices) { v.value.stop(); v.input.disconnect(); v.trig.disconnect(); v.value.disconnect(); v.out.disconnect(); v.trigOut.disconnect() }
        voices.length = 0
      }
    }
  }
}
