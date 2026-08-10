import { buildImpulseResponse } from '../../utils/impulse.js'

export default {
  type: 'reverb', name: 'REVERB', group: 'fx', hp: 8, tier: 'native', poly: false,
  ports: [{ id: 'in', dir: 'in', kind: 'audio', label: 'IN' }, { id: 'mix', dir: 'in', kind: 'cv', label: 'MIX', atten: true }, { id: 'out', dir: 'out', kind: 'audio', label: 'OUT' }],
  params: [
    { key: 'size', label: 'SIZE', min: 0.2, max: 6, step: 0.1, def: 2, fmt: 's' },
    { key: 'damp', label: 'DAMP', min: 0, max: 1, step: 0.01, def: 0.3, fmt: '' },
    { key: 'mix', label: 'MIX', min: 0, max: 1, step: 0.01, def: 0.3, fmt: '' },
    { key: 'predelay', label: 'PREDELAY', min: 0, max: 200, step: 1, def: 20, fmt: 'ms' }
  ],
  create(ctx, { params }) {
    const input = ctx.createGain(), predelay = ctx.createDelay(0.2), damp = ctx.createBiquadFilter(), convolver = ctx.createConvolver(), dry = ctx.createGain(), wet = ctx.createGain(), out = ctx.createGain()
    input.gain.value = dry.gain.value = out.gain.value = 1; predelay.delayTime.value = params.predelay / 1000; damp.type = 'lowpass'; damp.frequency.value = 12000 - params.damp * 11000; convolver.buffer = buildImpulseResponse(ctx, params.size, 2 + params.damp * 8); wet.gain.value = params.mix
    input.connect(dry); input.connect(predelay); predelay.connect(damp); damp.connect(convolver); convolver.connect(wet); dry.connect(out); wet.connect(out)
    return {
      inputs: { in: [input], mix: [wet.gain] }, outputs: { out: [out] },
      setParam(key, value, atTime = ctx.currentTime) { params[key] = value; if (key === 'size' || key === 'damp') { damp.frequency.setTargetAtTime(12000 - params.damp * 11000, atTime, 0.01); convolver.buffer = buildImpulseResponse(ctx, params.size, 2 + params.damp * 8) } else if (key === 'mix') wet.gain.setTargetAtTime(value, atTime, 0.01); else if (key === 'predelay') predelay.delayTime.setTargetAtTime(value / 1000, atTime, 0.01) },
      dispose() { [input, predelay, damp, convolver, dry, wet, out].forEach(n => n.disconnect()) }
    }
  }
}
