import { describe, it, expect } from 'vitest'
import { buildIndex, searchIndex } from '../src/renderer/js/instruments/patch-index.js'

function pack(id, version, patches) {
  return { id, version, manifest: { id, name: `${id} manifest`, patches }, byId: new Map(), byAddress: new Map() }
}

const packs = [
  pack('packA', '1.0.0', [
    { id: 'p1', name: 'Warm Pad', kind: 'melodic', address: { bankMsb: 0, bankLsb: 0, program: 1 } },
    { id: 'p2', name: 'Warm Pad 2', kind: 'melodic', address: { bankMsb: 0, bankLsb: 0, program: 2 } },
    { id: 'p3', name: 'Bell', kind: 'melodic', address: { bankMsb: 0, bankLsb: 0, program: 3 } },
  ]),
  pack('packB', '2.0.0', [
    { id: 'q1', name: 'Sub Bass', kind: 'melodic', address: { bankMsb: 0, bankLsb: 0, program: 10 } },
  ]),
]

const palettes = { classic: { name: 'Classic' }, fm: { name: 'FM' } }
const racks = { rack1: { id: 'rack1', name: 'Warm Pad Rack' } }

describe('buildIndex', () => {
  it('flattens a two-pack catalog with correct packId/packVersion on every row', () => {
    const index = buildIndex({ packs, palettes: {}, racks: {} })
    expect(index).toHaveLength(4)
    const p1 = index.find(row => row.instrument.patchId === 'p1')
    expect(p1.instrument).toEqual({ type: 'pack', packId: 'packA', packVersion: '1.0.0', patchId: 'p1', programFollow: 'pinned' })
    expect(p1.sub).toBe('packA manifest')
    expect(p1.program).toBe(1)
    const q1 = index.find(row => row.instrument.patchId === 'q1')
    expect(q1.instrument.packId).toBe('packB')
    expect(q1.instrument.packVersion).toBe('2.0.0')
  })

  it('indexes palettes and racks with the right instrument objects', () => {
    const index = buildIndex({ packs: [], palettes, racks })
    const classicRow = index.find(row => row.kind === 'palette' && row.instrument.paletteKey === 'classic')
    expect(classicRow.label).toBe('Classic')
    expect(classicRow.sub).toBe('Internal')
    const rackRow = index.find(row => row.kind === 'rack')
    expect(rackRow.instrument).toEqual({ type: 'rack', rackId: 'rack1' })
    expect(rackRow.label).toBe('Warm Pad Rack')
    expect(rackRow.sub).toBe('Rack')
  })

  it('indexes a bare manifest (no .manifest wrapper)', () => {
    const bareManifest = { id: 'bare', version: '1.0.0', name: 'Bare Pack', patches: [
      { id: 'b1', name: 'Bare Patch', kind: 'melodic', address: { bankMsb: 0, bankLsb: 0, program: 5 } },
    ] }
    const index = buildIndex({ packs: [bareManifest], palettes: {}, racks: {} })
    expect(index).toHaveLength(1)
    expect(index[0].instrument).toEqual({ type: 'pack', packId: 'bare', packVersion: '1.0.0', patchId: 'b1', programFollow: 'pinned' })
    expect(index[0].sub).toBe('Bare Pack')
  })
})

describe('searchIndex', () => {
  const index = buildIndex({ packs, palettes, racks })

  it('ranks exact label match above prefix match above sub-only match', () => {
    const results = searchIndex(index, 'warm pad')
    const labels = results.map(r => r.label)
    expect(labels[0]).toBe('Warm Pad')
    expect(labels.indexOf('Warm Pad')).toBeLessThan(labels.indexOf('Warm Pad 2'))
    // 'Warm Pad Rack' only matches via label prefix too, but pack row is exact so it must come first
    expect(labels[0]).toBe('Warm Pad')
  })

  it('scope filters by kind', () => {
    const results = searchIndex(index, '', { scope: 'palette' })
    expect(results.every(r => r.kind === 'palette')).toBe(true)
    expect(results).toHaveLength(2)
  })

  it('empty query returns favourites first, then recent, then the rest, each once', () => {
    const bellKey = index.find(r => r.label === 'Bell').key
    const subBassKey = index.find(r => r.label === 'Sub Bass').key
    const results = searchIndex(index, '', { favourites: [bellKey], recent: [subBassKey, bellKey] })
    expect(results[0].key).toBe(bellKey)
    expect(results[1].key).toBe(subBassKey)
    const keys = results.map(r => r.key)
    expect(new Set(keys).size).toBe(keys.length)
    expect(keys.length).toBe(index.length)
  })
})
