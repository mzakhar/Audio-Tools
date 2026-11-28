import { describe, it, expect } from 'vitest'
import seedText from '../src/renderer/js/fm1/seed-catalog.json?raw'
import {
  CATALOG_SCHEMA, parseCatalog, reconcileCatalog, libraryRows, filterRows, statusLabel
} from '../src/renderer/js/fm1/catalog.js'

const SHA = c => c.repeat(64)
const entry = (id, extra = {}) => ({ id, name: id.split('/').pop(), ...extra })
const file = (over = {}) => JSON.stringify({ schema: CATALOG_SCHEMA, catalogId: 'pub', version: '2026-01-01', entries: [entry('a/one')], ...over })
const parse = (over, entries) => parseCatalog(file(entries ? { entries, ...over } : over))
const cat = (entries, over = {}) => parseCatalog(file({ entries, ...over })).catalog

describe('parseCatalog', () => {
  it('accepts a minimal file and fills defaults', () => {
    const r = parse()
    expect(r.ok).toBe(true)
    expect(r.catalog.entries[0]).toMatchObject({
      id: 'a/one', name: 'one', target: 'FM-1', sha256: null, distribution: 'obtain-separately',
      compat: { status: 'untested', minMhz: null }
    })
  })

  it('rejects structural problems', () => {
    expect(parseCatalog('{').reason).toBe('bad-json')
    expect(parseCatalog(5).reason).toBe('bad-json')
    expect(parse({ schema: 'x' }).reason).toBe('bad-schema')
    expect(parse({ catalogId: 'Bad Id' }).reason).toBe('bad-catalog-id')
    expect(parse({ version: '' }).reason).toBe('bad-version')
    expect(parse({ entries: 'no' }).reason).toBe('bad-entries')
    expect(parse({}, [entry('BAD')]).reason).toBe('bad-entry')
    expect(parse({}, [entry('a/b/c')]).reason).toBe('bad-entry')
    expect(parse({}, [{ id: 'a/x' }]).reason).toBe('bad-entry')
    expect(parse({}, [5]).reason).toBe('bad-entry')
  })

  it('enforces size and entry-count limits', () => {
    expect(parseCatalog(' '.repeat(2 * 1024 * 1024 + 1)).reason).toBe('too-large')
    const many = Array.from({ length: 5001 }, (_, i) => entry(`p/e${i}`))
    expect(parse({}, many).reason).toBe('bad-entries')
    expect(parse({}, many.slice(0, 5000)).ok).toBe(true)
  })

  it('caps strings and validates URLs, hashes and enums', () => {
    const e = entry('p/x', {
      name: 'n'.repeat(200), description: 'd'.repeat(500), author: 'a'.repeat(200), version: 'v'.repeat(100),
      sourceUrl: 'https://example.com/a', packageUrl: 'javascript:alert(1)', licenseUrl: 'ftp://x/y',
      sha256: 'ABC', size: -3, distribution: 'weird', compat: { status: 'great', note: 'x'.repeat(500), minMhz: 'fast' }
    })
    const got = parse({}, [e]).catalog.entries[0]
    expect(got.name).toHaveLength(80)
    expect(got.description).toHaveLength(300)
    expect(got.author).toHaveLength(80)
    expect(got.version).toHaveLength(40)
    expect(got.sourceUrl).toBe('https://example.com/a')
    expect(got.packageUrl).toBeNull()
    expect(got.licenseUrl).toBeNull()
    expect(got.sha256).toBeNull()
    expect(got.size).toBeNull()
    expect(got.distribution).toBe('obtain-separately')
    expect(got.compat).toMatchObject({ status: 'untested', minMhz: null })
    expect(got.compat.note).toHaveLength(200)
    expect(parse({}, [entry('p/y', { sha256: SHA('A') })]).catalog.entries[0].sha256).toBe(SHA('a'))
  })

  it('collapses identical duplicates and rejects conflicting ones', () => {
    expect(parse({}, [entry('p/x'), entry('p/x')]).catalog.entries).toHaveLength(1)
    expect(parse({}, [entry('p/x'), entry('p/x', { name: 'other' })]).reason).toBe('duplicate-id')
  })

  it('ignores unknown fields and keeps valid tombstones only', () => {
    const r = parse({ extra: 1, removed: ['p/gone', 'BAD', 7] }, [entry('p/x', { weird: true })])
    expect(r.catalog.removed).toEqual(['p/gone'])
    expect(r.catalog.entries[0]).not.toHaveProperty('weird')
  })
})

describe('reconcileCatalog', () => {
  const stored = cat([entry('p/keep'), entry('p/change'), entry('p/drop')])

  it('adds everything when nothing is stored', () => {
    const r = reconcileCatalog(null, cat([entry('p/a'), entry('p/b')]))
    expect(r).toMatchObject({ ok: true, added: 2, updated: 0, removed: 0 })
  })

  it('reports add / update / remove', () => {
    const incoming = cat([entry('p/keep'), entry('p/change', { name: 'Changed' }), entry('p/new')], { version: '2026-02-01' })
    const r = reconcileCatalog(stored, incoming)
    expect(r).toMatchObject({ ok: true, added: 1, updated: 1, removed: 1 })
    expect(r.catalog.entries.map(e => e.id)).toEqual(['p/keep', 'p/change', 'p/new'])
  })

  it('drops tombstoned entries', () => {
    const incoming = cat([entry('p/keep'), entry('p/change'), entry('p/drop')], { removed: ['p/drop'] })
    const r = reconcileCatalog(stored, incoming)
    expect(r.removed).toBe(1)
    expect(r.catalog.entries.map(e => e.id)).not.toContain('p/drop')
  })

  it('refuses older versions and other catalogs; same version is a re-import', () => {
    expect(reconcileCatalog(stored, cat([entry('p/keep')], { version: '2025-12-31' }))).toEqual({ ok: false, reason: 'older' })
    expect(reconcileCatalog(stored, cat([entry('p/keep')], { catalogId: 'other' }))).toEqual({ ok: false, reason: 'other-catalog' })
    expect(reconcileCatalog(stored, stored)).toMatchObject({ ok: true, added: 0, updated: 0, removed: 0 })
  })
})

describe('libraryRows / filterRows', () => {
  const record = (n, sha) => ({ id: `sha256:${sha}`, sha256: sha, name: n, target: 'FM-1' })
  const seed = cat([
    entry('s/zed', { name: 'Zed', sha256: SHA('1'), compat: { status: 'tested' } }),
    entry('s/alpha', { name: 'Alpha', author: 'Ann', licenseId: 'MIT', description: 'warm pads' }),
    entry('s/bad', { name: 'Bad', compat: { status: 'broken' } })
  ], { catalogId: 'seed' })

  it('matches installed records by sha256, adds user rows, sorts installed first then name', () => {
    const rows = libraryRows({
      catalogs: [seed],
      installed: [record('zed-file', SHA('1')), record('Mine', SHA('2'))]
    })
    expect(rows.map(r => r.name)).toEqual(['Mine', 'Zed', 'Alpha', 'Bad'])
    const zed = rows.find(r => r.name === 'Zed')
    expect(zed).toMatchObject({ installed: true, origin: 'catalog', status: 'installed-tested', key: `sha256:${SHA('1')}`, installedId: `sha256:${SHA('1')}` })
    expect(rows[0]).toMatchObject({ origin: 'user', status: 'installed-untested', installed: true, sha256: SHA('2') })
    expect(rows.find(r => r.name === 'Alpha')).toMatchObject({ installed: false, status: 'available', key: 'cat:seed:s/alpha' })
    expect(rows.find(r => r.name === 'Bad').status).toBe('broken')
  })

  it('first catalog wins on sha ties', () => {
    const first = cat([entry('f/x', { name: 'First', sha256: SHA('1') })], { catalogId: 'first' })
    const rows = libraryRows({ catalogs: [first, seed], installed: [record('r', SHA('1'))] })
    expect(rows.find(r => r.name === 'First').installed).toBe(true)
    expect(rows.find(r => r.name === 'Zed').installed).toBe(false)
  })

  it('filters case-insensitively across fields', () => {
    const rows = libraryRows({ catalogs: [seed], installed: [] })
    expect(filterRows(rows, '').length).toBe(3)
    expect(filterRows(rows, 'ANN').map(r => r.name)).toEqual(['Alpha'])
    expect(filterRows(rows, 'mit').map(r => r.name)).toEqual(['Alpha'])
    expect(filterRows(rows, 'WARM').map(r => r.name)).toEqual(['Alpha'])
    expect(filterRows(rows, 'nothing')).toEqual([])
  })

  it('labels statuses', () => {
    expect(statusLabel('installed-tested')).toBe('Tested')
    expect(statusLabel('installed-upstream-ok')).toBe('Runs upstream')
    expect(statusLabel('installed-untested')).toBe('Untested')
    expect(statusLabel('installed-broken')).toBe('Known broken')
    expect(statusLabel('broken')).toBe('Known broken')
    expect(statusLabel('available')).toBe('Not installed')
  })
})

describe('seed-catalog.json', () => {
  const text = seedText
  const r = parseCatalog(text)

  it('passes parseCatalog and stays small', () => {
    expect(r.ok).toBe(true)
    expect(r.catalog.catalogId).toBe('synth-seed')
    expect(text.length).toBeLessThan(200 * 1024)
  })

  it('contains the four phase-0 tested hashes', () => {
    const tested = r.catalog.entries.filter(e => e.compat.status === 'tested').map(e => e.sha256).sort()
    expect(tested).toEqual([
      'b0446effb840740a3aa5c386ce004e79334e4f833d48d82a9eb5edbfde92ae67',
      'c68a8f295a2987f4e105e83bfe5c6472bdaa893902366efdb558fb67713ef6bb',
      'db1642b2b6fa5c2cccb11ffd13878068bb28601678d3644049f99dc40e7edb8a',
      'fdc33af18a8af69a5c4a490afe94e116a5b486608ebb0a17ecb6e539ee3c4ebe'
    ])
  })
})
