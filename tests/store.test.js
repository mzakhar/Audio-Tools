import { describe, it, expect, beforeEach, vi } from 'vitest'
import ProjectStore, {
  AddTrack,
  RemoveTrack,
  AddClip,
  MoveClip,
  TrimClip,
  SetMixerParam,
  DEFAULT_STATE
} from '../src/renderer/js/store/ProjectStore.js'

describe('ProjectStore', () => {
  beforeEach(() => {
    ProjectStore.reset()
  })

  // ─── Initial state ────────────────────────────────────────────────────────

  describe('initial state', () => {
    it('matches DEFAULT_STATE schema with required fields', () => {
      const state = ProjectStore.getState()
      expect(state).toHaveProperty('bpm')
      expect(state).toHaveProperty('tracks')
      expect(state).toHaveProperty('mixer')
      expect(state).toHaveProperty('patterns')
    })

    it('has default BPM of 120', () => {
      expect(ProjectStore.getState().bpm).toBe(120)
    })

    it('starts with empty tracks array', () => {
      expect(ProjectStore.getState().tracks).toEqual([])
    })

    it('starts with empty mixer channels array', () => {
      expect(ProjectStore.getState().mixer.channels).toEqual([])
    })
  })

  // ─── AddTrack ─────────────────────────────────────────────────────────────

  describe('AddTrack', () => {
    it('adds a track to the tracks array', () => {
      ProjectStore.dispatch(AddTrack('audio', 'My Track'))
      expect(ProjectStore.getState().tracks.length).toBe(1)
    })

    it('new track has auto-generated id', () => {
      ProjectStore.dispatch(AddTrack('audio', 'My Track'))
      const track = ProjectStore.getState().tracks[0]
      expect(track.id).toBeDefined()
      expect(typeof track.id).toBe('string')
    })

    it('new track has correct name', () => {
      ProjectStore.dispatch(AddTrack('audio', 'My Track'))
      expect(ProjectStore.getState().tracks[0].name).toBe('My Track')
    })

    it('new track has correct type', () => {
      ProjectStore.dispatch(AddTrack('audio', 'My Track'))
      expect(ProjectStore.getState().tracks[0].type).toBe('audio')
    })

    it('new track has empty clips array', () => {
      ProjectStore.dispatch(AddTrack('audio', 'My Track'))
      expect(ProjectStore.getState().tracks[0].clips).toEqual([])
    })

    it('adds a mixer channel for the new track', () => {
      ProjectStore.dispatch(AddTrack('audio', 'My Track'))
      expect(ProjectStore.getState().mixer.channels.length).toBe(1)
    })

    it('mixer channel id matches track id', () => {
      ProjectStore.dispatch(AddTrack('audio', 'My Track'))
      const track = ProjectStore.getState().tracks[0]
      const channel = ProjectStore.getState().mixer.channels[0]
      expect(channel.id).toBe(track.id)
    })

    it('multiple AddTrack calls append tracks', () => {
      ProjectStore.dispatch(AddTrack('audio', 'Track 1'))
      ProjectStore.dispatch(AddTrack('midi', 'Track 2'))
      ProjectStore.dispatch(AddTrack('audio', 'Track 3'))
      expect(ProjectStore.getState().tracks.length).toBe(3)
    })
  })

  // ─── RemoveTrack ──────────────────────────────────────────────────────────

  describe('RemoveTrack', () => {
    it('removes the track after AddTrack + RemoveTrack', () => {
      ProjectStore.dispatch(AddTrack('audio', 'My Track'))
      const trackId = ProjectStore.getState().tracks[0].id
      ProjectStore.dispatch(RemoveTrack(trackId))
      expect(ProjectStore.getState().tracks.length).toBe(0)
    })

    it('removes the corresponding mixer channel', () => {
      ProjectStore.dispatch(AddTrack('audio', 'My Track'))
      const trackId = ProjectStore.getState().tracks[0].id
      ProjectStore.dispatch(RemoveTrack(trackId))
      expect(ProjectStore.getState().mixer.channels.length).toBe(0)
    })

    it('removes only the targeted track', () => {
      ProjectStore.dispatch(AddTrack('audio', 'Track 1'))
      ProjectStore.dispatch(AddTrack('audio', 'Track 2'))
      const firstId = ProjectStore.getState().tracks[0].id
      ProjectStore.dispatch(RemoveTrack(firstId))
      expect(ProjectStore.getState().tracks.length).toBe(1)
      expect(ProjectStore.getState().tracks[0].name).toBe('Track 2')
    })
  })

  // ─── AddClip ──────────────────────────────────────────────────────────────

  describe('AddClip', () => {
    it('adds a clip to the specified track', () => {
      ProjectStore.dispatch(AddTrack('audio', 'My Track'))
      const trackId = ProjectStore.getState().tracks[0].id
      const clip = { id: 'clip1', startBeat: 0, duration: 4, path: 'audio/sample.wav' }
      ProjectStore.dispatch(AddClip(trackId, clip))
      expect(ProjectStore.getState().tracks[0].clips.length).toBe(1)
    })

    it('clip appears with correct properties', () => {
      ProjectStore.dispatch(AddTrack('audio', 'My Track'))
      const trackId = ProjectStore.getState().tracks[0].id
      const clip = { id: 'clip1', startBeat: 0, duration: 4, path: 'audio/sample.wav' }
      ProjectStore.dispatch(AddClip(trackId, clip))
      const storedClip = ProjectStore.getState().tracks[0].clips[0]
      expect(storedClip.startBeat).toBe(0)
      expect(storedClip.duration).toBe(4)
    })
  })

  // ─── MoveClip ─────────────────────────────────────────────────────────────

  describe('MoveClip', () => {
    it('updates clip startBeat after MoveClip', () => {
      ProjectStore.dispatch(AddTrack('audio', 'My Track'))
      const trackId = ProjectStore.getState().tracks[0].id
      const clip = { id: 'clip1', startBeat: 0, duration: 4, path: 'audio/sample.wav' }
      ProjectStore.dispatch(AddClip(trackId, clip))
      ProjectStore.dispatch(MoveClip(trackId, 'clip1', 8))
      const movedClip = ProjectStore.getState().tracks[0].clips[0]
      expect(movedClip.startBeat).toBe(8)
    })
  })

  // ─── TrimClip ─────────────────────────────────────────────────────────────

  describe('TrimClip', () => {
    it('updates clip duration after TrimClip', () => {
      ProjectStore.dispatch(AddTrack('audio', 'My Track'))
      const trackId = ProjectStore.getState().tracks[0].id
      const clip = { id: 'clip1', startBeat: 0, duration: 8, path: 'audio/sample.wav' }
      ProjectStore.dispatch(AddClip(trackId, clip))
      ProjectStore.dispatch(TrimClip(trackId, 'clip1', { duration: 4 }))
      const trimmedClip = ProjectStore.getState().tracks[0].clips[0]
      expect(trimmedClip.duration).toBe(4)
    })
  })

  // ─── SetMixerParam ────────────────────────────────────────────────────────

  describe('SetMixerParam', () => {
    it('updates volume on the mixer channel', () => {
      ProjectStore.dispatch(AddTrack('audio', 'My Track'))
      const channelId = ProjectStore.getState().mixer.channels[0].id
      ProjectStore.dispatch(SetMixerParam(channelId, 'volume', 0.5))
      const channel = ProjectStore.getState().mixer.channels[0]
      expect(channel.volume).toBe(0.5)
    })

    it('updates pan on the mixer channel', () => {
      ProjectStore.dispatch(AddTrack('audio', 'My Track'))
      const channelId = ProjectStore.getState().mixer.channels[0].id
      ProjectStore.dispatch(SetMixerParam(channelId, 'pan', -0.3))
      const channel = ProjectStore.getState().mixer.channels[0]
      expect(channel.pan).toBe(-0.3)
    })
  })

  // ─── Undo ─────────────────────────────────────────────────────────────────

  describe('undo', () => {
    it('reverts AddTrack after undo()', () => {
      ProjectStore.dispatch(AddTrack('audio', 'My Track'))
      ProjectStore.undo()
      expect(ProjectStore.getState().tracks.length).toBe(0)
    })

    it('does nothing when there is nothing to undo', () => {
      expect(() => ProjectStore.undo()).not.toThrow()
      expect(ProjectStore.getState().tracks.length).toBe(0)
    })
  })

  // ─── Redo ─────────────────────────────────────────────────────────────────

  describe('redo', () => {
    it('re-applies AddTrack after undo() + redo()', () => {
      ProjectStore.dispatch(AddTrack('audio', 'My Track'))
      ProjectStore.undo()
      ProjectStore.redo()
      expect(ProjectStore.getState().tracks.length).toBe(1)
    })

    it('does nothing when there is nothing to redo', () => {
      ProjectStore.dispatch(AddTrack('audio', 'My Track'))
      expect(() => ProjectStore.redo()).not.toThrow()
    })

    it('redo is cleared after a new dispatch following undo', () => {
      ProjectStore.dispatch(AddTrack('audio', 'Track 1'))
      ProjectStore.undo()
      ProjectStore.dispatch(AddTrack('audio', 'Track 2'))
      ProjectStore.redo() // should be a no-op
      // Only Track 2 should be present, not Track 1 redone
      expect(ProjectStore.getState().tracks.length).toBe(1)
      expect(ProjectStore.getState().tracks[0].name).toBe('Track 2')
    })
  })

  // ─── Multi-step undo ──────────────────────────────────────────────────────

  describe('multi-step undo', () => {
    it('undoing twice after 3 AddTrack leaves 1 track', () => {
      ProjectStore.dispatch(AddTrack('audio', 'Track 1'))
      ProjectStore.dispatch(AddTrack('audio', 'Track 2'))
      ProjectStore.dispatch(AddTrack('audio', 'Track 3'))
      ProjectStore.undo()
      ProjectStore.undo()
      expect(ProjectStore.getState().tracks.length).toBe(1)
    })
  })

  // ─── History cap ─────────────────────────────────────────────────────────

  describe('history cap', () => {
    it('undoStack never exceeds 100 entries after 110 dispatches', () => {
      for (let i = 0; i < 110; i++) {
        ProjectStore.dispatch(AddTrack('audio', `Track ${i}`))
      }
      expect(ProjectStore.getUndoStackSize()).toBeLessThanOrEqual(100)
    })
  })

  // ─── canUndo / canRedo ────────────────────────────────────────────────────

  describe('canUndo / canRedo', () => {
    it('canUndo is false on fresh store', () => {
      expect(ProjectStore.canUndo()).toBe(false)
    })

    it('canRedo is false on fresh store', () => {
      expect(ProjectStore.canRedo()).toBe(false)
    })

    it('canUndo is true after dispatch', () => {
      ProjectStore.dispatch(AddTrack('audio', 'My Track'))
      expect(ProjectStore.canUndo()).toBe(true)
    })

    it('canRedo is false after dispatch (no undo yet)', () => {
      ProjectStore.dispatch(AddTrack('audio', 'My Track'))
      expect(ProjectStore.canRedo()).toBe(false)
    })

    it('canUndo is false and canRedo is true after dispatch + undo', () => {
      ProjectStore.dispatch(AddTrack('audio', 'My Track'))
      ProjectStore.undo()
      expect(ProjectStore.canUndo()).toBe(false)
      expect(ProjectStore.canRedo()).toBe(true)
    })

    it('canRedo is false after undo + redo', () => {
      ProjectStore.dispatch(AddTrack('audio', 'My Track'))
      ProjectStore.undo()
      ProjectStore.redo()
      expect(ProjectStore.canRedo()).toBe(false)
    })
  })

  // ─── subscribe ────────────────────────────────────────────────────────────

  describe('subscribe', () => {
    it('listener is called when dispatch is made', () => {
      const listener = vi.fn()
      ProjectStore.subscribe(listener)
      ProjectStore.dispatch(AddTrack('audio', 'My Track'))
      expect(listener).toHaveBeenCalledOnce()
    })

    it('listener receives new state on dispatch', () => {
      let receivedState = null
      ProjectStore.subscribe((state) => { receivedState = state })
      ProjectStore.dispatch(AddTrack('audio', 'My Track'))
      expect(receivedState).not.toBeNull()
      expect(receivedState.tracks.length).toBe(1)
    })

    it('unsubscribe function stops further notifications', () => {
      const listener = vi.fn()
      const unsubscribe = ProjectStore.subscribe(listener)
      ProjectStore.dispatch(AddTrack('audio', 'Track 1'))
      unsubscribe()
      ProjectStore.dispatch(AddTrack('audio', 'Track 2'))
      // Listener should only have been called once (before unsubscribe)
      expect(listener).toHaveBeenCalledOnce()
    })

    it('multiple listeners can subscribe independently', () => {
      const listenerA = vi.fn()
      const listenerB = vi.fn()
      ProjectStore.subscribe(listenerA)
      ProjectStore.subscribe(listenerB)
      ProjectStore.dispatch(AddTrack('audio', 'My Track'))
      expect(listenerA).toHaveBeenCalledOnce()
      expect(listenerB).toHaveBeenCalledOnce()
    })
  })

  // ─── load ─────────────────────────────────────────────────────────────────

  describe('load', () => {
    it('replaces state with loaded data', () => {
      const loadedState = {
        bpm: 140,
        tracks: [],
        mixer: { channels: [], master: { volume: 1 } },
        patterns: {},
        version: 1,
        timeSignature: [4, 4],
        sampleRate: 44100
      }
      ProjectStore.load(loadedState)
      expect(ProjectStore.getState().bpm).toBe(140)
    })

    it('clears undo history after load', () => {
      ProjectStore.dispatch(AddTrack('audio', 'My Track'))
      const loadedState = {
        bpm: 140,
        tracks: [],
        mixer: { channels: [], master: { volume: 1 } },
        patterns: {},
        version: 1,
        timeSignature: [4, 4],
        sampleRate: 44100
      }
      ProjectStore.load(loadedState)
      expect(ProjectStore.canUndo()).toBe(false)
    })

    it('clears redo history after load', () => {
      ProjectStore.dispatch(AddTrack('audio', 'My Track'))
      ProjectStore.undo()
      const loadedState = {
        bpm: 140,
        tracks: [],
        mixer: { channels: [], master: { volume: 1 } },
        patterns: {},
        version: 1,
        timeSignature: [4, 4],
        sampleRate: 44100
      }
      ProjectStore.load(loadedState)
      expect(ProjectStore.canRedo()).toBe(false)
    })
  })

  // ─── reset ────────────────────────────────────────────────────────────────

  describe('reset', () => {
    it('returns to DEFAULT_STATE after dispatch + reset()', () => {
      ProjectStore.dispatch(AddTrack('audio', 'My Track'))
      ProjectStore.reset()
      expect(ProjectStore.getState().tracks.length).toBe(0)
      expect(ProjectStore.getState().bpm).toBe(DEFAULT_STATE.bpm)
    })

    it('clears undo history on reset', () => {
      ProjectStore.dispatch(AddTrack('audio', 'My Track'))
      ProjectStore.reset()
      expect(ProjectStore.canUndo()).toBe(false)
    })

    it('clears redo history on reset', () => {
      ProjectStore.dispatch(AddTrack('audio', 'My Track'))
      ProjectStore.undo()
      ProjectStore.reset()
      expect(ProjectStore.canRedo()).toBe(false)
    })
  })

  // ─── State immutability ───────────────────────────────────────────────────

  describe('state immutability', () => {
    it('getState() returns a different reference before and after dispatch', () => {
      const stateBefore = ProjectStore.getState()
      ProjectStore.dispatch(AddTrack('audio', 'My Track'))
      const stateAfter = ProjectStore.getState()
      expect(stateBefore).not.toBe(stateAfter)
    })

    it('tracks array reference changes after AddTrack', () => {
      const tracksBefore = ProjectStore.getState().tracks
      ProjectStore.dispatch(AddTrack('audio', 'My Track'))
      const tracksAfter = ProjectStore.getState().tracks
      expect(tracksBefore).not.toBe(tracksAfter)
    })

    it('mutating returned state does not affect store state', () => {
      ProjectStore.dispatch(AddTrack('audio', 'My Track'))
      const state = ProjectStore.getState()
      const originalLength = state.tracks.length
      state.tracks.push({ id: 'fake', name: 'Injected' })
      // Store should not be affected
      expect(ProjectStore.getState().tracks.length).toBe(originalLength)
    })
  })
})
