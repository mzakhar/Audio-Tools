// FMOP — compact native carrier/modulator oscillator.
export default {
  type: 'fmop', name: 'FMOP', group: 'source', hp: 8, tier: 'native', poly: true,
  ports: [{ id: 'voct', dir: 'in', kind: 'cv', label: 'V/OCT' }, { id: 'mod', dir: 'in', kind: 'audio', label: 'MOD', atten: true }, { id: 'idx', dir: 'in', kind: 'cv', label: 'IDX', atten: true }, { id: 'out', dir: 'out', kind: 'audio', label: 'OUT' }],
  params: [{ key: 'ratio', label: 'RATIO', min: .25, max: 16, step: .01, def: 1, fmt: '' }, { key: 'index', label: 'INDEX', min: 0, max: 10, step: .01, def: 1, fmt: '' }, { key: 'wave', label: 'WAVE', options: ['sine', 'triangle'], def: 'sine' }, { key: 'feedback', label: 'FEEDBACK', min: 0, max: .9, step: .01, def: 0, fmt: '' }],
  create(ctx, { channels = 1, params }) {
    const voices = Array.from({ length: channels }, () => { const pitch = ctx.createGain(), mod = ctx.createGain(), idx = ctx.createGain(), osc = ctx.createOscillator(), out = ctx.createGain(); pitch.gain.value = 12000; mod.gain.value = params.index; idx.gain.value = params.index; osc.type = params.wave; osc.frequency.value = 261.625 * params.ratio; pitch.connect(osc.detune); mod.connect(osc.frequency); idx.connect(mod.gain); osc.connect(out); osc.start(); return { pitch, mod, idx, osc, out } })
    return { inputs: { voct: voices.map(v => v.pitch), mod: voices.map(v => v.mod), idx: voices.map(v => v.idx) }, outputs: { out: voices.map(v => v.out) }, setParam(key, value, at = ctx.currentTime) { params[key] = value; for (const v of voices) { if (key === 'wave') v.osc.type = value; if (key === 'ratio') v.osc.frequency.setTargetAtTime(261.625 * value, at, .01); if (key === 'index') v.mod.gain.setTargetAtTime(value, at, .01) } }, dispose() { voices.forEach(v => { v.osc.stop(); Object.values(v).forEach(n => n.disconnect()) }) } }
  }
}
