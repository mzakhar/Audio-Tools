// Pure loop-record helpers. Units: beats; note velocity 0..1.
import { snap } from './groove.js'

const r9 = (x) => Math.round(x * 1e9) / 1e9

/** Wrap a transport beat into [0, loopBeats). */
export function loopPosition(beat, loopBeats) {
  return r9(((beat % loopBeats) + loopBeats) % loopBeats)
}

/** Empty overdub pass. `wiped` holds note ids. */
export function newPass() {
  return { added: [], wiped: [] }
}

/** True when the pass has nothing to commit. */
export function passIsEmpty(pass) {
  return pass.added.length === 0 && pass.wiped.length === 0
}

/** Add a hit (velocity 0..127 in) snapped/swung and wrapped into the loop; returns a new pass. */
export function passAddHit(pass, { pitch, velocity, beat }, { loopBeats, grid, strength, swing, id }) {
  const snapped = snap(beat, { grid, strength, swing })
  const note = {
    id,
    pitch,
    velocity: Math.min(1, Math.max(0, velocity / 127)),
    startBeat: loopPosition(snapped, loopBeats),
    duration: grid,
    // Lap the snapped hit lands in: the live hit already sounded, so the player
    // skips that repetition. Stripped by applyPass before commit.
    lap: Math.floor(r9(snapped) / loopBeats),
  }
  return { ...pass, added: [...pass.added, note] }
}

// True when startBeat lies in the wrap-aware window starting at loop position `from`, length `len`.
const inWindow = (startBeat, from, len, loopBeats) =>
  loopPosition(startBeat - from, loopBeats) < len - 1e-9

/** Wipe notes (pitch null = all) in [fromBeat, toBeat), wrap-aware; drops matching added hits too. */
export function passWipe(pass, clipNotes, { pitch, fromBeat, toBeat, loopBeats }) {
  const len = Math.min(toBeat - fromBeat, loopBeats)
  if (len <= 0) return pass
  const from = loopPosition(fromBeat, loopBeats)
  const hit = (n) => (pitch === null || n.pitch === pitch) && inWindow(n.startBeat, from, len, loopBeats)
  const ids = clipNotes.filter(hit).map((n) => n.id)
  return {
    added: pass.added.filter((n) => !hit(n)),
    wiped: [...new Set([...pass.wiped, ...ids])],
  }
}

/** clipNotes minus wiped plus added, sorted by startBeat then pitch. Added notes lose `lap` unless keepLap (playback). */
export function applyPass(clipNotes, pass, keepLap = false) {
  const wiped = new Set(pass.wiped)
  const added = keepLap ? pass.added : pass.added.map(({ lap, ...n }) => n)
  return [...clipNotes.filter((n) => !wiped.has(n.id)), ...added]
    .sort((a, b) => a.startBeat - b.startBeat || a.pitch - b.pitch)
}

/** Every loop repetition (k>=0) of each note landing in [fromBeat, toBeat), as { note, beat, k }, sorted by beat.
 *  Notes beyond loopBeats wrap (loopPosition), so a shrunk loop still plays them. */
export function notesInWindow(notes, loopBeats, fromBeat, toBeat) {
  const out = []
  if (!(loopBeats > 0)) return out
  for (const note of notes) {
    const base = loopPosition(note.startBeat, loopBeats)
    let k = Math.max(0, Math.ceil((fromBeat - base) / loopBeats - 1e-9))
    for (; ; k++) {
      const beat = r9(k * loopBeats + base)
      if (beat >= toBeat) break
      if (beat >= fromBeat) out.push({ note, beat, k })
    }
  }
  return out.sort((a, b) => a.beat - b.beat)
}

/** Metronome clicks on integer beats in [fromBeat, toBeat); accent on bar downbeats. Negative beats allowed. */
export function clicksInWindow(fromBeat, toBeat, beatsPerBar) {
  const out = []
  for (let beat = Math.ceil(fromBeat); beat < toBeat; beat++) {
    out.push({ beat, accent: (((beat % beatsPerBar) + beatsPerBar) % beatsPerBar) === 0 })
  }
  return out
}
