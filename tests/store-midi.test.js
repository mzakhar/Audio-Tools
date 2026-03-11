/**
 * Tests for MIDI note commands in ProjectStore.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import ProjectStore, {
  AddTrack, AddClip,
  AddMidiNote, RemoveMidiNote, MoveMidiNote, ResizeMidiNote, SetMidiNoteVelocity
} from '../src/renderer/js/store/ProjectStore.js'

function makeNote(overrides = {}) {
  return { id: 'n1', pitch: 60, startBeat: 0, duration: 0.5, velocity: 0.8, ...overrides }
}

function addMidiTrackAndClip() {
  ProjectStore.dispatch(AddTrack('midi', 'MIDI'))
  const s1 = ProjectStore.getState()
  const track = s1.tracks[s1.tracks.length - 1]
  ProjectStore.dispatch(AddClip(track.id, {
    id: 'c1', type: 'midi', startBeat: 0, duration: 4, notes: []
  }))
  return { trackId: track.id, clipId: 'c1' }
}

beforeEach(() => ProjectStore.reset())

describe('AddMidiNote', () => {
  it('adds a note to the clip', () => {
    const { trackId, clipId } = addMidiTrackAndClip()
    ProjectStore.dispatch(AddMidiNote(trackId, clipId, makeNote()))
    const clip = ProjectStore.getState().tracks[0].clips[0]
    expect(clip.notes).toHaveLength(1)
    expect(clip.notes[0].pitch).toBe(60)
  })

  it('appends multiple notes', () => {
    const { trackId, clipId } = addMidiTrackAndClip()
    ProjectStore.dispatch(AddMidiNote(trackId, clipId, makeNote({ id: 'n1', pitch: 60 })))
    ProjectStore.dispatch(AddMidiNote(trackId, clipId, makeNote({ id: 'n2', pitch: 64 })))
    expect(ProjectStore.getState().tracks[0].clips[0].notes).toHaveLength(2)
  })

  it('no-ops for missing track', () => {
    ProjectStore.dispatch(AddMidiNote('no-track', 'c1', makeNote()))
    expect(ProjectStore.getState().tracks).toHaveLength(0)
  })
})

describe('RemoveMidiNote', () => {
  it('removes a note by id', () => {
    const { trackId, clipId } = addMidiTrackAndClip()
    ProjectStore.dispatch(AddMidiNote(trackId, clipId, makeNote({ id: 'n1' })))
    ProjectStore.dispatch(AddMidiNote(trackId, clipId, makeNote({ id: 'n2', pitch: 64 })))
    ProjectStore.dispatch(RemoveMidiNote(trackId, clipId, 'n1'))
    const notes = ProjectStore.getState().tracks[0].clips[0].notes
    expect(notes).toHaveLength(1)
    expect(notes[0].id).toBe('n2')
  })

  it('no-ops for missing note id', () => {
    const { trackId, clipId } = addMidiTrackAndClip()
    ProjectStore.dispatch(AddMidiNote(trackId, clipId, makeNote()))
    ProjectStore.dispatch(RemoveMidiNote(trackId, clipId, 'ghost'))
    expect(ProjectStore.getState().tracks[0].clips[0].notes).toHaveLength(1)
  })
})

describe('MoveMidiNote', () => {
  it('updates startBeat and pitch', () => {
    const { trackId, clipId } = addMidiTrackAndClip()
    ProjectStore.dispatch(AddMidiNote(trackId, clipId, makeNote({ id: 'n1', startBeat: 0, pitch: 60 })))
    ProjectStore.dispatch(MoveMidiNote(trackId, clipId, 'n1', 2, 64))
    const note = ProjectStore.getState().tracks[0].clips[0].notes[0]
    expect(note.startBeat).toBe(2)
    expect(note.pitch).toBe(64)
  })
})

describe('ResizeMidiNote', () => {
  it('updates duration', () => {
    const { trackId, clipId } = addMidiTrackAndClip()
    ProjectStore.dispatch(AddMidiNote(trackId, clipId, makeNote({ id: 'n1', duration: 0.5 })))
    ProjectStore.dispatch(ResizeMidiNote(trackId, clipId, 'n1', 2))
    expect(ProjectStore.getState().tracks[0].clips[0].notes[0].duration).toBe(2)
  })

  it('clamps to minimum duration', () => {
    const { trackId, clipId } = addMidiTrackAndClip()
    ProjectStore.dispatch(AddMidiNote(trackId, clipId, makeNote({ id: 'n1' })))
    ProjectStore.dispatch(ResizeMidiNote(trackId, clipId, 'n1', 0))
    expect(ProjectStore.getState().tracks[0].clips[0].notes[0].duration).toBe(0.0625)
  })
})

describe('SetMidiNoteVelocity', () => {
  it('updates velocity', () => {
    const { trackId, clipId } = addMidiTrackAndClip()
    ProjectStore.dispatch(AddMidiNote(trackId, clipId, makeNote({ id: 'n1', velocity: 0.8 })))
    ProjectStore.dispatch(SetMidiNoteVelocity(trackId, clipId, 'n1', 0.5))
    expect(ProjectStore.getState().tracks[0].clips[0].notes[0].velocity).toBe(0.5)
  })

  it('clamps velocity to [0.01, 1]', () => {
    const { trackId, clipId } = addMidiTrackAndClip()
    ProjectStore.dispatch(AddMidiNote(trackId, clipId, makeNote({ id: 'n1' })))
    ProjectStore.dispatch(SetMidiNoteVelocity(trackId, clipId, 'n1', 1.5))
    expect(ProjectStore.getState().tracks[0].clips[0].notes[0].velocity).toBe(1)
    ProjectStore.dispatch(SetMidiNoteVelocity(trackId, clipId, 'n1', -0.5))
    expect(ProjectStore.getState().tracks[0].clips[0].notes[0].velocity).toBe(0.01)
  })
})

describe('undo/redo with MIDI commands', () => {
  it('can undo AddMidiNote', () => {
    const { trackId, clipId } = addMidiTrackAndClip()
    ProjectStore.dispatch(AddMidiNote(trackId, clipId, makeNote()))
    expect(ProjectStore.getState().tracks[0].clips[0].notes).toHaveLength(1)
    ProjectStore.undo()
    expect(ProjectStore.getState().tracks[0].clips[0].notes).toHaveLength(0)
  })
})
