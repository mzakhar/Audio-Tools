import { describe, it, expect } from 'vitest'
import { MODULES } from '@js/rack/modules/index.js'

const presets = import.meta.glob('../src/renderer/presets/racks/*.json', { eager: true, import: 'default' })

describe('shipped rack presets', () => {
  for (const [path, json] of Object.entries(presets)) {
    const name = path.split('/').pop()
    const rack = json.rack || json

    it(`${name} references only real modules and ports`, () => {
      const byId = Object.fromEntries(rack.modules.map(m => [m.id, m]))
      const problems = []

      for (const module of rack.modules) {
        if (!MODULES[module.type]) problems.push(`module ${module.id}: unknown type "${module.type}"`)
      }

      for (const cable of rack.cables || []) {
        for (const [side, end] of [['from', cable.from], ['to', cable.to]]) {
          const def = MODULES[byId[end.moduleId]?.type]
          if (!def) { problems.push(`cable ${cable.id} ${side}: unknown module "${end.moduleId}"`); continue }
          const port = def.ports.find(p => p.id === end.port)
          if (!port) {
            problems.push(`cable ${cable.id} ${side}: ${def.type} has no port "${end.port}" (has ${def.ports.map(p => p.id).join(', ')})`)
          } else if ((side === 'from') !== (port.dir === 'out')) {
            problems.push(`cable ${cable.id} ${side}: ${def.type}.${end.port} is an ${port.dir}, expected ${side === 'from' ? 'out' : 'in'}`)
          }
        }
      }

      expect(problems).toEqual([])
    })
  }
})
