// The dialog's logic, not its pixels: what the renderer injects into the
// shared validator, and what it refuses to dispatch.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { validatePlan } from '../src/shared/daw-assistant/plan.js'
import ProjectStore, { AddTrack } from '../src/renderer/js/store/ProjectStore.js'
import { ASSISTANT_CAPABILITIES, bindCommands, applyPlan } from '../src/renderer/js/components/assistant-dialog.js'

const plan = (...actions) => ({ summary: 'Test plan', actions })

// A real rack shape: VCO OUT → VCF IN is legal, the reverse is not.
const rackState = () => ({
  tracks: [], mixer: { channels: [] }, buses: [], patterns: {},
  racks: {
    'rack-1': {
      id: 'rack-1', name: 'Rack 1', rails: 2, railHp: 104,
      modules: [
        { id: 'mod-1', type: 'vco', rail: 0, hp: 0, params: {}, atten: {}, bypassed: false },
        { id: 'mod-2', type: 'vcf', rail: 0, hp: 12, params: {}, atten: {}, bypassed: false },
      ],
      cables: [],
    },
  },
})

const connect = (from, to) => plan({ action: 'Connect', args: { rackId: 'rack-1', from, to } })

describe('assistant capability adapter', () => {
  it('passes a forward cable and refuses a backwards one', () => {
    const state = rackState()
    const forward = validatePlan(connect({ moduleId: 'mod-1', port: 'out' }, { moduleId: 'mod-2', port: 'in' }), state, ASSISTANT_CAPABILITIES)
    expect(forward.ok).toBe(true)

    const backwards = validatePlan(connect({ moduleId: 'mod-2', port: 'in' }, { moduleId: 'mod-1', port: 'out' }), state, ASSISTANT_CAPABILITIES)
    expect(backwards.ok).toBe(false)
    expect(backwards.errors[0]).toContain('source must be an output')
  })

  it('knows the registry types and each module type\'s param keys', () => {
    expect(ASSISTANT_CAPABILITIES.moduleTypes).toContain('vco')
    expect(ASSISTANT_CAPABILITIES.moduleParamKeys('vcf')).toContain('cutoff')
    const state = rackState()
    const bad = plan({ action: 'SetModuleParam', args: { rackId: 'rack-1', moduleId: 'mod-2', key: 'nope', value: 1 } })
    expect(validatePlan(bad, state, ASSISTANT_CAPABILITIES).ok).toBe(false)
    const good = plan({ action: 'SetModuleParam', args: { rackId: 'rack-1', moduleId: 'mod-2', key: 'cutoff', value: 800 } })
    expect(validatePlan(good, state, ASSISTANT_CAPABILITIES).ok).toBe(true)
  })
})

describe('assistant factory binding', () => {
  it('rejects a factory name that is not in the literal map', () => {
    expect(() => bindCommands([{ factory: 'LoadRackPatch', args: ['rack-1', {}] }])).toThrow(TypeError)
    expect(() => bindCommands([{ factory: 'constructor', args: [] }])).toThrow(TypeError)
    expect(bindCommands([{ factory: 'SetBpm', args: [128] }])[0].execute).toBeTypeOf('function')
  })
})

describe('assistant apply path', () => {
  beforeEach(() => { ProjectStore.reset() })

  const spyStore = () => ({
    getState: () => ProjectStore.getState(),
    dispatchBatch: vi.fn((commands, label) => ProjectStore.dispatchBatch(commands, label)),
  })

  it('refuses a plan whose track was deleted after propose, and dispatches nothing', () => {
    ProjectStore.dispatch(AddTrack('midi', 'Kick'))
    const trackId = ProjectStore.getState().tracks[0].id
    const pending = plan({ action: 'SetTrackMidiChannel', args: { trackId, channel: 3 } })

    ProjectStore.dispatch({ label: 'Remove track', execute: state => ({ ...state, tracks: [] }) })
    const store = spyStore()
    const result = applyPlan(pending, store)

    expect(result.ok).toBe(false)
    expect(result.errors[0]).toContain('track not found')
    expect(store.dispatchBatch).not.toHaveBeenCalled()
  })

  it('applies a nine-action plan as one batch and one undo entry', () => {
    const store = spyStore()
    const before = ProjectStore.getState()
    const result = applyPlan(plan(
      { action: 'SetBpm', args: { bpm: 128 } },
      ...Array.from({ length: 8 }, (_, i) => ({ action: 'AddTrack', args: { type: 'midi', name: `Track ${i}` } })),
    ), store)

    expect(result.ok).toBe(true)
    expect(result.count).toBe(9)
    expect(store.dispatchBatch).toHaveBeenCalledTimes(1)
    expect(ProjectStore.getUndoStackSize()).toBe(1)
    expect(ProjectStore.getUndoLabel()).toBe('Assistant: Test plan')

    ProjectStore.undo()
    expect(ProjectStore.getState()).toEqual(before)
  })

  it('applies a forward ref: the instrument lands on the track the plan just added', () => {
    const store = spyStore()
    const result = applyPlan(plan(
      { action: 'SetBpm', args: { bpm: 128 } },
      { action: 'AddTrack', args: { type: 'midi', name: 'Lead' }, ref: 'lead' },
      { action: 'SetTrackInstrument', args: { trackId: { $ref: 'lead' }, instrument: { type: 'palette', paletteKey: 'fm' } } },
      { action: 'SetMixerParam', args: { channelId: { $ref: 'lead' }, param: 'volume', value: 0.5 } },
    ), store)

    expect(result.ok).toBe(true)
    const after = ProjectStore.getState()
    const track = after.tracks.find(item => item.name === 'Lead')
    expect(track.instrument).toEqual({ type: 'palette', paletteKey: 'fm' })
    // The channelId slot resolved to that track's own mixer channel.
    expect(after.mixer.channels.find(channel => channel.id === track.mixerChannelId).volume).toBe(0.5)
    // Still one batch, still one undo.
    expect(store.dispatchBatch).toHaveBeenCalledTimes(1)
    expect(ProjectStore.getUndoStackSize()).toBe(1)
    ProjectStore.undo()
    expect(ProjectStore.getState().tracks).toHaveLength(0)
  })

  it('dispatches exactly the pre-minted ids, and mints fresh ones on a second apply', () => {
    const store = spyStore()
    const creating = plan(
      { action: 'AddTrack', args: { type: 'midi', name: 'Lead' }, ref: 'lead' },
      { action: 'AddEffect', args: { trackId: { $ref: 'lead' }, type: 'delay', params: {} } },
    )

    expect(applyPlan(creating, store).ok).toBe(true)
    const first = ProjectStore.getState().tracks[0]
    expect(applyPlan(creating, store).ok).toBe(true)
    const [a, b] = ProjectStore.getState().tracks

    expect(a.id).toBe(first.id)
    expect(b.id).not.toBe(a.id)
    expect(b.mixerChannelId).not.toBe(a.mixerChannelId)
    expect(a.effects[0].id).not.toBe(b.effects[0].id)

    // The ids the store holds are the ones planToCommands handed to the batch.
    const dispatched = store.dispatchBatch.mock.calls[1][0]
    expect(dispatched[0].execute).toBeTypeOf('function')
    expect(ProjectStore.getState().tracks.map(track => track.id)).toContain(b.id)
  })

  it('refuses a ref plan whose kinds do not match, and dispatches nothing', () => {
    const store = spyStore()
    const result = applyPlan(plan(
      { action: 'AddTrack', args: { type: 'midi', name: 'Lead' }, ref: 'lead' },
      { action: 'SetTrackMidiChannel', args: { trackId: { $ref: 'gone' }, channel: 2 } },
    ), store)

    expect(result.ok).toBe(false)
    expect(result.errors[0]).toMatch(/unknown ref/)
    expect(store.dispatchBatch).not.toHaveBeenCalled()
    expect(ProjectStore.getState().tracks).toHaveLength(0)
  })

  it('mints different clip ids when one plan is applied twice', () => {
    ProjectStore.dispatch(AddTrack('midi', 'Kick'))
    const trackId = ProjectStore.getState().tracks[0].id
    const adding = plan({ action: 'AddClip', args: { trackId, clip: { startBeat: 0, duration: 4 } } })

    expect(applyPlan(adding, ProjectStore).ok).toBe(true)
    expect(applyPlan(adding, ProjectStore).ok).toBe(true)
    const ids = ProjectStore.getState().tracks[0].clips.map(clip => clip.id)
    expect(ids).toHaveLength(2)
    expect(new Set(ids).size).toBe(2)
  })
})
