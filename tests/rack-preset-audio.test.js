import { describe, it, expect } from 'vitest'
import MODULES from '../src/renderer/js/rack/modules/index.js'
import { importPatch } from '../src/renderer/js/rack/patch-io.js'

const presets = import.meta.glob('../src/renderer/presets/racks/*.json', { eager: true, import: 'default' })

// Presets that are CV benches by design: they demonstrate control voltage and
// never had a voice. Everything else is expected to reach an output.
const CV_ONLY = new Set(['CV Bench', 'Mixer Modulation'])

const portOf = (type, id) => MODULES[type]?.ports.find(p => p.id === id) || null

// Can any audio source in this patch reach a terminal module, travelling only
// along cables that land on an audio input? A patch that fails this cannot make
// a sound whatever the knobs say — which is exactly the bug that shipped in
// Generative Euclid, a "generative" preset with no OUT module in it at all.
function reachesOutput(rack) {
  const byId = new Map(rack.modules.map(m => [m.id, m]))
  const out = new Map()
  for (const cable of rack.cables) {
    if (!out.has(cable.from.moduleId)) out.set(cable.from.moduleId, [])
    out.get(cable.from.moduleId).push(cable)
  }

  const isTerminal = id => MODULES[byId.get(id)?.type]?.terminal === true
  const sources = rack.modules.filter(m =>
    (MODULES[m.type]?.ports || []).some(p => p.dir === 'out' && p.kind === 'audio'))

  const seen = new Set()
  const queue = sources.map(m => m.id)
  while (queue.length) {
    const id = queue.shift()
    if (seen.has(id)) continue
    seen.add(id)
    if (isTerminal(id)) return true
    for (const cable of out.get(id) || []) {
      // Audio has to land on an audio input; a gate into DRUM's TRIG is not
      // the signal flowing onward.
      if (portOf(byId.get(cable.to.moduleId)?.type, cable.to.port)?.kind !== 'audio') continue
      queue.push(cable.to.moduleId)
    }
  }
  return false
}

describe('shipped presets can make sound', () => {
  for (const [path, json] of Object.entries(presets)) {
    const file = path.split('/').pop()
    it(`${file} has an audio path from a source to an output`, () => {
      const { rack } = importPatch(json, MODULES)
      if (CV_ONLY.has(rack.name)) {
        expect(reachesOutput(rack)).toBe(false)   // pin the exemption, so a fixed one gets noticed
        return
      }
      expect(reachesOutput(rack)).toBe(true)
    })
  }

  it('every preset that reaches an output also has something to open the gate', () => {
    // A voice behind a VCA needs an envelope, and an envelope needs a trigger.
    // Nothing here checks levels — only that the trigger side is wired at all.
    // The starter rack is the deliberate exception: its ADSR is left ungated so
    // the rack is silent the moment the view mounts, instead of a drone.
    const UNGATED_BY_DESIGN = new Set(['Starter', 'Starter rack'])
    const ungated = []
    for (const [path, json] of Object.entries(presets)) {
      const { rack } = importPatch(json, MODULES)
      if (CV_ONLY.has(rack.name) || UNGATED_BY_DESIGN.has(rack.name)) continue
      const envelopes = rack.modules.filter(m => m.type === 'adsr' || m.type === 'ad')
      for (const env of envelopes) {
        const trigPort = env.type === 'ad' ? 'trig' : 'gate'
        const looping = env.type === 'ad' && env.params?.loop === 'on'
        const fed = rack.cables.some(c => c.to.moduleId === env.id && c.to.port === trigPort)
        if (!fed && !looping) ungated.push(`${path.split('/').pop()}: ${env.id}`)
      }
    }
    expect(ungated).toEqual([])
  })
})
