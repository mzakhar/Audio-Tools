// Firmware catalog: pure parse / reconcile / library-row logic. No IO, no fetch.
// A catalog is metadata only; installed packages (sha256:<hex>) are never part of it.

export const CATALOG_SCHEMA = 'synth-fm1-catalog@1'
export const MAX_CATALOG_CHARS = 2 * 1024 * 1024
export const MAX_ENTRIES = 5000

const ID_RE = /^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)?$/
const CATALOG_ID_RE = /^[a-z0-9][a-z0-9._-]*$/
const VERSION_RE = /^\d{4}-\d{2}-\d{2}([T ][0-9:.]+Z?)?$/
const SHA_RE = /^[0-9a-f]{64}$/
const STATUSES = ['tested', 'upstream-ok', 'untested', 'broken']
const DISTRIBUTIONS = ['obtain-separately', 'bundled', 'byo']
const fail = reason => ({ ok: false, reason })

const str = (v, cap) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, cap) : null)
const url = v => {
  const s = str(v, 500)
  if (!s) return null
  try {
    const u = new URL(s)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null
  } catch { return null }
}
const int = (v, lo, hi) => (Number.isInteger(v) && v >= lo && v <= hi ? v : null)
const isObj = v => v && typeof v === 'object' && !Array.isArray(v)

function normalizeEntry(e) {
  if (!isObj(e) || typeof e.id !== 'string' || !ID_RE.test(e.id)) return null
  const name = str(e.name, 80)
  if (!name) return null
  const c = isObj(e.compat) ? e.compat : {}
  const sha = typeof e.sha256 === 'string' ? e.sha256.toLowerCase() : null
  return {
    id: e.id,
    name,
    author: str(e.author, 80),
    version: str(e.version, 40),
    target: str(e.target, 20) ?? 'FM-1',
    description: str(e.description, 300),
    sourceUrl: url(e.sourceUrl),
    licenseId: str(e.licenseId, 80),
    licenseUrl: url(e.licenseUrl),
    packageUrl: url(e.packageUrl),
    sha256: sha && SHA_RE.test(sha) ? sha : null,
    size: int(e.size, 0, 8 * 1024 * 1024),
    distribution: DISTRIBUTIONS.includes(e.distribution) ? e.distribution : 'obtain-separately',
    compat: {
      status: STATUSES.includes(c.status) ? c.status : 'untested',
      by: str(c.by, 80),
      date: str(c.date, 40),
      note: str(c.note, 200),
      minMhz: int(c.minMhz, 1, 2000)
    },
    defaultMidiChannel: int(e.defaultMidiChannel, 0, 15)
  }
}

/** @returns {{ok:true, catalog:object}|{ok:false, reason:string}} */
export function parseCatalog(text) {
  if (typeof text !== 'string') return fail('bad-json')
  if (text.length > MAX_CATALOG_CHARS) return fail('too-large')
  let j
  try { j = JSON.parse(text) } catch { return fail('bad-json') }
  if (!isObj(j) || j.schema !== CATALOG_SCHEMA) return fail('bad-schema')
  if (typeof j.catalogId !== 'string' || !CATALOG_ID_RE.test(j.catalogId) || j.catalogId.length > 40) return fail('bad-catalog-id')
  const version = str(j.version, 40)
  if (!version || !VERSION_RE.test(version)) return fail('bad-version')
  if (!Array.isArray(j.entries) || j.entries.length > MAX_ENTRIES) return fail('bad-entries')

  const byId = new Map()
  let skipped = 0
  for (const raw of j.entries) {
    const e = normalizeEntry(raw)
    if (!e) { skipped++; continue }
    const prev = byId.get(e.id)
    if (prev && JSON.stringify(prev) !== JSON.stringify(e)) return fail('duplicate-id')
    byId.set(e.id, e)
  }

  const removed = Array.isArray(j.removed)
    ? [...new Set(j.removed.filter(r => typeof r === 'string' && ID_RE.test(r)).slice(0, MAX_ENTRIES))]
    : []
  const attribution = (Array.isArray(j.attribution) ? j.attribution : []).filter(isObj).slice(0, 20).map(a => ({
    name: str(a.name, 80), url: url(a.url), license: str(a.license, 40), copyright: str(a.copyright, 120)
  }))
  return {
    ok: true,
    skipped,
    catalog: {
      schema: CATALOG_SCHEMA, catalogId: j.catalogId, version, generatedAt: str(j.generatedAt, 40),
      attribution, entries: [...byId.values()], removed
    }
  }
}

/**
 * Replace the stored catalog of the same catalogId with `incoming`.
 * Version compare is plain string order (ISO dates); equal versions are accepted (re-import).
 * @returns {{ok:true, catalog, added:number, updated:number, removed:number}|{ok:false, reason:'older'|'other-catalog'}}
 */
export function reconcileCatalog(stored, incoming) {
  const gone = new Set(incoming.removed ?? [])
  const entries = incoming.entries.filter(e => !gone.has(e.id))
  const catalog = { ...incoming, entries }
  if (!stored) return { ok: true, catalog, added: entries.length, updated: 0, removed: 0 }
  if (stored.catalogId !== incoming.catalogId) return fail('other-catalog')
  if (incoming.version < stored.version) return fail('older')
  const old = new Map(stored.entries.map(e => [e.id, e]))
  let added = 0
  let updated = 0
  for (const e of entries) {
    const o = old.get(e.id)
    if (!o) added++
    else if (JSON.stringify(o) !== JSON.stringify(e)) updated++
  }
  const keep = new Set(entries.map(e => e.id))
  const removed = stored.entries.filter(e => !keep.has(e.id)).length
  return { ok: true, catalog, added, updated, removed }
}

/** Installed first, then by name. Installed records match catalog entries by sha256 (first catalog wins). */
export function libraryRows({ catalogs, installed }) {
  const bySha = new Map(installed.map(r => [r.sha256, r]))
  const claimed = new Set()
  const rows = []
  const seen = new Set()
  for (const cat of catalogs) {
    for (const e of cat.entries) {
      const rec = e.sha256 && !claimed.has(e.sha256) ? bySha.get(e.sha256)
        : installed.find(r => r.catalogId === cat.catalogId && r.entryId === e.id && !claimed.has(r.sha256))
      if (rec) claimed.add(rec.sha256)
      const broken = e.compat.status === 'broken'
      const key = rec ? rec.id : `cat:${cat.catalogId}:${e.id}`
      if (seen.has(key)) continue // first wins; keys must be unique in the DOM
      seen.add(key)
      rows.push({
        key,
        name: e.name, author: e.author, version: e.version, target: e.target, description: e.description,
        licenseId: e.licenseId, sourceUrl: e.sourceUrl, packageUrl: e.packageUrl, sha256: e.sha256,
        catalogId: cat.catalogId, entryId: e.id, unverifiedDownload: !!rec?.unverifiedDownload,
        installed: !!rec, origin: 'catalog',
        status: rec ? `installed-${e.compat.status}` : broken ? 'broken' : 'available',
        compat: e.compat,
        ...(rec ? { installedId: rec.id } : {})
      })
    }
  }
  for (const rec of installed) {
    if (claimed.has(rec.sha256)) continue
    rows.push({
      key: rec.id, name: rec.name, author: null, version: null, target: rec.target, description: null,
      licenseId: null, sourceUrl: null, packageUrl: null, sha256: rec.sha256,
      installed: true, origin: 'user', status: 'installed-untested', compat: null, installedId: rec.id
    })
  }
  return rows.sort((a, b) =>
    (b.installed - a.installed) || a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
}

export function filterRows(rows, query) {
  const q = (query ?? '').trim().toLowerCase()
  if (!q) return rows
  return rows.filter(r => [r.name, r.author, r.description, r.licenseId, r.version].some(f => f && f.toLowerCase().includes(q)))
}

const LABELS = {
  'installed-tested': 'Tested',
  'installed-upstream-ok': 'Runs upstream',
  'installed-untested': 'Untested',
  'installed-broken': 'Known broken',
  broken: 'Known broken',
  available: 'Not installed'
}
export const statusLabel = status => LABELS[status] ?? 'Untested'
