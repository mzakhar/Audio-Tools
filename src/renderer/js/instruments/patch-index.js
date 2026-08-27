// Pure patch index: flattens packs/palettes/racks into rows and ranks a search query.
// No DOM, no globals — see specs/instrument-browser.md phase 1.

const manifestOf = pack => pack?.manifest || pack

function packRows(pack) {
  const manifest = manifestOf(pack)
  const packId = pack?.id ?? manifest?.id
  const packVersion = pack?.version ?? manifest?.version
  const patches = manifest?.patches || []
  return patches.map(patch => ({
    key: `pack:${packId}@${packVersion}:${patch.id}`,
    kind: 'pack',
    label: patch.name,
    sub: manifest?.name,
    program: patch.address?.program ?? null,
    instrument: {
      type: 'pack',
      packId,
      packVersion,
      patchId: patch.id,
      programFollow: 'pinned',
    },
  }))
}

function paletteRow(paletteKey, palette) {
  return {
    key: `palette:${paletteKey}`,
    kind: 'palette',
    label: palette?.name || paletteKey,
    sub: 'Internal',
    program: null,
    instrument: { type: 'palette', paletteKey },
  }
}

function rackRow(rackId, rack) {
  return {
    key: `rack:${rackId}`,
    kind: 'rack',
    label: rack?.name || rack?.id || rackId,
    sub: 'Rack',
    program: null,
    instrument: { type: 'rack', rackId },
  }
}

export function buildIndex({ packs = [], palettes = {}, racks = {} } = {}) {
  const rows = []
  for (const pack of packs) rows.push(...packRows(pack))
  for (const [paletteKey, palette] of Object.entries(palettes)) rows.push(paletteRow(paletteKey, palette))
  for (const [rackId, rack] of Object.entries(racks)) rows.push(rackRow(rackId, rack))
  return rows
}

const RANK = { exact: 0, prefix: 1, wordStart: 2, substring: 3, sub: 4 }

function matchClass(token, label, sub) {
  const lowerLabel = label.toLowerCase()
  const lowerSub = (sub || '').toLowerCase()
  if (lowerLabel === token) return RANK.exact
  if (lowerLabel.startsWith(token)) return RANK.prefix
  if (new RegExp(`\\b${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(lowerLabel)) return RANK.wordStart
  if (lowerLabel.includes(token)) return RANK.substring
  if (lowerSub.includes(token)) return RANK.sub
  return -1
}

function rowScore(row, tokens) {
  let worst = -1
  for (const token of tokens) {
    const cls = matchClass(token, row.label || '', row.sub || '')
    if (cls === -1) return -1
    if (cls > worst) worst = cls
  }
  return worst
}

export function searchIndex(index, query, { scope = 'all', favourites = [], recent = [] } = {}) {
  const scoped = scope === 'all' ? index : index.filter(row => row.kind === scope)
  const trimmed = (query || '').trim()

  if (!trimmed) {
    const seen = new Set()
    const ordered = []
    const byKey = new Map(scoped.map(row => [row.key, row]))
    for (const key of favourites) {
      const row = byKey.get(key)
      if (row && !seen.has(key)) { ordered.push(row); seen.add(key) }
    }
    for (const key of recent) {
      const row = byKey.get(key)
      if (row && !seen.has(key)) { ordered.push(row); seen.add(key) }
    }
    for (const row of scoped) {
      if (!seen.has(row.key)) { ordered.push(row); seen.add(row.key) }
    }
    return ordered
  }

  const tokens = trimmed.toLowerCase().split(/\s+/).filter(Boolean)
  const scored = []
  for (const row of scoped) {
    const score = rowScore(row, tokens)
    if (score !== -1) scored.push({ row, score })
  }
  scored.sort((a, b) => {
    if (a.score !== b.score) return a.score - b.score
    const progA = a.row.program ?? Infinity
    const progB = b.row.program ?? Infinity
    if (progA !== progB) return progA - progB
    return (a.row.label || '').localeCompare(b.row.label || '')
  })
  return scored.map(entry => entry.row)
}
