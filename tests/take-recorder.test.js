import { describe, expect, it } from 'vitest'
import { createTakeRecorder } from '../src/renderer/js/midi/take-recorder.js'
import { beatsToSeconds } from '../src/renderer/js/utils/timeline-math.js'

let n = 0
const newId = () => `id-${++n}`
const S = 10.25
const bpm = 97.5
const spb = 60 / bpm
const rec = (opts = {}) => createTakeRecorder({ startTime: S, playBeat: 8, bpm, beatsPerBar: 4, takeNumber: 3, newId, ...opts })
const at = beats => S + beats * spb   // audio time `beats` after the anchor

describe('createTakeRecorder', () => {
  it('empty take -> []', () => {
    expect(rec().finish(at(4))).toEqual([])
  })

  it('places a note against a nonzero playBeat at bpm 97.5; clip floors/rounds to bars', () => {
    const r = rec()
    r.note({ trackId: 't1', pitch: 60, velocity: 127, on: true, time: at(1.5) })
    r.note({ trackId: 't1', pitch: 60, on: false, time: at(2.5) })
    const [{ trackId, clip }] = r.finish(at(3))
    expect(trackId).toBe('t1')
    expect(clip).toMatchObject({ type: 'midi', name: 'Take 3', startBeat: 8, duration: 4 })
    expect(clip.notes).toHaveLength(1)
    expect(clip.notes[0].startBeat).toBeCloseTo(1.5, 9)
    expect(clip.notes[0].duration).toBeCloseTo(1, 9)
    expect(clip.notes[0].velocity).toBe(1)
  })

  it('a re-trigger closes the open note; overlapping pitches pair independently', () => {
    const r = rec()
    r.note({ trackId: 't1', pitch: 60, velocity: 64, on: true, time: at(0) })
    r.note({ trackId: 't1', pitch: 64, velocity: 64, on: true, time: at(0.5) })
    r.note({ trackId: 't1', pitch: 60, velocity: 100, on: true, time: at(1) })
    r.note({ trackId: 't1', pitch: 64, on: false, time: at(1.25) })
    r.note({ trackId: 't1', pitch: 60, on: false, time: at(2) })
    const notes = r.finish(at(3))[0].clip.notes.map(x => [x.pitch, +x.startBeat.toFixed(6), +x.duration.toFixed(6)])
    expect(notes).toEqual([[60, 0, 1], [64, 0.5, 0.75], [60, 1, 1]])
  })

  it('closes hanging notes at endTime and floors tiny notes to 1/64 beat', () => {
    const r = rec()
    r.note({ trackId: 't1', pitch: 60, velocity: 90, on: true, time: at(3) })
    r.note({ trackId: 't1', pitch: 62, velocity: 90, on: true, time: at(1) })
    r.note({ trackId: 't1', pitch: 62, on: false, time: at(1) })
    const { clip } = r.finish(at(5.5))[0]
    expect(clip.duration).toBe(8)   // runs past bar 1 -> two bars
    const hanging = clip.notes.find(x => x.pitch === 60)
    expect(hanging.duration).toBeCloseTo(2.5, 9)
    expect(clip.notes.find(x => x.pitch === 62).duration).toBe(1 / 64)
  })

  it('count-in notes: held across the start clamp to it, released before it drop', () => {
    const r = rec()
    r.note({ trackId: 't1', pitch: 60, velocity: 90, on: true, time: S - 1 })
    r.note({ trackId: 't1', pitch: 60, on: false, time: S - 0.5 })
    r.note({ trackId: 't1', pitch: 62, velocity: 90, on: true, time: S - 0.2 })
    r.note({ trackId: 't1', pitch: 62, on: false, time: at(1) })
    const { clip } = r.finish(at(2))[0]
    expect(clip.notes).toHaveLength(1)
    expect(clip.notes[0]).toMatchObject({ pitch: 62, startBeat: 0 })
    expect(clip.notes[0].duration).toBeCloseTo(1, 9)
  })

  it('one clip per track that received notes; stray offs are ignored', () => {
    const r = rec()
    r.note({ trackId: 'a', pitch: 60, velocity: 90, on: true, time: at(5) })
    r.note({ trackId: 'b', pitch: 36, velocity: 90, on: true, time: at(0.25) })
    r.note({ trackId: 'b', pitch: 36, on: false, time: at(0.5) })
    r.note({ trackId: 'c', pitch: 40, on: false, time: at(1) })
    const take = r.finish(at(6))
    const byTrack = Object.fromEntries(take.map(t => [t.trackId, t.clip]))
    expect(Object.keys(byTrack).sort()).toEqual(['a', 'b'])
    expect(byTrack.a.startBeat).toBe(12)   // first note at beat 13 -> bar starting at 12
    expect(byTrack.b.startBeat).toBe(8)
  })

  it('round trip: timeline-player math puts recorded notes back at their audio times (<1 ms)', () => {
    const r = rec()
    const played = [[60, at(0.37), at(1.9)], [67, at(2.13), at(2.2)], [72, at(6.01), at(7.5)]]
    for (const [pitch, on, off] of played) {
      r.note({ trackId: 't1', pitch, velocity: 100, on: true, time: on })
      r.note({ trackId: 't1', pitch, on: false, time: off })
    }
    const { clip } = r.finish(at(8))[0]
    const playBeat = 8
    for (const [pitch, on, off] of played) {
      const note = clip.notes.find(x => x.pitch === pitch)
      // timeline-player.js: noteAudioTime = start + beatsToSeconds(clip.startBeat + note.startBeat - beat, bpm)
      const audio = S + beatsToSeconds(clip.startBeat + note.startBeat - playBeat, bpm)
      const stop = audio + beatsToSeconds(note.duration, bpm)
      expect(Math.abs(audio - on)).toBeLessThan(0.001)
      expect(Math.abs(stop - off)).toBeLessThan(0.001)
    }
  })
})
