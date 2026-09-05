/**
 * midi-hold.js
 * Sustain pedal (CC64), per MIDI channel, as a pure reducer.
 * While a channel is held, note-offs on it are deferred and flushed in
 * order when the pedal lifts. A note-on for an already-deferred pitch
 * emits its note-off first, then the note-on (retrigger, not orphan).
 * Everything else passes through unchanged.
 */

const EMPTY_STATE = { held: new Map(), deferred: new Map() }

export function holdReducer(state = EMPTY_STATE, event) {
  // ponytail: clone Maps only on branches that actually write; the common
  // pass-through path (e.g. dense aftertouch while a pad is held) returns the
  // same state object instead of allocating two Maps per message.
  if (event.kind === 'cc' && event.controller === 64) {
    const held = new Map(state.held)
    if (event.value >= 64) {
      held.set(event.channel, true)
      return { state: { held, deferred: state.deferred }, emit: [] }
    }
    held.delete(event.channel)
    const deferred = new Map(state.deferred)
    const pitches = deferred.get(event.channel) || []
    deferred.delete(event.channel)
    return { state: { held, deferred }, emit: pitches.map(pitch => ({ kind: 'note-off', channel: event.channel, pitch })) }
  }

  if (event.kind === 'note-off' && state.held.get(event.channel)) {
    const deferred = new Map(state.deferred)
    const pitches = deferred.get(event.channel) || []
    deferred.set(event.channel, [...pitches, event.pitch])
    return { state: { held: state.held, deferred }, emit: [] }
  }

  if (event.kind === 'note-on' && state.held.get(event.channel)) {
    const pitches = state.deferred.get(event.channel) || []
    if (pitches.includes(event.pitch)) {
      const deferred = new Map(state.deferred)
      deferred.set(event.channel, pitches.filter(pitch => pitch !== event.pitch))
      return { state: { held: state.held, deferred }, emit: [{ kind: 'note-off', channel: event.channel, pitch: event.pitch }, event] }
    }
  }

  return { state, emit: [event] }
}
