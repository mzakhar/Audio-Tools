// firmware-store.js — installed FM-1 firmware packages and imported catalogs.
//
// One IndexedDB database, in the Electron renderer and the browser alike (it
// works on the plain-http LAN route). Identity is `sha256:<hex>` of the exact
// file bytes, and the bytes are stored unchanged. Pure parse/hash come in as
// arguments; this file is only the IO edge.

import { request, done } from '../instruments/pack-store-idb.js'
import { sha256Hex } from './sha256.js'
import { parseFwsc } from './fwsc.js'

const DB_NAME = 'synth-fm1-firmware'
const DB_VERSION = 1
const PACKAGES = 'packages'
const INSTALLED = 'installed'
const CATALOGS = 'catalogs'

export function createFirmwareStore({ idb = globalThis.indexedDB, hash = sha256Hex, parse = parseFwsc, now = Date.now } = {}) {
  let opened = null
  const db = () => opened ??= new Promise((resolve, reject) => {
    const req = idb.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const d = req.result
      for (const name of [PACKAGES, INSTALLED, CATALOGS]) if (!d.objectStoreNames.contains(name)) d.createObjectStore(name)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => { opened = null; reject(req.error || new Error('IndexedDB open failed')) }
  })

  return {
    async install({ name, bytes }) {
      if (!idb) return { ok: false, reason: 'no-storage' }
      try {
        const u8 = new Uint8Array(bytes)
        // parseFwsc owns the 960 B .. 8 MiB bound, and runs before any hashing.
        const parsed = parse(u8)
        if (!parsed.ok) return { ok: false, reason: parsed.reason, ...(parsed.identity ? { identity: parsed.identity } : {}) }
        const sha256 = hash(u8)
        const id = `sha256:${sha256}`
        const fileName = String(name ?? '')
        const record = {
          id, sha256, fileName, name: fileName.replace(/\.fwsc$/i, ''),
          identity: parsed.identity, target: parsed.target, product: parsed.product,
          size: u8.byteLength, importedAt: now()
        }
        const tx = (await db()).transaction([PACKAGES, INSTALLED], 'readwrite')
        const finished = done(tx)
        finished.catch(() => {})
        const existing = await request(tx.objectStore(INSTALLED).get(id))
        if (existing) return { ok: true, id, record: existing, duplicate: true }
        tx.objectStore(PACKAGES).put(bytes, id)
        tx.objectStore(INSTALLED).put(record, id)
        await finished
        return { ok: true, id, record, duplicate: false }
      } catch (e) {
        return { ok: false, reason: e?.name === 'QuotaExceededError' ? 'quota' : 'storage-error' }
      }
    },

    async list() {
      if (!idb) return []
      return request((await db()).transaction(INSTALLED).objectStore(INSTALLED).getAll())
    },

    async read(id) {
      if (!idb) return null
      return (await request((await db()).transaction(PACKAGES).objectStore(PACKAGES).get(id))) ?? null
    },

    async remove(id) {
      if (!idb) return false
      const tx = (await db()).transaction([PACKAGES, INSTALLED], 'readwrite')
      const finished = done(tx)
      const had = await request(tx.objectStore(INSTALLED).get(id))
      tx.objectStore(PACKAGES).delete(id)
      tx.objectStore(INSTALLED).delete(id)
      await finished
      return !!had
    },

    async getCatalogs() {
      if (!idb) return []
      return request((await db()).transaction(CATALOGS).objectStore(CATALOGS).getAll())
    },

    async putCatalog(catalog) {
      if (!idb) throw new Error('no-storage')
      const tx = (await db()).transaction(CATALOGS, 'readwrite')
      const finished = done(tx)
      tx.objectStore(CATALOGS).put(catalog, catalog.catalogId)
      await finished
    }
  }
}
