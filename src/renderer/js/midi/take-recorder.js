/**
 * take-recorder.js
 * PURE. Turns live note-on/off events (AudioContext seconds) into MIDI clips for Arrange.
 *
 * The anchor is the transport's: `startTime` is the audible time of `playBeat`, the value
 * TimelinePlayer.play() returns, so recorded notes and played-back notes share one clock.
 */
import { newId as defaultNewId } from '../utils/new-id.js'

const MIN_DURATION = 1 / 64   // beats

/**
 * createTakeRecorder({ startTime, playBeat, bpm, beatsPerBar, takeNumber, newId })
 *   note({ trackId, pitch, velocity 0..127, on, time })
 *   finish(endTime) -> [{ trackId, clip }]   one new clip per track that received notes; [] for none
 */
export function createTakeRecorder({ startTime, playBeat = 0, bpm, beatsPerBar = 4, takeNumber = 1, newId = defaultNewId }) {
  const beatAt = time => playBeat + (time - startTime) * bpm / 60
  const open = new Map()     // `${trackId}:${pitch}` -> { trackId, pitch, velocity, time }
  const done = []            // { trackId, pitch, velocity, start, end } in absolute beats

  function close(key, time) {
    const held = open.get(key)
    if (!held) return
    open.delete(key)
    // Played during the count-in: kept only if still sounding when the take starts, from its start.
    if (time <= startTime) return
    const start = beatAt(Math.max(held.time, startTime))
    done.push({ trackId: held.trackId, pitch: held.pitch, velocity: held.velocity, start, end: Math.max(beatAt(time), start + MIN_DURATION) })
  }

  return {
    note({ trackId, pitch, velocity = 0, on, time }) {
      const key = `${trackId}:${pitch}`
      close(key, time)   // a re-trigger closes the open note; a note-off closes it
      if (on) open.set(key, { trackId, pitch, velocity, time })
    },

    finish(endTime) {
      for (const key of [...open.keys()]) close(key, endTime)
      const byTrack = new Map()
      for (const note of done) {
        if (!byTrack.has(note.trackId)) byTrack.set(note.trackId, [])
        byTrack.get(note.trackId).push(note)
      }
      return [...byTrack].map(([trackId, notes]) => {
        notes.sort((a, b) => a.start - b.start)
        const startBeat = Math.floor(notes[0].start / beatsPerBar) * beatsPerBar
        const last = Math.max(...notes.map(note => note.end))
        const duration = Math.max(1, Math.ceil((last - startBeat) / beatsPerBar - 1e-9)) * beatsPerBar
        return {
          trackId,
          clip: {
            id: newId(),
            type: 'midi',
            name: `Take ${takeNumber}`,
            startBeat,
            duration,
            notes: notes.map(note => ({
              id: newId(),
              pitch: note.pitch,
              startBeat: note.start - startBeat,
              duration: note.end - note.start,
              velocity: note.velocity / 127
            }))
          }
        }
      })
    }
  }
}
