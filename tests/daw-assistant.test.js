import { describe, it, expect, beforeEach, vi } from 'vitest'
import { buildDigest, clampDigest, MAX_TRACKS, MAX_CLIPS } from '../src/shared/daw-assistant/digest.js'
import { validatePlanShape, validatePlan, describeAction, planToCommands, ALLOWLIST } from '../src/shared/daw-assistant/plan.js'
import ProjectStore, { AddTrack, AddEffect, SetBpm } from '../src/renderer/js/store/ProjectStore.js'

const step = on => ({ on, velocity: 0.85, accent: false, flam: false })
const lane = pattern => [...pattern].map(char => step(char === '1'))

const state = () => ({
  bpm: 120,
  timeSignature: [4, 4],
  tracks: [{
    id: 'track-1', name: 'Kick', type: 'midi', mixerChannelId: 'channel-1',
    instrument: { type: 'palette', paletteKey: 'drum' },
    clips: [{ id: 'clip-1', name: 'Bar 1', startBeat: 0, duration: 4, notes: [{ id: 'note-1', pitch: 36, startBeat: 0, duration: 1, velocity: 0.9 }] }],
    effects: [{ id: 'effect-1', type: 'delay', params: { time: 0.25 } }],
  }],
  mixer: { channels: [{ id: 'channel-1', trackId: 'track-1', volume: 0.8, pan: 0, mute: false, solo: false, sends: {} }], master: { volume: 0.85 } },
  buses: [{ id: 'reverb', name: 'Reverb', returnLevel: 0.8, params: {} }],
  patterns: {
    'pattern-1': {
      id: 'pattern-1', name: '909', currentBar: 0, chain: [0],
      bars: [{ id: 'bar-1', scale: '1/16', lastStep: 16, lanes: { kick: lane('1000100010001000'), snare: lane('0000100000001000') } }],
    },
  },
  racks: {
    'rack-1': {
      id: 'rack-1', name: 'Rack 1', rails: 2, railHp: 104,
      modules: [{ id: 'mod-1', type: 'vco', rail: 0, hp: 0, params: { tune: 0 }, atten: {}, bypassed: false, name: null },
                { id: 'mod-2', type: 'vcf', rail: 1, hp: 0, params: {}, atten: {}, bypassed: false, name: null }],
      cables: [{ id: 'cable-1', from: { moduleId: 'mod-1', port: 'out' }, to: { moduleId: 'mod-2', port: 'in' }, color: null }],
    },
  },
})

const plan = (...actions) => ({ summary: 'Test plan', actions })

describe('daw assistant digest', () => {
  it('caps a huge project and says it was truncated', () => {
    const big = state()
    big.tracks = Array.from({ length: 200 }, (_, i) => ({
      id: `track-${i}`, name: `Track ${i}`, type: 'midi', mixerChannelId: `channel-${i}`,
      clips: Array.from({ length: 40 }, (_, c) => ({ id: `clip-${i}-${c}`, startBeat: c * 4, duration: 4, notes: [] })),
    }))
    const digest = buildDigest(big)
    expect(digest.tracks).toHaveLength(MAX_TRACKS)
    expect(digest.tracks[0].clips).toHaveLength(MAX_CLIPS)
    expect(digest.tracks[0].clipCount).toBe(40)
    expect(digest.truncated).toBe(true)
  })

  it('reduces notes to a count and step lanes to a 16-character string', () => {
    const digest = buildDigest(state())
    expect(digest.truncated).toBe(false)
    expect(digest.tracks[0].clips[0]).toEqual({ id: 'clip-1', startBeat: 0, duration: 4, noteCount: 1 })
    expect(digest.tracks[0].clips[0].notes).toBeUndefined()
    expect(digest.patterns[0].bars[0].lanes.kick).toBe('1000100010001000')
    expect(digest.racks[0].cables[0]).toEqual({ id: 'cable-1', from: { moduleId: 'mod-1', port: 'out' }, to: { moduleId: 'mod-2', port: 'in' } })
  })

  it('clips long names and drops non-scalar module params', () => {
    const long = state()
    long.tracks[0].name = 'n'.repeat(200)
    long.racks['rack-1'].modules[0].params = { tune: 3, evil: { nested: true } }
    const digest = buildDigest(long)
    expect(digest.tracks[0].name).toHaveLength(64)
    expect(digest.racks[0].modules[0].params).toEqual({ tune: 3 })
  })
})

describe('clampDigest', () => {
  it('caps an oversized client-supplied digest the same as buildDigest would', () => {
    const hostile = { tracks: Array.from({ length: 500 }, (_, i) => ({ id: `t${i}` })) }
    expect(clampDigest(hostile).tracks).toHaveLength(MAX_TRACKS)
    expect(clampDigest(hostile).truncated).toBe(true)
  })

  it('returns a minimal valid digest for non-object input', () => {
    const empty = { bpm: 120, timeSignature: [4, 4], tracks: [], mixer: [], racks: [], patterns: [], truncated: false }
    expect(clampDigest('not a digest')).toEqual(empty)
    expect(clampDigest(null)).toEqual(empty)
    expect(clampDigest([1, 2, 3])).toEqual(empty)
  })

  it('drops a __proto__ key instead of letting it survive', () => {
    const hostile = JSON.parse('{"tracks":[{"__proto__":{"polluted":true},"id":"t1"}]}')
    const clamped = clampDigest(hostile)
    expect(clamped.tracks[0]).not.toHaveProperty('polluted')
    expect(Object.getPrototypeOf(clamped.tracks[0])).toBe(Object.prototype)
    expect({}.polluted).toBeUndefined()
  })
})

describe('daw assistant plan shape', () => {
  it('exposes only the specced action vocabulary', () => {
    expect(ALLOWLIST).toContain('SetBpm')
    for (const excluded of ['AddRack', 'RemoveRack', 'LoadRackPatch', 'SetCurrentBar', 'SetBusReturn', 'SetCableColor']) {
      expect(ALLOWLIST).not.toContain(excluded)
    }
  })

  it('rejects an unknown action name', () => {
    const result = validatePlanShape(plan({ action: 'DropDatabase', args: {} }))
    expect(result.ok).toBe(false)
    expect(result.errors[0]).toMatch(/unknown action/)
  })

  it('rejects a plan over the action cap', () => {
    const result = validatePlanShape(plan(...Array.from({ length: 40 }, () => ({ action: 'SetBpm', args: { bpm: 128 } }))))
    expect(result.ok).toBe(false)
    expect(result.errors[0]).toMatch(/<= 24/)
  })

  it('rejects a mixer param that is not volume, pan, mute or solo', () => {
    for (const param of ['__proto__', 'constructor', 'sends']) {
      const result = validatePlanShape(plan({ action: 'SetMixerParam', args: { channelId: 'channel-1', param, value: 1 } }))
      expect(result.ok).toBe(false)
    }
    expect(validatePlanShape(plan({ action: 'SetMixerParam', args: { channelId: 'channel-1', param: 'mute', value: 1 } })).ok).toBe(false)
    expect(validatePlanShape(plan({ action: 'SetMixerParam', args: { channelId: 'channel-1', param: 'volume', value: 4 } })).ok).toBe(false)
    expect(validatePlanShape(plan({ action: 'SetMixerParam', args: { channelId: 'channel-1', param: 'volume', value: 0.5 } })).ok).toBe(true)
  })

  it('rejects prototype-polluting keys anywhere a string becomes a key', () => {
    expect(validatePlanShape(plan({ action: 'SetModuleParam', args: { rackId: 'rack-1', moduleId: 'mod-1', key: '__proto__', value: 1 } })).ok).toBe(false)
    expect(validatePlanShape(plan({ action: 'SetEffectParam', args: { trackId: 'track-1', effectId: 'effect-1', param: 'constructor', value: 1 } })).ok).toBe(false)
    expect(validatePlanShape(plan({ action: 'AddEffect', args: { trackId: 'track-1', type: 'delay', params: { prototype: 1 } } })).ok).toBe(false)
  })

  it('rejects too many notes and out-of-range note fields', () => {
    const notes = count => Array.from({ length: count }, (_, i) => ({ pitch: 36, startBeat: i * 0.25, duration: 0.25, velocity: 0.9 }))
    expect(validatePlanShape(plan({ action: 'SetMidiClipNotes', args: { trackId: 'track-1', clipId: 'clip-1', notes: notes(900) } })).ok).toBe(false)
    expect(validatePlanShape(plan({ action: 'SetMidiClipNotes', args: { trackId: 'track-1', clipId: 'clip-1', notes: notes(4) } })).ok).toBe(true)
    const bad = [{ pitch: 200, startBeat: 0, duration: 1 }, { pitch: 36, startBeat: -1, duration: 1 }, { pitch: 36, startBeat: 0, duration: 0.01 }, { pitch: 36, startBeat: 0, duration: 1, velocity: 3 }]
    for (const note of bad) {
      expect(validatePlanShape(plan({ action: 'SetMidiClipNotes', args: { trackId: 'track-1', clipId: 'clip-1', notes: [note] } })).ok).toBe(false)
    }
  })

  it('drops fields the schema does not name', () => {
    const result = validatePlanShape(plan({ action: 'SetBpm', args: { bpm: 128, alsoDeleteEverything: true } }))
    expect(result.value.actions[0].args).toEqual({ bpm: 128 })
  })
})

describe('daw assistant live validation', () => {
  it('accepts a plan against the state it was written for', () => {
    const result = validatePlan(plan(
      { action: 'SetBpm', args: { bpm: 128 } },
      { action: 'SetMixerParam', args: { channelId: 'channel-1', param: 'volume', value: 0.6 } },
      { action: 'SetPatternStep', args: { patternId: 'pattern-1', barIndex: 0, instrumentId: 'kick', stepIndex: 4, patch: { on: true } } },
    ), state())
    expect(result.ok).toBe(true)
  })

  it('passes shape but fails live when the track was deleted meanwhile', () => {
    const proposed = plan({ action: 'MoveClip', args: { trackId: 'track-1', clipId: 'clip-1', startBeat: 8 } })
    expect(validatePlanShape(proposed).ok).toBe(true)
    const after = state()
    after.tracks = []
    const result = validatePlan(proposed, after)
    expect(result.ok).toBe(false)
    expect(result.errors).toEqual(['Action 1 (MoveClip): track not found'])
  })

  it('refuses a backwards cable through the injected canConnect', () => {
    const backwards = plan({ action: 'Connect', args: { rackId: 'rack-1', from: { moduleId: 'mod-2', port: 'in' }, to: { moduleId: 'mod-1', port: 'out' } } })
    const canConnect = vi.fn(() => ({ ok: false, reason: 'source must be an output' }))
    const result = validatePlan(backwards, state(), { canConnect })
    expect(canConnect).toHaveBeenCalledTimes(1)
    expect(result.ok).toBe(false)
    expect(result.errors[0]).toMatch(/source must be an output/)
    expect(validatePlan(backwards, state(), { canConnect: () => ({ ok: true }) }).ok).toBe(true)
  })

  it('skips only the checks whose capability was not supplied', () => {
    const addModule = plan({ action: 'AddModule', args: { rackId: 'rack-1', type: 'lfo', rail: 1, hp: 8 } })
    expect(validatePlan(addModule, state()).ok).toBe(true)
    expect(validatePlan(addModule, state(), { moduleTypes: ['vco', 'vcf'] }).ok).toBe(false)
    expect(validatePlan(addModule, state(), { moduleTypes: ['vco', 'lfo'] }).ok).toBe(true)
    // A rack id that is gone still fails without any capability.
    expect(validatePlan(plan({ action: 'AddModule', args: { rackId: 'rack-9', type: 'lfo' } }), state()).ok).toBe(false)
  })

  it('constrains module param keys to what the module type declares', () => {
    const setParam = plan({ action: 'SetModuleParam', args: { rackId: 'rack-1', moduleId: 'mod-1', key: 'cutoff', value: 400 } })
    const moduleParamKeys = vi.fn(type => (type === 'vco' ? ['tune', 'wave'] : []))
    expect(validatePlan(setParam, state(), { moduleParamKeys }).ok).toBe(false)
    expect(moduleParamKeys).toHaveBeenCalledWith('vco')
    expect(validatePlan(plan({ action: 'SetModuleParam', args: { rackId: 'rack-1', moduleId: 'mod-1', key: 'tune', value: 3 } }), state(), { moduleParamKeys }).ok).toBe(true)
  })

  it('refuses ids that no longer resolve, one error per action', () => {
    const cases = [
      [{ action: 'RemoveClip', args: { trackId: 'track-1', clipId: 'clip-9' } }, /clip not found/],
      [{ action: 'RemoveMidiNote', args: { trackId: 'track-1', clipId: 'clip-1', noteId: 'note-9' } }, /note not found/],
      [{ action: 'SetSendLevel', args: { channelId: 'channel-1', busId: 'chorus', level: 0.3 } }, /bus not found/],
      [{ action: 'RemoveEffect', args: { trackId: 'track-1', effectId: 'effect-9' } }, /effect not found/],
      [{ action: 'Disconnect', args: { rackId: 'rack-1', cableId: 'cable-9' } }, /cable not found/],
      [{ action: 'ClearBar', args: { patternId: 'pattern-9', barIndex: 0 } }, /pattern not found/],
      [{ action: 'ClearBar', args: { patternId: 'pattern-1', barIndex: 3 } }, /bar not found/],
      [{ action: 'SetPatternStep', args: { patternId: 'pattern-1', barIndex: 0, instrumentId: 'cowbell', stepIndex: 0, patch: { on: true } } }, /instrument not in this bar/],
    ]
    for (const [action, message] of cases) {
      const result = validatePlan(plan(action), state())
      expect(result.ok).toBe(false)
      expect(result.errors[0]).toMatch(message)
    }
  })

  it('fails the whole plan when any single action fails', () => {
    const result = validatePlan(plan(
      { action: 'SetBpm', args: { bpm: 128 } },
      { action: 'RemoveTrack', args: { trackId: 'track-gone' } },
    ), state())
    expect(result.ok).toBe(false)
    expect(result.value).toBeUndefined()
  })
})

describe('daw assistant descriptions and command mapping', () => {
  it('names the real target', () => {
    const current = state()
    expect(describeAction({ action: 'SetBpm', args: { bpm: 128 } }, current)).toBe('Set BPM to 128')
    expect(describeAction({ action: 'AddModule', args: { rackId: 'rack-1', type: 'lfo', rail: 1, hp: 8 } }, current)).toBe('Add a LFO module to Rack 1, rail 2')
    expect(describeAction({ action: 'RemoveTrack', args: { trackId: 'track-1' } }, current)).toBe('Remove track "Kick"')
    expect(describeAction({ action: 'SetMixerParam', args: { channelId: 'channel-1', param: 'volume', value: 0.6 } }, current)).toBe('Set volume on "Kick" to 0.6')
  })

  it('falls back to the id when the target is gone', () => {
    expect(describeAction({ action: 'RemoveTrack', args: { trackId: 'track-9' } }, state())).toBe('Remove track "track-9"')
    expect(describeAction({ action: 'Nonsense', args: {} }, state())).toBe('Unknown action')
  })

  it('maps a validated plan to store factory calls in order', () => {
    const calls = planToCommands(plan(
      { action: 'SetBpm', args: { bpm: 128 } },
      { action: 'SetMixerParam', args: { channelId: 'channel-1', param: 'mute', value: true } },
      { action: 'AddMidiNote', args: { trackId: 'track-1', clipId: 'clip-1', note: { pitch: 40, startBeat: 1, duration: 0.5 } } },
    ), state(), { makeId: kind => `${kind}-1` })
    expect(calls.map(call => call.factory)).toEqual(['SetBpm', 'SetMixerParam', 'AddMidiNote'])
    expect(calls[0].args).toEqual([128])
    expect(calls[1].args).toEqual(['channel-1', 'mute', true])
    expect(calls[2].args[2]).toEqual({ id: 'note-1', pitch: 40, startBeat: 1, duration: 0.5, velocity: 0.8 })
  })

  it('refuses to map a plan that never passed validation', () => {
    expect(() => planToCommands(plan({ action: 'DropDatabase', args: {} }), state())).toThrow(TypeError)
  })

  it('refuses to invent an id when no makeId is injected', () => {
    const adding = plan({ action: 'AddClip', args: { trackId: 'track-1', clip: { startBeat: 0, duration: 4 } } })
    expect(() => planToCommands(adding, state())).toThrow(TypeError)
    // Nothing minted, nothing to collide: an id-free plan still maps.
    expect(planToCommands(plan({ action: 'SetBpm', args: { bpm: 128 } }), state())).toHaveLength(1)
  })

  it('mints different ids for two applies of one plan against one state', () => {
    const stale = state()
    const adding = plan({ action: 'AddClip', args: { trackId: 'track-1', clip: { startBeat: 0, duration: 4 } } })
    let seq = 0
    const makeId = kind => `${kind}-${++seq}`
    const first = planToCommands(adding, stale, { makeId })
    const second = planToCommands(adding, stale, { makeId })
    expect(first[0].args[1].id).not.toBe(second[0].args[1].id)
  })
})

describe('daw assistant forward references', () => {
  const refPlan = () => plan(
    { action: 'AddTrack', args: { type: 'midi', name: 'Lead' }, ref: 'lead' },
    { action: 'SetTrackInstrument', args: { trackId: { $ref: 'lead' }, instrument: { type: 'palette', paletteKey: 'fm' } } },
  )

  it('resolves a ref to an earlier action, in shape and against live state', () => {
    const shape = validatePlanShape(refPlan())
    expect(shape.ok).toBe(true)
    expect(shape.value.actions[0].ref).toBe('lead')
    expect(shape.value.actions[1].args.trackId).toEqual({ $ref: 'lead' })
    expect(validatePlan(refPlan(), state()).ok).toBe(true)
  })

  it('resolves a track ref in a channelId slot to that track mixer channel', () => {
    const mixing = plan(
      { action: 'AddTrack', args: { type: 'midi', name: 'Lead' }, ref: 'lead' },
      { action: 'SetMixerParam', args: { channelId: { $ref: 'lead' }, param: 'volume', value: 0.5 } },
    )
    expect(validatePlan(mixing, state()).ok).toBe(true)
    let seq = 0
    const calls = planToCommands(mixing, state(), { makeId: kind => `${kind}-${++seq}` })
    expect(calls[0].args[2]).toEqual({ trackId: 'track-1', channelId: 'channel-2' })
    expect(calls[1].args[0]).toBe('channel-2')
  })

  it('refuses a ref to a later action and a ref that was never defined', () => {
    const backwards = plan(
      { action: 'SetTrackMidiChannel', args: { trackId: { $ref: 'lead' }, channel: 2 } },
      { action: 'AddTrack', args: { type: 'midi', name: 'Lead' }, ref: 'lead' },
    )
    expect(validatePlan(backwards, state()).errors[0]).toMatch(/created by a later action/)
    const missing = plan({ action: 'SetTrackMidiChannel', args: { trackId: { $ref: 'nope' }, channel: 2 } })
    expect(validatePlan(missing, state()).errors[0]).toMatch(/unknown ref/)
  })

  it('refuses a clip ref in a track slot', () => {
    const mismatched = plan(
      { action: 'AddClip', args: { trackId: 'track-1', clip: { startBeat: 0, duration: 4 } }, ref: 'riff' },
      { action: 'SetTrackMidiChannel', args: { trackId: { $ref: 'riff' }, channel: 2 } },
    )
    const result = validatePlan(mismatched, state())
    expect(result.ok).toBe(false)
    expect(result.errors[0]).toMatch(/is a clip, not usable as trackId/)
  })

  it('refuses a duplicate slug, a malformed slug, and a ref on a non-creating action', () => {
    const twice = plan(
      { action: 'AddTrack', args: { name: 'A' }, ref: 'lead' },
      { action: 'AddTrack', args: { name: 'B' }, ref: 'lead' },
    )
    expect(validatePlanShape(twice).errors[0]).toMatch(/duplicate ref/)
    expect(validatePlanShape(plan({ action: 'AddTrack', args: {}, ref: 'Lead Track' })).ok).toBe(false)
    expect(validatePlanShape(plan({ action: 'AddTrack', args: {}, ref: '__proto__' })).ok).toBe(false)
    expect(validatePlanShape(plan({ action: 'SetBpm', args: { bpm: 120 }, ref: 'tempo' })).errors[0]).toMatch(/cannot define a ref/)
    expect(validatePlanShape(plan({ action: 'SetBpm', args: { bpm: 120 } })).value.actions[0].ref).toBeUndefined()
  })

  it('refuses a slug that shadows an id already in the project', () => {
    const shadow = plan(
      { action: 'AddTrack', args: { name: 'Lead' }, ref: 'track-1' },
      { action: 'SetTrackMidiChannel', args: { trackId: { $ref: 'track-1' }, channel: 2 } },
    )
    expect(validatePlan(shadow, state()).errors[0]).toMatch(/collides with an id already in the project/)
  })

  it('refuses a malformed $ref, and a $ref in a slot no action can fill', () => {
    expect(validatePlanShape(plan({ action: 'SetBpm', args: { bpm: { $ref: 'lead' } } })).ok).toBe(false)
    expect(validatePlanShape(plan({ action: 'AddModule', args: { rackId: { $ref: 'lead' }, type: 'lfo' } })).ok).toBe(false)
    expect(validatePlanShape(plan({ action: 'RemoveTrack', args: { trackId: { $ref: 'NOPE!' } } })).ok).toBe(false)
  })

  it('checks a ref-created module the way it checks a real one', () => {
    const patching = plan(
      { action: 'AddModule', args: { rackId: 'rack-1', type: 'lfo', rail: 1, hp: 8 }, ref: 'lfo1' },
      { action: 'SetModuleParam', args: { rackId: 'rack-1', moduleId: { $ref: 'lfo1' }, key: 'rate', value: 2 } },
      { action: 'Connect', args: { rackId: 'rack-1', from: { moduleId: { $ref: 'lfo1' }, port: 'out' }, to: { moduleId: 'mod-2', port: 'cutoff' } } },
    )
    const canConnect = vi.fn(() => ({ ok: true }))
    const moduleParamKeys = vi.fn(type => (type === 'lfo' ? ['rate'] : []))
    expect(validatePlan(patching, state(), { canConnect, moduleParamKeys }).ok).toBe(true)
    // Both capability checks saw the module the plan is about to create.
    expect(moduleParamKeys).toHaveBeenCalledWith('lfo')
    expect(canConnect.mock.calls[0][1]).toEqual({ moduleId: 'lfo1', port: 'out' })
    expect(validatePlan(patching, state(), { moduleParamKeys: () => ['nope'] }).ok).toBe(false)
  })

  it('pre-mints every id and resolves refs to exactly those ids', () => {
    const creating = plan(
      { action: 'AddTrack', args: { type: 'midi', name: 'Lead' }, ref: 'lead' },
      { action: 'AddEffect', args: { trackId: { $ref: 'lead' }, type: 'delay', params: {} }, ref: 'fx' },
      { action: 'SetEffectParam', args: { trackId: { $ref: 'lead' }, effectId: { $ref: 'fx' }, param: 'time', value: 0.25 } },
    )
    expect(validatePlan(creating, state()).ok).toBe(true)
    let seq = 0
    const calls = planToCommands(creating, state(), { makeId: kind => `${kind}-${++seq}` })
    const trackId = calls[0].args[2].trackId
    const effectId = calls[1].args[3]
    expect(calls[1].args[0]).toBe(trackId)
    expect(calls[2].args.slice(0, 2)).toEqual([trackId, effectId])
    // A second pass over the same plan and the same state mints a fresh set.
    const again = planToCommands(creating, state(), { makeId: kind => `${kind}-${++seq}` })
    expect(again[0].args[2].trackId).not.toBe(trackId)
  })

  it('needs a makeId for any creating action', () => {
    expect(() => planToCommands(plan({ action: 'AddTrack', args: { name: 'Lead' } }), state())).toThrow(TypeError)
    expect(() => planToCommands(plan({ action: 'AddEffect', args: { trackId: 'track-1', type: 'delay' } }), state())).toThrow(TypeError)
  })

  it('describes a $ref as the step that creates it', () => {
    const actions = refPlan().actions
    expect(describeAction(actions[1], state(), actions)).toBe('Set the instrument on "the track added in step 1" to fm')
    expect(describeAction(actions[1], state())).toBe('Set the instrument on "the track added earlier" to fm')
  })
})

describe('ProjectStore.dispatchBatch', () => {
  beforeEach(() => { ProjectStore.reset() })

  it('applies nine commands as one undo entry and one notify', () => {
    const listener = vi.fn()
    ProjectStore.subscribe(listener)
    const before = ProjectStore.getState()
    ProjectStore.dispatchBatch(Array.from({ length: 9 }, (_, i) => AddTrack('midi', `Track ${i}`)), 'Assistant plan')

    expect(listener).toHaveBeenCalledTimes(1)
    expect(ProjectStore.getState().tracks).toHaveLength(9)
    expect(ProjectStore.getUndoStackSize()).toBe(1)
    expect(ProjectStore.getUndoLabel()).toBe('Assistant plan')

    ProjectStore.undo()
    expect(ProjectStore.getState()).toEqual(before)
    expect(ProjectStore.canRedo()).toBe(true)
  })

  it('mints its own ids when none are supplied, and honours them when they are', () => {
    ProjectStore.dispatch(AddTrack('midi', 'Plain'))
    const plain = ProjectStore.getState().tracks[0]
    expect(plain.id).toMatch(/^track-/)
    expect(plain.mixerChannelId).toMatch(/^channel-/)
    expect(ProjectStore.getState().mixer.channels[0].id).toBe(plain.mixerChannelId)

    ProjectStore.dispatch(AddTrack('midi', 'Named', { trackId: 'given-track', channelId: 'given-channel' }))
    const named = ProjectStore.getState().tracks[1]
    expect(named.id).toBe('given-track')
    expect(named.mixerChannelId).toBe('given-channel')
    expect(ProjectStore.getState().mixer.channels[1]).toMatchObject({ id: 'given-channel', trackId: 'given-track' })

    ProjectStore.dispatch(AddEffect('given-track', 'delay', { time: 0.25 }))
    ProjectStore.dispatch(AddEffect('given-track', 'delay', { time: 0.25 }, 'given-effect'))
    const effects = ProjectStore.getState().tracks[1].effects
    expect(effects[0].id).toMatch(/^effect-/)
    expect(effects[1].id).toBe('given-effect')
  })

  it('clears the redo stack like dispatch does', () => {
    ProjectStore.dispatch(SetBpm(140))
    ProjectStore.undo()
    expect(ProjectStore.canRedo()).toBe(true)
    ProjectStore.dispatchBatch([SetBpm(90)], 'Assistant plan')
    expect(ProjectStore.canRedo()).toBe(false)
  })

  it('abandons the whole batch when one command throws', () => {
    const before = ProjectStore.getState()
    const listener = vi.fn()
    ProjectStore.subscribe(listener)
    const commands = Array.from({ length: 9 }, (_, i) => (
      i === 4 ? { label: 'boom', execute() { throw new Error('boom') } } : AddTrack('midi', `Track ${i}`)
    ))

    expect(() => ProjectStore.dispatchBatch(commands, 'Assistant plan')).toThrow('boom')
    expect(ProjectStore.getState()).toEqual(before)
    expect(ProjectStore.getUndoStackSize()).toBe(0)
    expect(ProjectStore.canRedo()).toBe(false)
    expect(listener).not.toHaveBeenCalled()
  })
})
