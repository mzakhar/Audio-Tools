import { describe, expect, it } from 'vitest'
import MODULES from '../src/renderer/js/rack/modules/index.js'
import { exportPatch, importPatch } from '../src/renderer/js/rack/patch-io.js'
import { starter } from '../src/renderer/js/components/rack-view.js'

const rack = { id: 'r1', name: 'Test', rails: 2, railHp: 84, modules: [{ id: 'v1', type: 'vco', rail: 0, hp: 0, params: { level: 0.5 } }], cables: [] }
const presetFiles = import.meta.glob('../src/renderer/presets/racks/*.json', { eager: true, import: 'default' })

describe('rack patch IO', () => {
  it('round trips rack data', () => expect(importPatch(exportPatch(rack), MODULES).rack).toMatchObject(rack))

  it('preserves unknown modules and fills known defaults', () => {
    const { rack: imported, warnings } = importPatch({ format: 'synthrack', version: 1, rack: { modules: [{ id: 'future', type: 'future-module', extra: true }, { id: 'vco', type: 'vco' }] } }, MODULES)
    expect(warnings).toEqual(['Unknown module: future-module'])
    expect(imported.modules[0]).toMatchObject({ extra: true, type: 'future-module', params: {} })
    expect(imported.modules[1].params).toMatchObject({ wave: 'saw', level: 0.8 })
  })

  it('imports every shipped preset cleanly', () => {
    for (const preset of Object.values(presetFiles)) expect(importPatch(preset, MODULES).warnings).toEqual([])
  })

  it('imports the starter patch cleanly', () => {
    expect(importPatch(starter, MODULES).warnings).toEqual([])
  })

  it('collapses legacy out.l/out.r cables from the same source into one out.in cable', () => {
    const legacy = {
      format: 'synthrack', version: 1,
      rack: {
        modules: [{ id: 'v1', type: 'vco' }, { id: 'o1', type: 'out' }],
        cables: [
          { id: 'c1', from: { moduleId: 'v1', port: 'out' }, to: { moduleId: 'o1', port: 'l' } },
          { id: 'c2', from: { moduleId: 'v1', port: 'out' }, to: { moduleId: 'o1', port: 'r' } }
        ]
      }
    }
    const { rack, warnings } = importPatch(legacy, MODULES)
    expect(warnings).toEqual([])
    expect(rack.cables).toHaveLength(1)
    expect(rack.cables[0].to).toMatchObject({ moduleId: 'o1', port: 'in' })
  })
})
