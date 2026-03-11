import { describe, it, expect, beforeEach } from 'vitest'
import ProjectStore, {
  AddTrack,
  SetSendLevel,
  SetBusReturn,
  DEFAULT_STATE,
} from '../src/renderer/js/store/ProjectStore.js'

describe('ProjectStore — buses', () => {
  beforeEach(() => {
    ProjectStore.reset()
  })

  // ─── DEFAULT_STATE ───────────────────────────────────────────────────────

  describe('DEFAULT_STATE', () => {
    it('has a buses array', () => {
      expect(Array.isArray(DEFAULT_STATE.buses)).toBe(true)
    })

    it('buses array has at least 2 entries', () => {
      expect(DEFAULT_STATE.buses.length).toBeGreaterThanOrEqual(2)
    })

    it('includes a reverb bus', () => {
      const reverb = DEFAULT_STATE.buses.find(b => b.id === 'reverb')
      expect(reverb).toBeDefined()
      expect(reverb.name).toBe('Reverb')
      expect(typeof reverb.returnLevel).toBe('number')
      expect(reverb.params).toBeDefined()
      expect(typeof reverb.params.decay).toBe('number')
    })

    it('includes a delay bus', () => {
      const delay = DEFAULT_STATE.buses.find(b => b.id === 'delay')
      expect(delay).toBeDefined()
      expect(delay.name).toBe('Delay')
      expect(typeof delay.returnLevel).toBe('number')
      expect(delay.params).toBeDefined()
      expect(typeof delay.params.time).toBe('number')
      expect(typeof delay.params.feedback).toBe('number')
    })

    it('state after reset includes buses', () => {
      const state = ProjectStore.getState()
      expect(Array.isArray(state.buses)).toBe(true)
      expect(state.buses.length).toBeGreaterThanOrEqual(2)
    })
  })

  // ─── AddTrack — sends ────────────────────────────────────────────────────

  describe('AddTrack creates channel with sends: {}', () => {
    it('mixer channel has a sends property after AddTrack', () => {
      ProjectStore.dispatch(AddTrack('audio', 'My Track'))
      const channel = ProjectStore.getState().mixer.channels[0]
      expect(channel).toHaveProperty('sends')
    })

    it('sends is an empty object on a new channel', () => {
      ProjectStore.dispatch(AddTrack('audio', 'My Track'))
      const channel = ProjectStore.getState().mixer.channels[0]
      expect(channel.sends).toEqual({})
    })

    it('all channels created by AddTrack have sends: {}', () => {
      ProjectStore.dispatch(AddTrack('audio', 'Track 1'))
      ProjectStore.dispatch(AddTrack('midi', 'Track 2'))
      const channels = ProjectStore.getState().mixer.channels
      channels.forEach(ch => {
        expect(ch.sends).toEqual({})
      })
    })
  })

  // ─── SetSendLevel ────────────────────────────────────────────────────────

  describe('SetSendLevel', () => {
    it('updates sends[busId] on the channel', () => {
      ProjectStore.dispatch(AddTrack('audio', 'My Track'))
      const channelId = ProjectStore.getState().mixer.channels[0].id
      ProjectStore.dispatch(SetSendLevel(channelId, 'reverb', 0.5))
      const channel = ProjectStore.getState().mixer.channels[0]
      expect(channel.sends['reverb']).toBe(0.5)
    })

    it('can set multiple sends independently', () => {
      ProjectStore.dispatch(AddTrack('audio', 'My Track'))
      const channelId = ProjectStore.getState().mixer.channels[0].id
      ProjectStore.dispatch(SetSendLevel(channelId, 'reverb', 0.6))
      ProjectStore.dispatch(SetSendLevel(channelId, 'delay', 0.3))
      const channel = ProjectStore.getState().mixer.channels[0]
      expect(channel.sends['reverb']).toBe(0.6)
      expect(channel.sends['delay']).toBe(0.3)
    })

    it('does not affect other channels', () => {
      ProjectStore.dispatch(AddTrack('audio', 'Track 1'))
      ProjectStore.dispatch(AddTrack('audio', 'Track 2'))
      const channels = ProjectStore.getState().mixer.channels
      ProjectStore.dispatch(SetSendLevel(channels[0].id, 'reverb', 0.8))
      const updated = ProjectStore.getState().mixer.channels
      expect(updated[1].sends['reverb']).toBeUndefined()
    })

    it('does not affect the buses array', () => {
      ProjectStore.dispatch(AddTrack('audio', 'My Track'))
      const channelId = ProjectStore.getState().mixer.channels[0].id
      const busesBefore = JSON.stringify(ProjectStore.getState().buses)
      ProjectStore.dispatch(SetSendLevel(channelId, 'reverb', 0.5))
      const busesAfter = JSON.stringify(ProjectStore.getState().buses)
      expect(busesBefore).toBe(busesAfter)
    })

    it('clamps level to 0..1', () => {
      ProjectStore.dispatch(AddTrack('audio', 'My Track'))
      const channelId = ProjectStore.getState().mixer.channels[0].id
      ProjectStore.dispatch(SetSendLevel(channelId, 'reverb', 1.5))
      expect(ProjectStore.getState().mixer.channels[0].sends['reverb']).toBe(1)
      ProjectStore.dispatch(SetSendLevel(channelId, 'reverb', -0.2))
      expect(ProjectStore.getState().mixer.channels[0].sends['reverb']).toBe(0)
    })

    it('undo reverts the send level change', () => {
      ProjectStore.dispatch(AddTrack('audio', 'My Track'))
      const channelId = ProjectStore.getState().mixer.channels[0].id
      ProjectStore.dispatch(SetSendLevel(channelId, 'reverb', 0.5))
      ProjectStore.undo()
      const channel = ProjectStore.getState().mixer.channels[0]
      expect(channel.sends['reverb']).toBeUndefined()
    })

    it('redo re-applies the send level after undo', () => {
      ProjectStore.dispatch(AddTrack('audio', 'My Track'))
      const channelId = ProjectStore.getState().mixer.channels[0].id
      ProjectStore.dispatch(SetSendLevel(channelId, 'reverb', 0.5))
      ProjectStore.undo()
      ProjectStore.redo()
      const channel = ProjectStore.getState().mixer.channels[0]
      expect(channel.sends['reverb']).toBe(0.5)
    })
  })

  // ─── SetBusReturn ────────────────────────────────────────────────────────

  describe('SetBusReturn', () => {
    it('updates returnLevel on the buses array entry', () => {
      ProjectStore.dispatch(SetBusReturn('reverb', 0.3))
      const reverb = ProjectStore.getState().buses.find(b => b.id === 'reverb')
      expect(reverb.returnLevel).toBe(0.3)
    })

    it('updating reverb return does not affect delay return', () => {
      const delayBefore = ProjectStore.getState().buses.find(b => b.id === 'delay').returnLevel
      ProjectStore.dispatch(SetBusReturn('reverb', 0.1))
      const delayAfter = ProjectStore.getState().buses.find(b => b.id === 'delay').returnLevel
      expect(delayAfter).toBe(delayBefore)
    })

    it('can update delay returnLevel', () => {
      ProjectStore.dispatch(SetBusReturn('delay', 0.75))
      const delay = ProjectStore.getState().buses.find(b => b.id === 'delay')
      expect(delay.returnLevel).toBe(0.75)
    })

    it('does not throw for unknown busId', () => {
      expect(() => ProjectStore.dispatch(SetBusReturn('unknown', 0.5))).not.toThrow()
    })

    it('clamps level to 0..1', () => {
      ProjectStore.dispatch(SetBusReturn('reverb', 1.5))
      const reverb = ProjectStore.getState().buses.find(b => b.id === 'reverb')
      expect(reverb.returnLevel).toBe(1)

      ProjectStore.dispatch(SetBusReturn('reverb', -0.5))
      const reverb2 = ProjectStore.getState().buses.find(b => b.id === 'reverb')
      expect(reverb2.returnLevel).toBe(0)
    })

    it('undo reverts the return level change', () => {
      const originalLevel = ProjectStore.getState().buses.find(b => b.id === 'reverb').returnLevel
      ProjectStore.dispatch(SetBusReturn('reverb', 0.1))
      ProjectStore.undo()
      const reverb = ProjectStore.getState().buses.find(b => b.id === 'reverb')
      expect(reverb.returnLevel).toBe(originalLevel)
    })

    it('redo re-applies the return level after undo', () => {
      ProjectStore.dispatch(SetBusReturn('reverb', 0.2))
      ProjectStore.undo()
      ProjectStore.redo()
      const reverb = ProjectStore.getState().buses.find(b => b.id === 'reverb')
      expect(reverb.returnLevel).toBe(0.2)
    })

    it('undo/redo stack works correctly for SetBusReturn', () => {
      ProjectStore.dispatch(SetBusReturn('reverb', 0.4))
      ProjectStore.dispatch(SetBusReturn('reverb', 0.6))
      ProjectStore.undo()
      const reverb = ProjectStore.getState().buses.find(b => b.id === 'reverb')
      expect(reverb.returnLevel).toBe(0.4)
      ProjectStore.redo()
      const reverb2 = ProjectStore.getState().buses.find(b => b.id === 'reverb')
      expect(reverb2.returnLevel).toBe(0.6)
    })
  })
})
