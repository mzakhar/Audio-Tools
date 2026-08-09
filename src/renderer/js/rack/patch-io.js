import { DEFAULT_RACK } from '../store/ProjectStore.js'

const clone = value => JSON.parse(JSON.stringify(value))

export function exportPatch(rack) {
  return JSON.stringify({ format: 'synthrack', version: 1, rack }, null, 2)
}

export function importPatch(json, registry) {
  const warnings = []
  let patch
  try { patch = typeof json === 'string' ? JSON.parse(json) : clone(json) }
  catch { throw new Error('Invalid .synthrack JSON') }
  if (patch?.format !== 'synthrack') throw new Error('Not a .synthrack patch')
  if (!patch.rack || typeof patch.rack !== 'object') throw new Error('Patch has no rack')

  const rack = { ...DEFAULT_RACK, ...patch.rack }
  rack.modules = Array.isArray(rack.modules) ? rack.modules.map((module, index) => {
    const known = registry[module.type]
    if (!known) warnings.push(`Unknown module: ${module.type || `#${index + 1}`}`)
    return {
      ...module,
      id: module.id || `imported-module-${index + 1}`,
      rail: Number.isInteger(module.rail) ? module.rail : 0,
      hp: Number.isInteger(module.hp) ? module.hp : 0,
      params: { ...(known ? Object.fromEntries(known.params.map(p => [p.key, clone(p.def)])) : {}), ...(module.params || {}) },
      atten: module.atten || {},
    }
  }) : []
  rack.cables = Array.isArray(rack.cables) ? rack.cables : []
  return { rack, warnings }
}
