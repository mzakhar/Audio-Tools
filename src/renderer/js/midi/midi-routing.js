// midi-routing.js — pure channel → track routing.
// Layering (rule 1) and omni fallback (rule 2) both intentional; see
// specs/midi-bridge.md Phase 2.

export function routeChannel(tracks, channel, armedTrackId) {
  const declared = tracks.filter(t => (t.midiChannel ?? null) === channel).map(t => t.id)
  if (declared.length) return declared
  const anyDeclared = tracks.some(t => (t.midiChannel ?? null) !== null)
  if (anyDeclared) return []
  const armed = tracks.find(track => track.id === armedTrackId)
  if (armed) return [armed.id]
  // A new project commonly has exactly one Omni MIDI track. It must be
  // playable before a user discovers track arming or channel assignment.
  const omni = tracks.filter(track => (track.midiChannel ?? null) === null)
  if (omni.length === 1) return [omni[0].id]
  return []
}
