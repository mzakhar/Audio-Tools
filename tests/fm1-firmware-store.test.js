import { describe, it, expect, vi } from 'vitest'
import { fakeIdb, quotaError } from './helpers/fake-idb.js'

// L1 core modules are contract-mocked: the store only needs injected parse/hash.
vi.mock('../src/renderer/js/fm1/sha256.js', () => ({ sha256Hex: () => 'f'.repeat(64) }))
vi.mock('../src/renderer/js/fm1/fwsc.js', () => ({ parseFwsc: () => ({ ok: false, reason: 'bad-header' }), MAX_PACKAGE: 8 * 1024 * 1024 }))

const { createFirmwareStore } = await import('../src/renderer/js/fm1/firmware-store.js')

const okParse = () => ({ ok: true, identity: 'FM-1_918', target: 'FM-1', product: '918' })
const hashOf = u8 => String(u8[0]).padStart(64, '0')
const buf = (...n) => new Uint8Array(n).buffer
const make = (opts = {}) => {
  const idb = fakeIdb(opts.idbOpts)
  return { idb, store: createFirmwareStore({ idb, hash: hashOf, parse: okParse, now: () => 42, ...opts.deps }) }
}

describe('firmware store', () => {
  it('install -> list/read round trip with the exact bytes', async () => {
    const { store } = make()
    const bytes = buf(7, 1, 2)
    const r = await store.install({ name: 'Felucca.fwsc', bytes })
    expect(r.ok).toBe(true)
    expect(r.duplicate).toBe(false)
    expect(r.id).toBe(`sha256:${hashOf(new Uint8Array(bytes))}`)
    expect(r.record).toMatchObject({ fileName: 'Felucca.fwsc', name: 'Felucca', identity: 'FM-1_918', target: 'FM-1', product: '918', size: 3, importedAt: 42 })
    expect(await store.list()).toEqual([r.record])
    expect(await store.read(r.id)).toBe(bytes)
    expect(await store.read('sha256:nope')).toBeNull()
  })

  it('duplicate install is idempotent and writes nothing', async () => {
    const { store, idb } = make()
    const a = await store.install({ name: 'a.fwsc', bytes: buf(7) })
    const b = await store.install({ name: 'renamed.fwsc', bytes: buf(7) })
    expect(b).toMatchObject({ ok: true, duplicate: true, id: a.id })
    expect(b.record.fileName).toBe('a.fwsc')
    expect(idb.data.get('installed').size).toBe(1)
    expect(idb.data.get('packages').size).toBe(1)
  })

  it('remove deletes both stores', async () => {
    const { store, idb } = make()
    const { id } = await store.install({ name: 'a.fwsc', bytes: buf(7) })
    expect(await store.remove(id)).toBe(true)
    expect(await store.remove(id)).toBe(false)
    expect(await store.list()).toEqual([])
    expect(idb.data.get('packages').size).toBe(0)
  })

  it('an interrupted transaction leaves nothing', async () => {
    // Second write (the record) fails after the bytes were put.
    const { store, idb } = make({ idbOpts: { failOn: ({ n }) => (n === 2 ? new Error('boom') : null) } })
    expect(await store.install({ name: 'a.fwsc', bytes: buf(7) })).toEqual({ ok: false, reason: 'storage-error' })
    expect(idb.data.get('packages').size).toBe(0)
    expect(idb.data.get('installed').size).toBe(0)
  })

  it('quota error maps to quota and leaves nothing', async () => {
    const { store, idb } = make({ idbOpts: { failOn: ({ store: s }) => (s === 'installed' ? quotaError() : null) } })
    expect(await store.install({ name: 'a.fwsc', bytes: buf(7) })).toEqual({ ok: false, reason: 'quota' })
    expect(idb.data.get('packages').size).toBe(0)
  })

  it('no indexedDB -> no-storage, reads are empty, never throws', async () => {
    const store = createFirmwareStore({ idb: null, hash: hashOf, parse: okParse })
    expect(await store.install({ name: 'a.fwsc', bytes: buf(7) })).toEqual({ ok: false, reason: 'no-storage' })
    expect(await store.list()).toEqual([])
    expect(await store.read('x')).toBeNull()
    expect(await store.getCatalogs()).toEqual([])
  })

  it('a rejected package leaves the store untouched and never hashes', async () => {
    const hash = vi.fn(hashOf)
    const { store, idb } = make({ deps: { parse: () => ({ ok: false, reason: 'unsupported-target', identity: 'SMK-37 Pro_016' }), hash } })
    expect(await store.install({ name: 'x.fwsc', bytes: buf(1) })).toEqual({ ok: false, reason: 'unsupported-target', identity: 'SMK-37 Pro_016' })
    expect(hash).not.toHaveBeenCalled()
    expect((idb.data.get('installed')?.size ?? 0) + (idb.data.get('packages')?.size ?? 0)).toBe(0)
  })

  it('catalogs persist by catalogId', async () => {
    const { store } = make()
    await store.putCatalog({ catalogId: 'a', version: '1', entries: [] })
    await store.putCatalog({ catalogId: 'a', version: '2', entries: [] })
    await store.putCatalog({ catalogId: 'b', version: '1', entries: [] })
    expect((await store.getCatalogs()).map(c => `${c.catalogId}@${c.version}`).sort()).toEqual(['a@2', 'b@1'])
  })
})
