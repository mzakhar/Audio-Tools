import { describe, it, expect, beforeEach } from 'vitest'
import { validateProjectPath } from '../src/renderer/js/io/FileAdapter.js'
import ProjectStore, { AddTrack, AddClip, DEFAULT_STATE } from '../src/renderer/js/store/ProjectStore.js'

describe('Serialization', () => {
  beforeEach(() => {
    ProjectStore.reset()
  })

  // ─── validateProjectPath — safe paths ─────────────────────────────────────

  describe('validateProjectPath — safe paths', () => {
    it('allows a simple relative path inside the project', () => {
      expect(validateProjectPath('/project', 'audio/sample.wav')).toBe(true)
    })

    it('allows a nested path inside the project', () => {
      expect(validateProjectPath('/project', 'audio/sub/file.flac')).toBe(true)
    })

    it('allows a file directly in the project root', () => {
      expect(validateProjectPath('/project', 'project.json')).toBe(true)
    })

    it('allows a deeper nesting', () => {
      expect(validateProjectPath('/project', 'audio/sub/deep/track.wav')).toBe(true)
    })
  })

  // ─── validateProjectPath — traversal attempts ─────────────────────────────

  describe('validateProjectPath — traversal attempts', () => {
    it('rejects a path with leading traversal', () => {
      expect(validateProjectPath('/project', '../other/file.wav')).toBe(false)
    })

    it('rejects a path with embedded traversal', () => {
      expect(validateProjectPath('/project', 'audio/../../etc/passwd')).toBe(false)
    })

    it('rejects an empty path', () => {
      expect(validateProjectPath('/project', '')).toBe(false)
    })

    it('rejects an absolute path that escapes the project root', () => {
      expect(validateProjectPath('/project', '/etc/passwd')).toBe(false)
    })

    it('rejects a Windows-style traversal', () => {
      expect(validateProjectPath('/project', '..\\other\\file.wav')).toBe(false)
    })
  })

  // ─── Round-trip serialization ─────────────────────────────────────────────

  describe('round-trip serialization', () => {
    it('serializes and deserializes a project with tracks', () => {
      ProjectStore.dispatch(AddTrack('audio', 'My Track'))
      const state = ProjectStore.getState()
      const serialized = JSON.stringify(state)
      const parsed = JSON.parse(serialized)
      expect(parsed.tracks.length).toBe(1)
      expect(parsed.tracks[0].name).toBe('My Track')
      expect(parsed.bpm).toBe(120)
    })

    it('preserves mixer channels in round-trip', () => {
      ProjectStore.dispatch(AddTrack('audio', 'My Track'))
      const state = ProjectStore.getState()
      const parsed = JSON.parse(JSON.stringify(state))
      expect(parsed.mixer.channels.length).toBe(1)
    })

    it('preserves clip data in round-trip', () => {
      ProjectStore.dispatch(AddTrack('audio', 'My Track'))
      const trackId = ProjectStore.getState().tracks[0].id
      const clip = { id: 'clip1', startBeat: 4, duration: 8, path: 'audio/sample.wav' }
      ProjectStore.dispatch(AddClip(trackId, clip))
      const parsed = JSON.parse(JSON.stringify(ProjectStore.getState()))
      expect(parsed.tracks[0].clips.length).toBe(1)
      expect(parsed.tracks[0].clips[0].startBeat).toBe(4)
    })

    it('preserves BPM in round-trip', () => {
      const state = ProjectStore.getState()
      const parsed = JSON.parse(JSON.stringify(state))
      expect(parsed.bpm).toBe(DEFAULT_STATE.bpm)
    })

    it('serialized JSON is valid and parseable', () => {
      ProjectStore.dispatch(AddTrack('audio', 'Track 1'))
      ProjectStore.dispatch(AddTrack('midi', 'Track 2'))
      const state = ProjectStore.getState()
      expect(() => JSON.parse(JSON.stringify(state))).not.toThrow()
    })
  })

  // ─── Version field ────────────────────────────────────────────────────────

  describe('version field', () => {
    it('DEFAULT_STATE has version: 1', () => {
      expect(DEFAULT_STATE.version).toBe(1)
    })

    it('serialized state preserves version field', () => {
      const parsed = JSON.parse(JSON.stringify(ProjectStore.getState()))
      expect(parsed.version).toBe(1)
    })
  })

  // ─── Schema completeness ──────────────────────────────────────────────────

  describe('schema completeness', () => {
    it('DEFAULT_STATE has version field', () => {
      expect(DEFAULT_STATE).toHaveProperty('version')
    })

    it('DEFAULT_STATE has bpm field', () => {
      expect(DEFAULT_STATE).toHaveProperty('bpm')
    })

    it('DEFAULT_STATE has timeSignature field', () => {
      expect(DEFAULT_STATE).toHaveProperty('timeSignature')
    })

    it('DEFAULT_STATE has sampleRate field', () => {
      expect(DEFAULT_STATE).toHaveProperty('sampleRate')
    })

    it('DEFAULT_STATE has tracks field', () => {
      expect(DEFAULT_STATE).toHaveProperty('tracks')
    })

    it('DEFAULT_STATE has mixer field', () => {
      expect(DEFAULT_STATE).toHaveProperty('mixer')
    })

    it('DEFAULT_STATE has patterns field', () => {
      expect(DEFAULT_STATE).toHaveProperty('patterns')
    })

    it('DEFAULT_STATE timeSignature is an array', () => {
      expect(Array.isArray(DEFAULT_STATE.timeSignature)).toBe(true)
      expect(DEFAULT_STATE.timeSignature.length).toBe(2)
    })

    it('DEFAULT_STATE sampleRate is a positive number', () => {
      expect(typeof DEFAULT_STATE.sampleRate).toBe('number')
      expect(DEFAULT_STATE.sampleRate).toBeGreaterThan(0)
    })
  })
})
