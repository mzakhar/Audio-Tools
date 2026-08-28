import { describe, expect, it } from 'vitest'
import { createPackStore } from '../src/renderer/js/instruments/pack-store-idb.js'

// Minimal in-memory IndexedDB: put/get/getAll/delete on plain Maps, requests
// and transactions settled on a microtask. Enough for this store, nothing more.
function fakeIdb({ failPut = false } = {}) {
  const stores = new Map()
  const settle = (target, run) => {
    queueMicrotask(() => {
      try { target.result = run(); target.onsuccess?.({ target }) }
      catch (error) { target.error = error; target.onerror?.({ target }) }
    })
    return target
  }
  const objectStore = name => {
    const map = stores.get(name)
    return {
      put(value, key) {
        if (failPut) { const error = new Error('quota'); error.name = 'QuotaExceededError'; throw error }
        map.set(key, value)
      },
      delete(key) { map.delete(key) },
      get(key) { return settle({}, () => map.get(key)) },
      getAll() { return settle({}, () => [...map.values()]) }
    }
  }
  const db = {
    objectStoreNames: { contains: name => stores.has(name) },
    createObjectStore(name) { stores.set(name, new Map()) },
    transaction(names, mode) {
      const tx = { objectStore, error: null }
      if (mode === 'readwrite') queueMicrotask(() => tx.oncomplete?.())
      return tx
    }
  }
  return { stores, open() { const req = {}; queueMicrotask(() => { req.result = db; req.onupgradeneeded?.({ target: req }); req.onsuccess?.({ target: req }) }); return req } }
}

const manifest = (id = 'tiny', version = '1.0.0') => ({
  schemaVersion: 1,
  id,
  version,
  name: 'Tiny',
  license: { spdx: 'LicenseRef-Imported', noticeFile: 'NOTICE.txt' },
  patches: [{ id: 'p0', name: 'Piano', kind: 'sample', address: { bankMsb: 0, bankLsb: 0, program: 0 }, zones: [{ keyLo: 0, keyHi: 127, rootKey: 60, sampleId: 's0' }] }]
})

const wav = bytes => new Uint8Array(bytes).buffer

describe('browser pack store', () => {
  it('round-trips a pack: save, list, read a sample byte-identical, usage, remove', async () => {
    const idb = fakeIdb()
    const store = createPackStore({ idb })

    await store.savePack(manifest(), [{ id: 's0', wav: wav([1, 2, 3, 4]) }])
    expect(await store.listPacks()).toEqual([{ id: 'tiny', version: '1.0.0', manifest: manifest(), bytes: 4 }])

    expect([...new Uint8Array(await store.readSample('tiny', '1.0.0', 's0'))]).toEqual([1, 2, 3, 4])
    await expect(store.readSample('tiny', '1.0.0', 'nope')).rejects.toThrow(/Sample unavailable/)

    expect(await store.usage()).toMatchObject({ bytes: 4, packs: 1 })

    expect(await store.removePack('tiny', '1.0.0')).toBe(true)
    expect(await store.listPacks()).toEqual([])
    expect(idb.stores.get('samples').size).toBe(0)
  })

  it('accepts the sampleId → bytes map shape too', async () => {
    const store = createPackStore({ idb: fakeIdb() })
    await store.savePack(manifest(), { s0: new Uint8Array([9, 9]) })
    expect([...new Uint8Array(await store.readSample('tiny', '1.0.0', 's0'))]).toEqual([9, 9])
  })

  it('never lets an invalid stored manifest reach the catalog', async () => {
    const idb = fakeIdb()
    const store = createPackStore({ idb })
    await store.savePack(manifest('good'), [{ id: 's0', wav: wav([1]) }])
    idb.stores.get('packs').set('bad@1.0.0', { id: 'bad', version: '1.0.0', manifest: { id: 'bad', patches: [] }, bytes: 0 })
    // An identity mismatch is corruption too: the key must match the manifest.
    idb.stores.get('packs').set('liar@1.0.0', { id: 'liar', version: '1.0.0', manifest: manifest('other'), bytes: 0 })

    expect((await store.listPacks()).map(pack => pack.id)).toEqual(['good'])
  })

  it('rejects a manifest that would not validate on save', async () => {
    const store = createPackStore({ idb: fakeIdb() })
    await expect(store.savePack({ id: 'x' }, [])).rejects.toThrow(/invalid/i)
  })

  it('turns a quota failure into an actionable message', async () => {
    const store = createPackStore({ idb: fakeIdb({ failPut: true }) })
    await expect(store.savePack(manifest(), [{ id: 's0', wav: wav([1]) }])).rejects.toThrow(/Not enough browser storage/)
  })
})
