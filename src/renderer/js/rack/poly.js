/**
 * poly.js
 * Pure polyphony resolution for the modular rack. Never mutates the rack it's given.
 * See specs/modular-rack.md §5.6. A cable carries the channel count of its source module;
 * poly propagates forward through the graph (chain reaction), mono modules clamp back to 1.
 */

function clampCh(n, limit) {
  return Math.min(Math.max(1, Math.floor(n) || 1), limit)
}

// ─── Channel resolution ───
export function resolveChannels(rack, registry) {
  const limit = rack.polyLimit ?? 8
  const channels = new Map()
  for (const m of rack.modules) channels.set(m.id, 1)

  // modules that originate polyphony have a fixed count, independent of iteration
  const fixed = new Map()
  for (const m of rack.modules) {
    const def = registry[m.type]
    if (def?.polySource) fixed.set(m.id, clampCh(def.polySource(m, rack), limit))
  }

  // fixpoint iteration, capped so cycles can't loop forever
  const maxIter = rack.modules.length + 1
  for (let i = 0; i < maxIter; i++) {
    let changed = false
    for (const m of rack.modules) {
      const def = registry[m.type]
      let next
      if (fixed.has(m.id)) {
        next = fixed.get(m.id)
      } else if (!def || def.poly === false) {
        next = 1
      } else {
        let n = 1
        for (const c of rack.cables) {
          if (c.to.moduleId !== m.id) continue
          n = Math.max(n, channels.get(c.from.moduleId) ?? 1)
        }
        next = clampCh(n, limit)
      }
      if (next !== channels.get(m.id)) {
        changed = true
        channels.set(m.id, next)
      }
    }
    if (!changed) break
  }
  return channels
}

// ─── Cable channel counts ───
export function cableChannels(rack, registry) {
  const channels = resolveChannels(rack, registry)
  const result = new Map()
  for (const c of rack.cables) result.set(c.id, channels.get(c.from.moduleId) ?? 1)
  return result
}

// ─── Mixdown detection ───
export function isMixdown(rack, registry, cable) {
  const channels = resolveChannels(rack, registry)
  const src = channels.get(cable.from.moduleId) ?? 1
  const dst = channels.get(cable.to.moduleId) ?? 1
  return src > dst
}
