/**
 * rack-layout.js
 * Pure HP/rail layout math for the modular rack. Never mutates the rack it's given.
 * Rack shape: { id, name, rails, railHp, modules: [{ id, type, rail, hp, params }], cables }
 * `hp` on a module is its left offset in HP within its rail; width comes from the registry.
 */

export const HP_PX = 16 // 1 HP = 16px at 100% zoom
export const UNKNOWN_HP = 8 // fallback width for a module type missing from the registry

// ─── Pixel <-> HP ───
export function hpToPx(hp, zoom = 1) {
  return hp * HP_PX * zoom
}
export function pxToHp(px, zoom = 1) {
  return Math.round(px / (HP_PX * zoom))
}

// ─── Module width ───
export function moduleWidthHp(module, registry) {
  return registry[module.type]?.hp ?? UNKNOWN_HP
}

// ─── Placement ───
export function canPlace(rack, registry, { rail, hp, widthHp, ignoreId = null }) {
  if (rail < 0 || rail >= rack.rails) return false
  if (hp < 0) return false
  if (hp + widthHp > rack.railHp) return false
  const end = hp + widthHp
  for (const m of rack.modules) {
    if (m.rail !== rail || m.id === ignoreId) continue
    const mWidth = moduleWidthHp(m, registry)
    const mEnd = m.hp + mWidth
    if (hp < mEnd && m.hp < end) return false
  }
  return true
}

export function firstFreeSlot(rack, registry, widthHp) {
  for (let rail = 0; rail < rack.rails; rail++) {
    const spans = rack.modules
      .filter(m => m.rail === rail)
      .map(m => ({ start: m.hp, end: m.hp + moduleWidthHp(m, registry) }))
      .sort((a, b) => a.start - b.start)

    let cursor = 0
    for (const span of spans) {
      if (span.start - cursor >= widthHp) return { rail, hp: cursor }
      cursor = Math.max(cursor, span.end)
    }
    if (rack.railHp - cursor >= widthHp) return { rail, hp: cursor }
  }
  return null
}

// ─── Repacking ───
export function packRail(rack, registry, rail) {
  const modules = rack.modules
    .filter(m => m.rail === rail)
    .sort((a, b) => a.hp - b.hp)

  let cursor = 0
  const packed = []
  for (const m of modules) {
    packed.push({ id: m.id, hp: cursor })
    cursor += moduleWidthHp(m, registry)
  }
  return packed
}

// Lowest rail count that still holds every module. Guards the rail stepper from
// shrinking a rack out from under an occupied rail.
export function minRails(rack) {
  return Math.max(1, ...rack.modules.map(m => m.rail + 1), 1)
}

export function tidyRack(rack, registry) {
  const hpById = new Map()
  for (let rail = 0; rail < rack.rails; rail++) {
    for (const { id, hp } of packRail(rack, registry, rail)) {
      hpById.set(id, hp)
    }
  }
  const modules = rack.modules.map(m =>
    hpById.has(m.id) ? { ...m, hp: hpById.get(m.id) } : { ...m }
  )
  return { ...rack, modules }
}
