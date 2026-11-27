// Pads session shell: owns the current overdub pass and the loop clip it lands
// in. The pass is pure data (loop-record.js); this file only decides when to
// commit it to the store. One commit = one undo step, labelled PADS_PASS_LABEL.
import { newPass, passIsEmpty, passAddHit, passWipe, applyPass } from './loop-record.js'
import { AddClip, SetMidiClipNotes, TrimClip } from '../store/ProjectStore.js'

export const PADS_PASS_LABEL = 'Pads pass'

export const loopClipOf = track => track?.clips?.find(c => c.type === 'midi' && c.loop) ?? null

/** Should this hit be recorded into the open pass? One predicate, every condition. */
export function canRecordHit({ mode, layerOn, playing, armedId, armedType }, detail, trackId) {
  return mode === 'pads' && !!layerOn && !!playing && trackId === armedId
    && armedType === 'kit' && detail?.kind === 'note-on'
}

/**
 * deps: getTrack(id) -> store track (read-only snapshot), dispatch(cmd),
 * dispatchBatch(cmds, label), undo(), getUndoLabel(), newId().
 */
export function createPadsSession({ getTrack, dispatchBatch, undo, getUndoLabel = () => null, newId }) {
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
    const loopBeats = loopBars * beatsPerBar
    const clip = loopClipOf(track)
    if (clip) {
      const cmds = [SetMidiClipNotes(trackId, clip.id, applyPass(clip.notes ?? [], done))]
      // A shrunk/grown Bars setting: the clip follows it so the arrange view plays what was heard.
      if (clip.duration !== loopBeats) cmds.push(TrimClip(trackId, clip.id, clip.offset ?? 0, loopBeats))
      dispatchBatch(cmds, PADS_PASS_LABEL)
    } else {
      const id = newId()
      dispatchBatch([
        AddClip(trackId, { id, type: 'midi', name: 'Pads loop', loop: true, startBeat: 0, duration: loopBeats, notes: [] }),
        SetMidiClipNotes(trackId, id, applyPass([], done)),
      ], PADS_PASS_LABEL)
    }
    return true
  }

  // A pass belongs to one track; moving to another commits the old one first.
  const claim = (trackId, loopBars, beatsPerBar) => {
    if (passTrackId && passTrackId !== trackId) commit(loopBars, beatsPerBar)
    passTrackId = trackId
  }

  // Undo is scoped: the open pass, else only our own last commit — never someone else's step.
  const canUndo = () => !passIsEmpty(pass) || getUndoLabel() === PADS_PASS_LABEL

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
    /** Clip notes with the open pass applied — what the loop player plays (added notes keep `lap`). */
    notes(trackId) {
      const base = clipNotes(trackId)
      const livePass = passTrackId === trackId ? pass : null
      if (memo.notes !== base || memo.pass !== livePass) {
        memo = { notes: base, pass: livePass, out: livePass ? applyPass(base, livePass, true) : base }
      }
      return memo.out
    },
    commit,
    /** Drop the open pass without committing (project replaced). */
    discard() { pass = newPass(); passTrackId = null },
    /** Discard an open pass, else undo our own last commit. Returns 'discarded' | 'undone' | 'none'. */
    undo() {
      if (!passIsEmpty(pass)) { pass = newPass(); passTrackId = null; return 'discarded' }
      if (getUndoLabel() !== PADS_PASS_LABEL) return 'none'
      undo()
      return 'undone'
    },
    canUndo,
    hasPass: () => !passIsEmpty(pass),
  }
}
