import { describe, it, expect } from 'vitest'
import {
  HP_PX, UNKNOWN_HP, hpToPx, pxToHp, moduleWidthHp,
  canPlace, firstFreeSlot, packRail, tidyRack, minRails
} from '../src/renderer/js/rack/rack-layout.js'

const registry = { vco: { hp: 8 }, vcf: { hp: 6 }, mult: { hp: 4 } }

function rack(modules, overrides = {}) {
  return { id: 'r1', name: 'Rack', rails: 3, railHp: 104, modules, cables: [], ...overrides }
}

describe('hpToPx / pxToHp', () => {
  it('round-trips at zoom 1', () => {
    expect(hpToPx(8, 1)).toBe(128)
    expect(pxToHp(128, 1)).toBe(8)
  })
  it('round-trips at zoom 0.5', () => {
    expect(hpToPx(8, 0.5)).toBe(64)
    expect(pxToHp(64, 0.5)).toBe(8)
  })
  it('round-trips at zoom 2', () => {
    expect(hpToPx(8, 2)).toBe(256)
    expect(pxToHp(256, 2)).toBe(8)
  })
  it('HP_PX is 16', () => {
    expect(HP_PX).toBe(16)
  })
})

describe('moduleWidthHp', () => {
  it('uses registry width', () => {
    expect(moduleWidthHp({ type: 'vco' }, registry)).toBe(8)
  })
  it('falls back to UNKNOWN_HP for unregistered type', () => {
    expect(moduleWidthHp({ type: 'nope' }, registry)).toBe(UNKNOWN_HP)
  })
})

describe('canPlace', () => {
  it('fits in an empty rack', () => {
    const r = rack([])
    expect(canPlace(r, registry, { rail: 0, hp: 0, widthHp: 8 })).toBe(true)
  })
  it('rejects overlap on the left', () => {
    const r = rack([{ id: 'm1', type: 'vco', rail: 0, hp: 4 }])
    expect(canPlace(r, registry, { rail: 0, hp: 0, widthHp: 8 })).toBe(false)
  })
  it('rejects overlap on the right', () => {
    const r = rack([{ id: 'm1', type: 'vco', rail: 0, hp: 4 }])
    expect(canPlace(r, registry, { rail: 0, hp: 10, widthHp: 8 })).toBe(false)
  })
  it('rejects exact overlap', () => {
    const r = rack([{ id: 'm1', type: 'vco', rail: 0, hp: 4 }])
    expect(canPlace(r, registry, { rail: 0, hp: 4, widthHp: 8 })).toBe(false)
  })
  it('allows flush adjacency', () => {
    const r = rack([{ id: 'm1', type: 'vco', rail: 0, hp: 0 }])
    expect(canPlace(r, registry, { rail: 0, hp: 8, widthHp: 6 })).toBe(true)
  })
  it('rejects placement past railHp', () => {
    const r = rack([])
    expect(canPlace(r, registry, { rail: 0, hp: 100, widthHp: 8 })).toBe(false)
  })
  it('rejects negative hp', () => {
    const r = rack([])
    expect(canPlace(r, registry, { rail: 0, hp: -1, widthHp: 8 })).toBe(false)
  })
  it('rejects out-of-range rail', () => {
    const r = rack([])
    expect(canPlace(r, registry, { rail: 3, hp: 0, widthHp: 8 })).toBe(false)
    expect(canPlace(r, registry, { rail: -1, hp: 0, widthHp: 8 })).toBe(false)
  })
  it('ignoreId lets a module stay where it already is', () => {
    const r = rack([{ id: 'm1', type: 'vco', rail: 0, hp: 4 }])
    expect(canPlace(r, registry, { rail: 0, hp: 4, widthHp: 8, ignoreId: 'm1' })).toBe(true)
  })
})

describe('firstFreeSlot', () => {
  it('returns rail 0 hp 0 for an empty rack', () => {
    expect(firstFreeSlot(rack([]), registry, 8)).toEqual({ rail: 0, hp: 0 })
  })
  it('finds a gap between two modules', () => {
    const r = rack([
      { id: 'm1', type: 'mult', rail: 0, hp: 0 },   // 0-4
      { id: 'm2', type: 'vco', rail: 0, hp: 20 }    // 20-28
    ])
    // gap is [4, 20) width 16, fits a 4-wide mult first checked... use vcf width 6
    expect(firstFreeSlot(r, registry, 6)).toEqual({ rail: 0, hp: 4 })
  })
  it('finds the tail gap when no mid-gap fits', () => {
    const r = rack([{ id: 'm1', type: 'vco', rail: 0, hp: 0 }]) // 0-8
    expect(firstFreeSlot(r, registry, 8)).toEqual({ rail: 0, hp: 8 })
  })
  it('spills to next rail when rail 0 is full', () => {
    const modules = []
    let hp = 0
    let i = 0
    while (hp + 8 <= 104) {
      modules.push({ id: `m${i}`, type: 'vco', rail: 0, hp })
      hp += 8
      i++
    }
    const r = rack(modules)
    expect(firstFreeSlot(r, registry, 8)).toEqual({ rail: 1, hp: 0 })
  })
  it('returns null when nothing fits anywhere', () => {
    // fill every rail completely with 104/8 = 13 vcos
    const full = []
    for (let rail = 0; rail < 3; rail++) {
      for (let hp = 0; hp + 8 <= 104; hp += 8) {
        full.push({ id: `f-${rail}-${hp}`, type: 'vco', rail, hp })
      }
    }
    const r = rack(full)
    expect(firstFreeSlot(r, registry, 8)).toBe(null)
  })
})

describe('packRail', () => {
  it('removes gaps and keeps order', () => {
    const r = rack([
      { id: 'm1', type: 'mult', rail: 0, hp: 20 }, // 4 wide
      { id: 'm2', type: 'vco', rail: 0, hp: 40 }   // 8 wide
    ])
    expect(packRail(r, registry, 0)).toEqual([
      { id: 'm1', hp: 0 },
      { id: 'm2', hp: 4 }
    ])
  })
  it('does not mutate input', () => {
    const r = rack([{ id: 'm1', type: 'mult', rail: 0, hp: 20 }])
    packRail(r, registry, 0)
    expect(r.modules[0].hp).toBe(20)
  })
})

describe('minRails', () => {
  it('is 1 for an empty rack', () => {
    expect(minRails(rack([]))).toBe(1)
  })
  it('is one past the highest occupied rail', () => {
    const r = rack([
      { id: 'm1', type: 'vco', rail: 0, hp: 0 },
      { id: 'm2', type: 'vco', rail: 2, hp: 0 }
    ])
    expect(minRails(r)).toBe(3)
  })
})

describe('tidyRack', () => {
  it('packs every rail flush-left', () => {
    const r = rack([
      { id: 'm1', type: 'mult', rail: 0, hp: 20 },
      { id: 'm2', type: 'vco', rail: 1, hp: 50 }
    ])
    const tidied = tidyRack(r, registry)
    expect(tidied.modules.find(m => m.id === 'm1').hp).toBe(0)
    expect(tidied.modules.find(m => m.id === 'm2').hp).toBe(0)
  })
  it('does not mutate the original rack', () => {
    const r = rack([{ id: 'm1', type: 'mult', rail: 0, hp: 20 }])
    tidyRack(r, registry)
    expect(r.modules[0].hp).toBe(20)
  })
  it('returns a new rack and modules array', () => {
    const r = rack([{ id: 'm1', type: 'mult', rail: 0, hp: 20 }])
    const tidied = tidyRack(r, registry)
    expect(tidied).not.toBe(r)
    expect(tidied.modules).not.toBe(r.modules)
  })
})
