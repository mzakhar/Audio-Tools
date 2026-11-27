// Pads session shell: owns the current overdub pass and the loop clip it lands
// in. The pass is pure data (loop-record.js); this file only decides when to
// commit it to the store. One commit = one undo step.
import { newPass, passIsEmpty, passAddHit, passWipe, applyPass } from './loop-record.js'
import { AddClip, SetMidiClipNotes } from '../store/ProjectStore.js'

export const loopClipOf = track => track?.clips?.find(c => c.type === 'midi' && c.loop) ?? null

/**
 * deps: getTrack(id) -> store track (read-only snapshot), dispatch(cmd),
 * dispatchBatch(cmds, label), undo(), newId().
 */
export function createPadsSession({ getTrack, dispatch, dispatchBatch, undo, newId }) {
  let pass = newPass()
  let passTrackId = null
  let memo = { notes: null, pass: null, out: [] }

  const clipNotes = trackId => loopClipOf(getTrack(trackId))?.notes ?? []

  function commit(loopBars, beatsPerBar) {
    const trackId = passTrackId
    const done = pass
    pass = newPass()
    passTrackId = null
    if (!trackId || passIsEmpty(done)) return false
    const track = getTrack(trackId)
    if (!track) return false
    const clip = loopClipOf(track)
    if (clip) {
      dispatch(SetMidiClipNotes(trackId, clip.id, applyPass(clip.notes ?? [], done)))
    } else {
      const id = newId()
      dispatchBatch([
        AddClip(trackId, { id, type: 'midi', name: 'Pads loop', loop: true, startBeat: 0, duration: loopBars * beatsPerBar, notes: [] }),
        SetMidiClipNotes(trackId, id, applyPass([], done)),
      ], 'Pads layer')
    }
    return true
  }

  // A pass belongs to one track; moving to another commits the old one first.
  const claim = (trackId, loopBars, beatsPerBar) => {
    if (passTrackId && passTrackId !== trackId) commit(loopBars, beatsPerBar)
    passTrackId = trackId
  }

  return {
    hit(trackId, hit, opts, dims) {
      claim(trackId, dims.loopBars, dims.beatsPerBar)
      pass = passAddHit(pass, hit, { ...opts, id: newId() })
    },
    // pitches: iterable of pitches, or null for every pitch.
    wipe(trackId, { pitches, fromBeat, toBeat, loopBeats }, dims) {
      claim(trackId, dims.loopBars, dims.beatsPerBar)
      const notes = clipNotes(trackId)
      for (const pitch of pitches?.size ? pitches : [null]) {
        pass = passWipe(pass, notes, { pitch, fromBeat, toBeat, loopBeats })
      }
    },
    /** Clip notes with the open pass applied — what the loop player plays. */
    notes(trackId) {
      const base = clipNotes(trackId)
      const livePass = passTrackId === trackId ? pass : null
      if (memo.notes !== base || memo.pass !== livePass) {
        memo = { notes: base, pass: livePass, out: livePass ? applyPass(base, livePass) : base }
      }
      return memo.out
    },
    commit,
    /** Discard an open pass, else undo the last store step. Returns which. */
    undo() {
      if (!passIsEmpty(pass)) { pass = newPass(); passTrackId = null; return 'discarded' }
      undo()
      return 'undone'
    },
    hasPass: () => !passIsEmpty(pass),
  }
}
