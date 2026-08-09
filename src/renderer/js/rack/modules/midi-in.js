// MIDI IN — polyphonic event source. Host MIDI and timeline notes both enter
// through onEvent(), so allocation has one path.

import { midiToPitchCv } from '../../utils/cv.js'

const defaults = { voices: 4, allocation: 'rotate', glide: 0, bendRange: 2 }

export function allocateVoice(state, note) {
  const voices = Math.max(1, state.voices | 0)
  const active = state.active || []
  const existing = active.findIndex(v => v?.note === note)
  if (existing >= 0 && state.allocation === 'reuse') return { channel: existing, state }
  const start = state.allocation === 'reset' ? 0 : (state.next || 0) % voices
  const channel = Array.from({ length: voices }, (_, i) => (start + i) % voices)
    .find(i => !active[i]) ?? start
  const next = (channel + 1) % voices
  const nextActive = active.slice(0, voices)
  nextActive[channel] = { note }
  return { channel, state: { ...state, active: nextActive, next } }
}

export default {
  type: 'midi-in',
  name: 'MIDI IN',
  group: 'io',
  hp: 8,
  tier: 'native',
  poly: true,
  polySource: mod => mod.params?.voices ?? defaults.voices,
  ports: [
    { id: 'v_oct', dir: 'out', kind: 'cv', label: 'V/OCT' },
    { id: 'gate', dir: 'out', kind: 'gate', label: 'GATE' },
    { id: 'vel', dir: 'out', kind: 'cv', label: 'VEL' },
    { id: 'mod', dir: 'out', kind: 'cv', label: 'MOD' },
    { id: 'pb', dir: 'out', kind: 'cv', label: 'PB' }
  ],
  params: [
    { key: 'voices', label: 'VOICES', min: 1, max: 8, step: 1, def: 4, fmt: '' },
    { key: 'allocation', label: 'ALLOC', options: ['rotate', 'reuse', 'reset'], def: 'rotate' },
    { key: 'glide', label: 'GLIDE', min: 0, max: 2, step: 0.01, def: 0, fmt: 's' },
    { key: 'bendRange', label: 'BEND', min: 1, max: 24, step: 1, def: 2, fmt: 'st' }
  ],

  create(ctx, { channels = 1, params = {}, emitEvent = () => {} } = {}) {
    params = { ...defaults, ...params }
    const count = Math.max(1, channels | 0)
    const make = () => {
      const source = ctx.createConstantSource()
      source.start()
      return source
    }
    const pitch = Array.from({ length: count }, make)
    const gate = Array.from({ length: count }, make)
    const vel = Array.from({ length: count }, make)
    const mod = Array.from({ length: count }, make)
    const pb = Array.from({ length: count }, make)
    let state = { voices: count, allocation: params.allocation, active: [], next: 0 }

    const at = (source, value, time) => {
      if (params.glide && source === pitch) source.forEach(node => node.offset.setTargetAtTime(value, time, params.glide))
      else source.forEach(node => node.offset.setValueAtTime(value, time))
    }
    const noteOn = event => {
      const note = event.note ?? event.pitch
      if (!Number.isFinite(note)) return
      const picked = allocateVoice(state, note)
      state = picked.state
      const channel = picked.channel % count
      const time = event.time ?? ctx.currentTime
      pitch[channel].offset.setTargetAtTime(midiToPitchCv(note), time, params.glide || 0.001)
      vel[channel].offset.setValueAtTime((event.velocity ?? 127) / 127, time)
      gate[channel].offset.setValueAtTime(1, time)
      emitEvent('gate', { type: 'gate-on', time, channel, pitch: note, velocity: event.velocity ?? 127 })
    }
    const noteOff = event => {
      const note = event.note ?? event.pitch
      const channel = state.active.findIndex(v => v?.note === note)
      if (channel < 0) return
      const time = event.time ?? ctx.currentTime
      gate[channel % count].offset.setValueAtTime(0, time)
      state = { ...state, active: state.active.map((v, i) => i === channel ? null : v) }
      emitEvent('gate', { type: 'gate-off', time, channel: channel % count, pitch: note })
    }

    return {
      inputs: {},
      outputs: { v_oct: pitch, gate, vel, mod, pb },
      setParam(key, value) { params[key] = value; if (key === 'allocation') state = { ...state, allocation: value } },
      onEvent(port, event) {
        if (event.type === 'note-on' || event.type === 'midi-note-on') noteOn(event)
        else if (event.type === 'note-off' || event.type === 'midi-note-off') noteOff(event)
        else if (event.type === 'mod') at(mod, event.value ?? 0, event.time ?? ctx.currentTime)
        else if (event.type === 'pitch-bend') at(pb, (event.value ?? 0) * params.bendRange / 24, event.time ?? ctx.currentTime)
      },
      dispose() { for (const node of [...pitch, ...gate, ...vel, ...mod, ...pb]) { node.stop(); node.disconnect() } }
    }
  }
}
