import { describe, it, expect, beforeEach } from 'vitest'
import ProjectStore, {
  AddTrack,
  AddEffect,
  RemoveEffect,
  SetEffectParam
} from '../src/renderer/js/store/ProjectStore.js'

describe('Store effect commands', () => {
  beforeEach(() => {
    ProjectStore.reset()
    // Add a track to work with
    ProjectStore.dispatch(AddTrack('audio', 'Test Track'))
  })

  function getTrack() {
    return ProjectStore.getState().tracks[0]
  }

  // ─── AddEffect ────────────────────────────────────────────────────────────

  describe('AddEffect', () => {
    it('adds an effect to the track effects array', () => {
      const trackId = getTrack().id
      ProjectStore.dispatch(AddEffect(trackId, 'eq3', {}))
      expect(getTrack().effects.length).toBe(1)
    })

    it('effect has an auto-generated id string', () => {
      const trackId = getTrack().id
      ProjectStore.dispatch(AddEffect(trackId, 'eq3', {}))
      const effect = getTrack().effects[0]
      expect(effect.id).toBeDefined()
      expect(typeof effect.id).toBe('string')
    })

    it('effect has the correct type', () => {
      const trackId = getTrack().id
      ProjectStore.dispatch(AddEffect(trackId, 'compressor', {}))
      expect(getTrack().effects[0].type).toBe('compressor')
    })

    it('effect stores the supplied params', () => {
      const trackId = getTrack().id
      const params = { lowGain: 3, midGain: -1, highGain: 6 }
      ProjectStore.dispatch(AddEffect(trackId, 'eq3', params))
      expect(getTrack().effects[0].params).toMatchObject(params)
    })

    it('multiple AddEffect calls append to the effects array', () => {
      const trackId = getTrack().id
      ProjectStore.dispatch(AddEffect(trackId, 'eq3', {}))
      ProjectStore.dispatch(AddEffect(trackId, 'compressor', {}))
      ProjectStore.dispatch(AddEffect(trackId, 'gain', { gain: 0.5 }))
      expect(getTrack().effects.length).toBe(3)
    })

    it('does nothing if the trackId is unknown', () => {
      ProjectStore.dispatch(AddEffect('nonexistent-track', 'eq3', {}))
      expect(getTrack().effects.length).toBe(0)
    })

    it('new track always starts with empty effects array', () => {
      expect(getTrack().effects).toEqual([])
    })
  })

  // ─── RemoveEffect ─────────────────────────────────────────────────────────

  describe('RemoveEffect', () => {
    it('removes the specified effect from the track', () => {
      const trackId = getTrack().id
      ProjectStore.dispatch(AddEffect(trackId, 'gain', {}))
      const effectId = getTrack().effects[0].id
      ProjectStore.dispatch(RemoveEffect(trackId, effectId))
      expect(getTrack().effects.length).toBe(0)
    })

    it('removes only the targeted effect when multiple exist', () => {
      const trackId = getTrack().id
      ProjectStore.dispatch(AddEffect(trackId, 'eq3', {}))
      ProjectStore.dispatch(AddEffect(trackId, 'gain', {}))
      const firstEffectId = getTrack().effects[0].id
      ProjectStore.dispatch(RemoveEffect(trackId, firstEffectId))
      expect(getTrack().effects.length).toBe(1)
      expect(getTrack().effects[0].type).toBe('gain')
    })

    it('does nothing if effectId is unknown', () => {
      const trackId = getTrack().id
      ProjectStore.dispatch(AddEffect(trackId, 'gain', {}))
      ProjectStore.dispatch(RemoveEffect(trackId, 'nonexistent-effect'))
      expect(getTrack().effects.length).toBe(1)
    })

    it('does nothing if trackId is unknown', () => {
      expect(() => ProjectStore.dispatch(RemoveEffect('nonexistent-track', 'some-effect'))).not.toThrow()
    })
  })

  // ─── SetEffectParam ───────────────────────────────────────────────────────

  describe('SetEffectParam', () => {
    it('updates a param value on the correct effect', () => {
      const trackId = getTrack().id
      ProjectStore.dispatch(AddEffect(trackId, 'eq3', { lowGain: 0 }))
      const effectId = getTrack().effects[0].id
      ProjectStore.dispatch(SetEffectParam(trackId, effectId, 'lowGain', 6))
      expect(getTrack().effects[0].params.lowGain).toBe(6)
    })

    it('only updates the specified param, leaving others intact', () => {
      const trackId = getTrack().id
      ProjectStore.dispatch(AddEffect(trackId, 'eq3', { lowGain: 0, midGain: 2, highGain: -3 }))
      const effectId = getTrack().effects[0].id
      ProjectStore.dispatch(SetEffectParam(trackId, effectId, 'midGain', 5))
      const params = getTrack().effects[0].params
      expect(params.lowGain).toBe(0)
      expect(params.midGain).toBe(5)
      expect(params.highGain).toBe(-3)
    })

    it('does nothing if effectId is unknown', () => {
      const trackId = getTrack().id
      ProjectStore.dispatch(AddEffect(trackId, 'gain', { gain: 1 }))
      ProjectStore.dispatch(SetEffectParam(trackId, 'nonexistent-effect', 'gain', 2))
      expect(getTrack().effects[0].params.gain).toBe(1)
    })

    it('does nothing if trackId is unknown', () => {
      expect(() => ProjectStore.dispatch(SetEffectParam('nonexistent-track', 'eid', 'gain', 2))).not.toThrow()
    })
  })

  // ─── Undo / Redo ──────────────────────────────────────────────────────────

  describe('undo/redo for AddEffect', () => {
    it('undo reverts AddEffect', () => {
      const trackId = getTrack().id
      ProjectStore.dispatch(AddEffect(trackId, 'gain', {}))
      expect(getTrack().effects.length).toBe(1)
      ProjectStore.undo()
      expect(getTrack().effects.length).toBe(0)
    })

    it('redo re-applies AddEffect after undo', () => {
      const trackId = getTrack().id
      ProjectStore.dispatch(AddEffect(trackId, 'gain', {}))
      ProjectStore.undo()
      ProjectStore.redo()
      expect(getTrack().effects.length).toBe(1)
    })
  })

  describe('undo/redo for RemoveEffect', () => {
    it('undo reverts RemoveEffect (effect comes back)', () => {
      const trackId = getTrack().id
      ProjectStore.dispatch(AddEffect(trackId, 'gain', {}))
      const effectId = getTrack().effects[0].id
      ProjectStore.dispatch(RemoveEffect(trackId, effectId))
      expect(getTrack().effects.length).toBe(0)
      ProjectStore.undo()
      expect(getTrack().effects.length).toBe(1)
    })

    it('redo re-applies RemoveEffect after undo', () => {
      const trackId = getTrack().id
      ProjectStore.dispatch(AddEffect(trackId, 'gain', {}))
      const effectId = getTrack().effects[0].id
      ProjectStore.dispatch(RemoveEffect(trackId, effectId))
      ProjectStore.undo()
      ProjectStore.redo()
      expect(getTrack().effects.length).toBe(0)
    })
  })

  describe('undo/redo for SetEffectParam', () => {
    it('undo reverts SetEffectParam to previous value', () => {
      const trackId = getTrack().id
      ProjectStore.dispatch(AddEffect(trackId, 'eq3', { lowGain: 0 }))
      const effectId = getTrack().effects[0].id
      ProjectStore.dispatch(SetEffectParam(trackId, effectId, 'lowGain', 6))
      expect(getTrack().effects[0].params.lowGain).toBe(6)
      ProjectStore.undo()
      expect(getTrack().effects[0].params.lowGain).toBe(0)
    })

    it('redo re-applies SetEffectParam after undo', () => {
      const trackId = getTrack().id
      ProjectStore.dispatch(AddEffect(trackId, 'compressor', { threshold: -24 }))
      const effectId = getTrack().effects[0].id
      ProjectStore.dispatch(SetEffectParam(trackId, effectId, 'threshold', -12))
      ProjectStore.undo()
      ProjectStore.redo()
      expect(getTrack().effects[0].params.threshold).toBe(-12)
    })
  })
})
