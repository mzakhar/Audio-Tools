import { describe, it, expect, beforeEach } from 'vitest'
import ProjectStore, { AddTrack } from '../src/renderer/js/store/ProjectStore.js'
import { createPadsSession, loopClipOf } from '../src/renderer/js/pads/pads-session.js'

let seq
let trackId
const track = () => ProjectStore.getState().tracks.find(t => t.id === trackId)
const make = () => createPadsSession({
  getTrack: id => ProjectStore.getState().tracks.find(t => t.id === id),
  dispatch: c => ProjectStore.dispatch(c),
  dispatchBatch: (c, l) => ProjectStore.dispatchBatch(c, l),
  undo: () => ProjectStore.undo(),
  newId: () => `n${++seq}`,
})
const opts = { loopBeats: 8, grid: 0.25, strength: 1, swing: 0.5 }
const dims = { loopBars: 2, beatsPerBar: 4 }
const hit = (s, pitch, beat) => s.hit(trackId, { pitch, velocity: 100, beat }, opts, dims)

beforeEach(() => {
  ProjectStore.reset()
  seq = 0
  ProjectStore.dispatch(AddTrack('midi', 'Pads'))
  trackId = ProjectStore.getState().tracks.at(-1).id
})

describe('pads session', () => {
  it('commit creates the loop clip once and later passes reuse it', () => {
    const s = make()
    hit(s, 36, 1)
    expect(s.commit(2, 4)).toBe(true)
    expect(track().clips.filter(c => c.loop)).toHaveLength(1)
    expect(loopClipOf(track())).toMatchObject({ duration: 8, startBeat: 0 })
    hit(s, 38, 2)
    s.commit(2, 4)
    expect(track().clips.filter(c => c.loop)).toHaveLength(1)
    expect(loopClipOf(track()).notes.map(n => n.pitch)).toEqual([36, 38])
  })

  it('a pass is exactly one undo step, including clip creation', () => {
    const s = make()
    hit(s, 36, 1); hit(s, 36, 2); hit(s, 38, 3)
    s.commit(2, 4)
    expect(loopClipOf(track()).notes).toHaveLength(3)
    ProjectStore.undo()
    expect(track().clips).toHaveLength(0)
  })

  it('an empty pass commits nothing', () => {
    const s = make()
    expect(s.commit(2, 4)).toBe(false)
    expect(track().clips).toHaveLength(0)
  })

  it('undo discards a non-empty pass first, then falls back to the store', () => {
    const s = make()
    hit(s, 36, 1)
    expect(s.undo()).toBe('discarded')
    expect(s.hasPass()).toBe(false)
    expect(s.commit(2, 4)).toBe(false)
    expect(s.undo()).toBe('undone')
    expect(ProjectStore.getState().tracks).toHaveLength(0)
  })

  it('notes() merges the open pass with the clip', () => {
    const s = make()
    hit(s, 36, 1)
    s.commit(2, 4)
    hit(s, 38, 2)
    expect(s.notes(trackId).map(n => n.pitch)).toEqual([36, 38])
  })

  it('wipe removes committed hits of the held pad in the window, and commit persists it', () => {
    const s = make()
    hit(s, 36, 1); hit(s, 38, 1); hit(s, 36, 5)
    s.commit(2, 4)
    s.wipe(trackId, { pitches: new Set([36]), fromBeat: 0, toBeat: 2, loopBeats: 8 }, dims)
    expect(s.notes(trackId).map(n => [n.pitch, n.startBeat])).toEqual([[38, 1], [36, 5]])
    s.commit(2, 4)
    expect(loopClipOf(track()).notes.map(n => n.pitch)).toEqual([38, 36])
  })

  it('wipe with no pitches clears every pad in the window', () => {
    const s = make()
    hit(s, 36, 1); hit(s, 38, 1.5)
    s.commit(2, 4)
    s.wipe(trackId, { pitches: null, fromBeat: 0, toBeat: 2, loopBeats: 8 }, dims)
    expect(s.notes(trackId)).toEqual([])
  })
})
