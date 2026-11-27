import { describe, it, expect, beforeEach } from 'vitest'
import ProjectStore, { migrate, CURRENT_VERSION, SetPadsSettings, SetKitSlot } from '../src/renderer/js/store/ProjectStore.js'
import { kitFor, KITS, DEFAULT_KIT_ID } from '../src/renderer/js/pads/kit.js'

beforeEach(() => ProjectStore.reset())

describe('schema v7 migration', () => {
  it('seeds kits and pads on a v6 project', () => {
    const next = migrate({ version: 6, tracks: [] })
    expect(next.version).toBe(CURRENT_VERSION)
    expect(next.kits[DEFAULT_KIT_ID].slots[36].voice).toBe('bd')
    expect(next.pads).toEqual({ loopBars: 2, groove: 0.5, snapGrid: 0.25, snapStrength: 1, metronome: true, countInBars: 1, full: false, ladder: null, repeatRate: '1/16', muted: [] })
  })

  it('keeps an existing custom kit and pads values', () => {
    const custom = { id: 'mine', name: 'Mine', slots: { 36: { voice: 'sd', params: {} } } }
    const next = migrate({ version: 6, tracks: [], kits: { mine: custom }, pads: { loopBars: 4 } })
    expect(next.kits.mine).toEqual(custom)
    expect(next.kits[DEFAULT_KIT_ID]).toBeTruthy()
    expect(next.pads.loopBars).toBe(4)
    expect(next.pads.countInBars).toBe(1)
  })
})

describe('SetPadsSettings', () => {
  it('clamps ranged values and merges the rest', () => {
    ProjectStore.dispatch(SetPadsSettings({ loopBars: 99, groove: 0.9, snapStrength: -1, countInBars: 7, metronome: false }))
    expect(ProjectStore.getState().pads).toMatchObject({ loopBars: 8, groove: 0.75, snapStrength: 0, countInBars: 2, metronome: false, snapGrid: 0.25 })
    ProjectStore.dispatch(SetPadsSettings({ loopBars: 0, groove: 0.1 }))
    expect(ProjectStore.getState().pads).toMatchObject({ loopBars: 1, groove: 0.5 })
  })
})

describe('SetKitSlot', () => {
  it('edits one slot and is undoable', () => {
    const before = ProjectStore.getState().kits[DEFAULT_KIT_ID]
    ProjectStore.dispatch(SetKitSlot(DEFAULT_KIT_ID, 36, { voice: 'cp', params: {} }))
    const after = ProjectStore.getState().kits[DEFAULT_KIT_ID]
    expect(after.slots[36].voice).toBe('cp')
    expect(after.slots[38]).toEqual(before.slots[38])
    ProjectStore.undo()
    expect(ProjectStore.getState().kits[DEFAULT_KIT_ID].slots[36].voice).toBe('bd')
  })

  it('ignores an unknown kit', () => {
    ProjectStore.dispatch(SetKitSlot('nope', 36, { voice: 'cp', params: {} }))
    expect(ProjectStore.getState().kits.nope).toBeUndefined()
  })
})

describe('kitFor with a store map', () => {
  it('prefers the store map and falls back to code kits', () => {
    const edited = { id: DEFAULT_KIT_ID, name: 'Edited', slots: {} }
    expect(kitFor(DEFAULT_KIT_ID, { [DEFAULT_KIT_ID]: edited })).toBe(edited)
    expect(kitFor(DEFAULT_KIT_ID, {})).toBe(KITS[DEFAULT_KIT_ID])
    expect(kitFor('nope', {})).toBeNull()
  })
})

describe('SetPadsSettings phase 3 keys', () => {
  it('sanitises ladder, repeatRate, muted, full', () => {
    ProjectStore.dispatch(SetPadsSettings({ ladder: 'tune', repeatRate: '1/32', muted: [38, 36, 38, 'x'], full: 1 }))
    expect(ProjectStore.getState().pads).toMatchObject({ ladder: 'tune', repeatRate: '1/32', muted: [36, 38], full: true })
    ProjectStore.dispatch(SetPadsSettings({ ladder: 'bogus', repeatRate: '9/9', muted: 'no' }))
    expect(ProjectStore.getState().pads).toMatchObject({ ladder: null, repeatRate: '1/16', muted: [] })
  })
})
