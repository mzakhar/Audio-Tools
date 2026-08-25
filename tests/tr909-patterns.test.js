import { describe, it, expect, beforeEach } from 'vitest'
import ProjectStore, {
  SetPatternStep, SetBarParam, AddBar, RemoveBar, SetCurrentBar, SetChain, ClearBar,
  nextChainPos, makeBar, makePattern909,
  migrate, DEFAULT_STATE, CURRENT_VERSION
} from '../src/renderer/js/store/ProjectStore.js'
import { INSTRUMENTS } from '../src/renderer/js/drums/tr909-kit.js'

const PATTERN_ID = '909-main'

function pattern() {
  return ProjectStore.getState().patterns[PATTERN_ID]
}

describe('tr-909 pattern bars', () => {
  beforeEach(() => ProjectStore.reset())

  describe('schema', () => {
    it('defaults to an empty patterns map at version 3', () => {
      expect(ProjectStore.getState().patterns).toEqual({})
      expect(DEFAULT_STATE.version).toBe(CURRENT_VERSION)
      expect(CURRENT_VERSION).toBe(5)
    })
  })

  describe('makeBar / makePattern909', () => {
    it('makeBar has one lane per INSTRUMENTS entry, 16 steps, all off', () => {
      const bar = makeBar()
      expect(bar.scale).toBe('1/16')
      expect(bar.lastStep).toBe(16)
      expect(Object.keys(bar.lanes).sort()).toEqual(INSTRUMENTS.map(i => i.id).sort())
      for (const inst of INSTRUMENTS) {
        expect(bar.lanes[inst.id]).toHaveLength(16)
        expect(bar.lanes[inst.id].every(s => s.on === false)).toBe(true)
      }
    })

    it('makePattern909 starts with one bar and a single-entry chain', () => {
      const p = makePattern909(PATTERN_ID)
      expect(p.id).toBe(PATTERN_ID)
      expect(p.currentBar).toBe(0)
      expect(p.chain).toEqual([0])
      expect(p.bars).toHaveLength(1)
    })
  })

  describe('SetPatternStep', () => {
    it('changes only the addressed step', () => {
      ProjectStore.dispatch(SetPatternStep(PATTERN_ID, 0, 'bd', 3, { on: true, accent: true }))
      const bar = pattern().bars[0]
      expect(bar.lanes.bd[3]).toMatchObject({ on: true, accent: true })
      expect(bar.lanes.bd[2].on).toBe(false)
      expect(bar.lanes.bd[4].on).toBe(false)
      expect(bar.lanes.sd[3].on).toBe(false)
    })

    it('is a no-op for an out-of-range step or bar', () => {
      ProjectStore.dispatch(SetPatternStep(PATTERN_ID, 0, 'bd', 99, { on: true }))
      ProjectStore.dispatch(SetPatternStep(PATTERN_ID, 5, 'bd', 0, { on: true }))
      expect(pattern().bars[0].lanes.bd.every(s => s.on === false)).toBe(true)
    })
  })

  describe('SetBarParam', () => {
    it('sets a known key', () => {
      ProjectStore.dispatch(SetBarParam(PATTERN_ID, 0, 'shuffle', 0.4))
      expect(pattern().bars[0].shuffle).toBe(0.4)
    })

    it('ignores an unknown key', () => {
      ProjectStore.dispatch(SetBarParam(PATTERN_ID, 0, 'bogus', 42))
      expect(pattern().bars[0].bogus).toBeUndefined()
    })
  })

  describe('AddBar', () => {
    it('copyFrom deep-copies the source bar with a fresh id, independent of the source', () => {
      ProjectStore.dispatch(SetPatternStep(PATTERN_ID, 0, 'bd', 0, { on: true }))
      ProjectStore.dispatch(AddBar(PATTERN_ID, { copyFrom: 0 }))
      const p = pattern()
      expect(p.bars).toHaveLength(2)
      expect(p.bars[1].id).not.toBe(p.bars[0].id)
      expect(p.bars[1].lanes.bd[0].on).toBe(true)
      expect(p.chain).toEqual([0, 1])

      // mutate the copy, source must be untouched
      ProjectStore.dispatch(SetPatternStep(PATTERN_ID, 1, 'bd', 0, { on: false }))
      expect(pattern().bars[0].lanes.bd[0].on).toBe(true)
      expect(pattern().bars[1].lanes.bd[0].on).toBe(false)
    })

    it('empty bar has all steps off and is appended to chain', () => {
      ProjectStore.dispatch(AddBar(PATTERN_ID))
      const p = pattern()
      expect(p.bars).toHaveLength(2)
      expect(p.bars[1].lanes.bd.every(s => s.on === false)).toBe(true)
      expect(p.chain).toEqual([0, 1])
    })
  })

  describe('RemoveBar', () => {
    function threeBars() {
      ProjectStore.dispatch(AddBar(PATTERN_ID)) // index 1
      ProjectStore.dispatch(AddBar(PATTERN_ID)) // index 2
      ProjectStore.dispatch(SetChain(PATTERN_ID, [0, 1, 1, 2, 0]))
    }

    it('drops the middle bar, drops chain entries pointing at it, decrements entries above it', () => {
      threeBars()
      ProjectStore.dispatch(RemoveBar(PATTERN_ID, 1))
      const p = pattern()
      expect(p.bars).toHaveLength(2)
      expect(p.chain).toEqual([0, 1, 0])
    })

    it('is a no-op when only one bar remains', () => {
      const before = pattern()
      expect(before).toBeUndefined() // pattern not created until first dispatch
      ProjectStore.dispatch(SetCurrentBar(PATTERN_ID, 0)) // creates '909-main' lazily
      const stateBefore = ProjectStore.getState()
      ProjectStore.dispatch(RemoveBar(PATTERN_ID, 0))
      expect(ProjectStore.getState()).toEqual(stateBefore)
    })

    it('clamps currentBar when it pointed at or past the removed bar', () => {
      threeBars()
      ProjectStore.dispatch(SetCurrentBar(PATTERN_ID, 2))
      ProjectStore.dispatch(RemoveBar(PATTERN_ID, 2))
      expect(pattern().currentBar).toBe(1)
    })
  })

  describe('SetCurrentBar / SetChain / ClearBar', () => {
    it('SetCurrentBar changes editor selection, ignores out-of-range', () => {
      ProjectStore.dispatch(AddBar(PATTERN_ID))
      ProjectStore.dispatch(SetCurrentBar(PATTERN_ID, 1))
      expect(pattern().currentBar).toBe(1)
      ProjectStore.dispatch(SetCurrentBar(PATTERN_ID, 99))
      expect(pattern().currentBar).toBe(1)
    })

    it('SetChain replaces the play order wholesale', () => {
      ProjectStore.dispatch(AddBar(PATTERN_ID))
      ProjectStore.dispatch(SetChain(PATTERN_ID, [1, 0, 1]))
      expect(pattern().chain).toEqual([1, 0, 1])
    })

    it('ClearBar resets all lanes of one bar, leaves others alone', () => {
      ProjectStore.dispatch(SetPatternStep(PATTERN_ID, 0, 'bd', 0, { on: true }))
      ProjectStore.dispatch(AddBar(PATTERN_ID, { copyFrom: 0 }))
      ProjectStore.dispatch(ClearBar(PATTERN_ID, 0))
      const p = pattern()
      expect(p.bars[0].lanes.bd.every(s => s.on === false)).toBe(true)
      expect(p.bars[1].lanes.bd[0].on).toBe(true)
    })
  })

  describe('migrate', () => {
    it('v2 project gains patterns and version 3, existing tracks/racks untouched', () => {
      const v2 = {
        version: 2,
        bpm: 120,
        tracks: [{ id: 't1', type: 'midi', instrument: { type: 'palette', paletteKey: 'fm' } }],
        racks: { r1: { id: 'r1', name: 'Rack', modules: [], cables: [] } }
      }
      const next = migrate(v2)
      expect(next.version).toBe(CURRENT_VERSION)
      expect(next.patterns).toEqual({})
      expect(next.tracks).toEqual(v2.tracks)
      expect(next.racks).toEqual(v2.racks)
    })
  })

  describe('nextChainPos', () => {
    it('advances within range', () => {
      expect(nextChainPos(0, 3)).toBe(1)
      expect(nextChainPos(1, 3)).toBe(2)
    })

    it('wraps at the end', () => {
      expect(nextChainPos(2, 3)).toBe(0)
    })

    it('handles a single-entry chain', () => {
      expect(nextChainPos(0, 1)).toBe(0)
    })
  })
})
