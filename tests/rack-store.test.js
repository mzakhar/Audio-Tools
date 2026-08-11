import { describe, it, expect, beforeEach } from 'vitest'
import ProjectStore, {
  AddRack, RemoveRack, RenameRack,
  AddModule, RemoveModule, MoveModule,
  SetModuleParam, SetAttenuverter, SetModuleBypass,
  Connect, Disconnect, SetCableColor, LoadRackPatch,
  migrate, DEFAULT_STATE, CURRENT_VERSION
} from '../src/renderer/js/store/ProjectStore.js'

// Helpers — every command needs a rack, most need two modules in it.
function firstRack() {
  const racks = ProjectStore.getState().racks
  return racks[Object.keys(racks)[0]]
}

function seedRack() {
  ProjectStore.dispatch(AddRack('Lead Rack'))
  const rackId = firstRack().id
  ProjectStore.dispatch(AddModule(rackId, 'vco', { rail: 0, hp: 0 }))
  ProjectStore.dispatch(AddModule(rackId, 'vcf', { rail: 0, hp: 10 }))
  const rack = firstRack()
  return { rackId, a: rack.modules[0], b: rack.modules[1] }
}

describe('rack store', () => {
  beforeEach(() => ProjectStore.reset())

  describe('schema', () => {
    it('defaults to an empty racks map at the current version', () => {
      expect(ProjectStore.getState().racks).toEqual({})
      expect(DEFAULT_STATE.version).toBe(CURRENT_VERSION)
      expect(CURRENT_VERSION).toBe(4)
    })
  })

  describe('AddRack / RemoveRack / RenameRack', () => {
    it('adds a rack with the eurorack defaults', () => {
      ProjectStore.dispatch(AddRack('Lead Rack'))
      const rack = firstRack()
      expect(rack.name).toBe('Lead Rack')
      expect(rack.rails).toBe(2)
      expect(rack.railHp).toBe(104)
      expect(rack.polyLimit).toBe(8)
      expect(rack.modules).toEqual([])
      expect(rack.cables).toEqual([])
    })

    it('removes a rack', () => {
      ProjectStore.dispatch(AddRack('Doomed'))
      ProjectStore.dispatch(RemoveRack(firstRack().id))
      expect(ProjectStore.getState().racks).toEqual({})
    })

    it('renames a rack', () => {
      ProjectStore.dispatch(AddRack('Old'))
      ProjectStore.dispatch(RenameRack(firstRack().id, 'New'))
      expect(firstRack().name).toBe('New')
    })

    it('ignores commands for a missing rack', () => {
      ProjectStore.dispatch(RenameRack('nope', 'x'))
      expect(ProjectStore.getState().racks).toEqual({})
    })
  })

  describe('modules', () => {
    it('adds a module with params, atten and bypass fields', () => {
      ProjectStore.dispatch(AddRack('R'))
      ProjectStore.dispatch(AddModule(firstRack().id, 'vco', { rail: 1, hp: 8, params: { tune: 7 } }))
      const mod = firstRack().modules[0]
      expect(mod.type).toBe('vco')
      expect(mod.rail).toBe(1)
      expect(mod.hp).toBe(8)
      expect(mod.params).toEqual({ tune: 7 })
      expect(mod.atten).toEqual({})
      expect(mod.bypassed).toBe(false)
    })

    it('moves a module without touching its params', () => {
      const { rackId, a } = seedRack()
      ProjectStore.dispatch(SetModuleParam(rackId, a.id, 'tune', 12))
      ProjectStore.dispatch(MoveModule(rackId, a.id, 2, 40))
      const mod = firstRack().modules[0]
      expect(mod.rail).toBe(2)
      expect(mod.hp).toBe(40)
      expect(mod.params.tune).toBe(12)
    })

    it('clamps attenuverters to -1..1', () => {
      const { rackId, b } = seedRack()
      ProjectStore.dispatch(SetAttenuverter(rackId, b.id, 'cut', 4))
      expect(firstRack().modules[1].atten.cut).toBe(1)
      ProjectStore.dispatch(SetAttenuverter(rackId, b.id, 'cut', -4))
      expect(firstRack().modules[1].atten.cut).toBe(-1)
    })

    it('sets bypass', () => {
      const { rackId, a } = seedRack()
      ProjectStore.dispatch(SetModuleBypass(rackId, a.id, true))
      expect(firstRack().modules[0].bypassed).toBe(true)
    })

    it('removing a module drops every cable touching it', () => {
      const { rackId, a, b } = seedRack()
      ProjectStore.dispatch(Connect(rackId, { moduleId: a.id, port: 'out' }, { moduleId: b.id, port: 'in' }))
      ProjectStore.dispatch(Connect(rackId, { moduleId: a.id, port: 'sub' }, { moduleId: b.id, port: 'cut' }))
      expect(firstRack().cables).toHaveLength(2)
      ProjectStore.dispatch(RemoveModule(rackId, a.id))
      expect(firstRack().modules).toHaveLength(1)
      expect(firstRack().cables).toEqual([])
    })
  })

  describe('cables', () => {
    it('connects two modules', () => {
      const { rackId, a, b } = seedRack()
      ProjectStore.dispatch(Connect(rackId, { moduleId: a.id, port: 'out' }, { moduleId: b.id, port: 'in' }))
      const cable = firstRack().cables[0]
      expect(cable.from).toEqual({ moduleId: a.id, port: 'out' })
      expect(cable.to).toEqual({ moduleId: b.id, port: 'in' })
      expect(cable.color).toBeNull()
    })

    it('refuses a duplicate cable', () => {
      const { rackId, a, b } = seedRack()
      const from = { moduleId: a.id, port: 'out' }
      const to = { moduleId: b.id, port: 'in' }
      ProjectStore.dispatch(Connect(rackId, from, to))
      ProjectStore.dispatch(Connect(rackId, from, to))
      expect(firstRack().cables).toHaveLength(1)
    })

    it('refuses a cable to a missing module', () => {
      const { rackId, a } = seedRack()
      ProjectStore.dispatch(Connect(rackId, { moduleId: a.id, port: 'out' }, { moduleId: 'ghost', port: 'in' }))
      expect(firstRack().cables).toEqual([])
    })

    it('allows several cables into one input (they sum)', () => {
      const { rackId, a, b } = seedRack()
      ProjectStore.dispatch(Connect(rackId, { moduleId: a.id, port: 'out' }, { moduleId: b.id, port: 'in' }))
      ProjectStore.dispatch(Connect(rackId, { moduleId: a.id, port: 'sub' }, { moduleId: b.id, port: 'in' }))
      expect(firstRack().cables).toHaveLength(2)
    })

    it('disconnects and recolours', () => {
      const { rackId, a, b } = seedRack()
      ProjectStore.dispatch(Connect(rackId, { moduleId: a.id, port: 'out' }, { moduleId: b.id, port: 'in' }))
      const cableId = firstRack().cables[0].id
      ProjectStore.dispatch(SetCableColor(rackId, cableId, '#ff0055'))
      expect(firstRack().cables[0].color).toBe('#ff0055')
      ProjectStore.dispatch(Disconnect(rackId, cableId))
      expect(firstRack().cables).toEqual([])
    })
  })

  describe('LoadRackPatch', () => {
    it('replaces a rack and fills in missing defaults', () => {
      const { rackId } = seedRack()
      ProjectStore.dispatch(LoadRackPatch(rackId, {
        name: 'Imported',
        modules: [{ id: 'm-1', type: 'out', rail: 0, hp: 0, params: {} }]
      }))
      const rack = firstRack()
      expect(rack.id).toBe(rackId)
      expect(rack.name).toBe('Imported')
      expect(rack.modules).toHaveLength(1)
      expect(rack.cables).toEqual([])
      expect(rack.railHp).toBe(104)
    })
  })

  describe('undo / redo', () => {
    it('undoes a patch and redoes it', () => {
      const { rackId, a, b } = seedRack()
      ProjectStore.dispatch(Connect(rackId, { moduleId: a.id, port: 'out' }, { moduleId: b.id, port: 'in' }))
      expect(firstRack().cables).toHaveLength(1)
      ProjectStore.undo()
      expect(firstRack().cables).toHaveLength(0)
      ProjectStore.redo()
      expect(firstRack().cables).toHaveLength(1)
    })

    it('undoes a module removal together with its cables', () => {
      const { rackId, a, b } = seedRack()
      ProjectStore.dispatch(Connect(rackId, { moduleId: a.id, port: 'out' }, { moduleId: b.id, port: 'in' }))
      ProjectStore.dispatch(RemoveModule(rackId, a.id))
      ProjectStore.undo()
      expect(firstRack().modules).toHaveLength(2)
      expect(firstRack().cables).toHaveLength(1)
    })
  })

  describe('migrate', () => {
    // VC lost its MIX jack when its channels started cascading. The engine drops
    // a cable to a port that no longer exists without a word, so a saved patch
    // would have gone quiet with nothing to explain it.
    it('moves a saved VC MIX cable onto the D output', () => {
      const old = {
        version: 3, bpm: 120, tracks: [], mixer: { channels: [], master: {} }, patterns: {},
        racks: { r1: {
          id: 'r1', modules: [{ id: 'vc1', type: 'vc' }, { id: 'o', type: 'out' }],
          cables: [
            { id: 'c1', from: { moduleId: 'vc1', port: 'mix' }, to: { moduleId: 'o', port: 'in' } },
            { id: 'c2', from: { moduleId: 'vc1', port: 'outa' }, to: { moduleId: 'o', port: 'in' } }
          ]
        } }
      }
      const next = migrate(old)
      expect(next.version).toBe(CURRENT_VERSION)
      expect(next.racks.r1.cables[0].from.port).toBe('outd')
      expect(next.racks.r1.cables[1].from.port).toBe('outa')   // untouched
    })

    it('adds an empty racks map to a v1 project', () => {
      const old = { version: 1, bpm: 128, tracks: [], mixer: { channels: [], master: {} }, patterns: {} }
      const next = migrate(old)
      expect(next.version).toBe(CURRENT_VERSION)
      expect(next.racks).toEqual({})
      expect(next.bpm).toBe(128)
    })

    it('treats a version-less project as v1', () => {
      expect(migrate({ bpm: 90 }).racks).toEqual({})
    })

    it('leaves a v2 project\'s racks untouched, adding patterns and bumping version', () => {
      const v2 = { version: 2, racks: { 'rack-1': { id: 'rack-1', modules: [], cables: [] } } }
      const next = migrate(v2)
      expect(next.version).toBe(CURRENT_VERSION)
      expect(next.racks).toEqual(v2.racks)
      expect(next.patterns).toEqual({})
    })

    it('does not mutate its input', () => {
      const old = { version: 1 }
      migrate(old)
      expect(old).toEqual({ version: 1 })
    })

    it('runs on load()', () => {
      ProjectStore.load({ version: 1, bpm: 100, tracks: [], mixer: { channels: [] }, patterns: {} })
      const state = ProjectStore.getState()
      expect(state.version).toBe(CURRENT_VERSION)
      expect(state.racks).toEqual({})
    })
  })
})
