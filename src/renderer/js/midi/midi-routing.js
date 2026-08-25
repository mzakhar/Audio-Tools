// midi-routing.js — pure channel → track routing.
// Layering (rule 1) and omni fallback (rule 2) both intentional; see
// specs/midi-bridge.md Phase 2.

export function routeChannel(tracks, channel, armedTrackId) {
  const declared = tracks.filter(t => (t.midiChannel ?? null) === channel).map(t => t.id)
  if (declared.length) return declared
  const anyDeclared = tracks.some(t => (t.midiChannel ?? null) !== null)
  if (!anyDeclared) return armedTrackId != null ? [armedTrackId] : []
  return []
}
