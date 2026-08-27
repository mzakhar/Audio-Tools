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
  const held = new Map(state.held)
  const deferred = new Map(state.deferred)

  if (event.kind === 'cc' && event.controller === 64) {
    if (event.value >= 64) {
      held.set(event.channel, true)
      return { state: { held, deferred }, emit: [] }
    }
    held.delete(event.channel)
    const pitches = deferred.get(event.channel) || []
    deferred.delete(event.channel)
    return { state: { held, deferred }, emit: pitches.map(pitch => ({ kind: 'note-off', channel: event.channel, pitch })) }
  }

  if (event.kind === 'note-off' && held.get(event.channel)) {
    const pitches = deferred.get(event.channel) || []
    deferred.set(event.channel, [...pitches, event.pitch])
    return { state: { held, deferred }, emit: [] }
  }

  if (event.kind === 'note-on' && held.get(event.channel)) {
    const pitches = deferred.get(event.channel) || []
    if (pitches.includes(event.pitch)) {
      deferred.set(event.channel, pitches.filter(pitch => pitch !== event.pitch))
      return { state: { held, deferred }, emit: [{ kind: 'note-off', channel: event.channel, pitch: event.pitch }, event] }
    }
  }

  return { state: { held, deferred }, emit: [event] }
}
