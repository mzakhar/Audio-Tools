// arm-track.js — pure: which MIDI track a played note belongs to.
// One selection: the armed track, else the first MIDI track, else none — and
// "none" means provision one, once, not one per note.

export function armPlan(tracks = [], armedId = null) {
  const midi = tracks.filter(track => track.type === 'midi')
  const track = midi.find(item => item.id === armedId) || midi[0] || null
  return track ? { trackId: track.id, provision: false } : { trackId: null, provision: true }
}
