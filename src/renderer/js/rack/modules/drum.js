import { INSTRUMENTS, createTr909Voice } from '../../drums/tr909-kit.js'
const voices = INSTRUMENTS.map(x => x.id)
export default {
  type: 'drum', name: 'DRUM', group: 'source', hp: 8, tier: 'native', poly: false,
  ports: [{ id: 'trig', dir: 'in', kind: 'gate', label: 'TRIG' }, { id: 'acc', dir: 'in', kind: 'cv', label: 'ACC' }, { id: 'pitch', dir: 'in', kind: 'cv', label: 'PITCH' }, { id: 'out', dir: 'out', kind: 'audio', label: 'OUT' }],
  params: [{ key: 'voice', label: 'VOICE', options: voices, def: 'bd' }],
  create(ctx, { params, emitEvent = () => {} }) { const trig = ctx.createGain(), acc = ctx.createGain(), pitch = ctx.createGain(), out = ctx.createGain(); const kit = Object.fromEntries(INSTRUMENTS.map(x => [x.id, x.params])); const active = new Set(); return { inputs: { trig: [trig], acc: [acc], pitch: [pitch] }, outputs: { out: [out] }, setParam(key, value) { params[key] = value }, onEvent(port, event) { if (port !== 'trig' || !['trig', 'gate-on'].includes(event.type)) return; const voice = createTr909Voice(ctx, out, params.voice, kit[params.voice], { velocity: event.velocity ?? 1, accent: event.accent }, event.time); active.add(voice); emitEvent('out', event) }, dispose() { active.forEach(v => v.stop?.(ctx.currentTime)); trig.disconnect(); acc.disconnect(); pitch.disconnect(); out.disconnect() } } }
}
