// user-samples.js — user-dropped audio, kept in IndexedDB (works on the LAN
// http route and in Electron; no secure-context API). Key = content hash, so
// the same file dropped twice is stored once. Project files reference only the
// id: samples do not travel with a saved project (a missing one plays silent).

import { createSampleStore } from './sample-store.js'
import { request, done } from './pack-store-idb.js'

const DB_NAME = 'synth-user-samples'
const STORE = 'samples'

/** `smp-<64-bit hex>-<byteLength>` (two independent FNV-1a passes) — PURE, no crypto.subtle (absent on plain http). */
export function sampleIdOf(bytes) {
  const view = new Uint8Array(bytes)
  let a = 0x811c9dc5, b = 0x9747b28c
  for (let i = 0; i < view.length; i++) {
    a = Math.imul(a ^ view[i], 0x01000193)
    b = Math.imul(b ^ view[i] ^ (i & 0xff), 0x85ebca6b) ^ (b >>> 15)
  }
  const hex = n => (n >>> 0).toString(16).padStart(8, '0')
  return `smp-${hex(a)}${hex(b)}-${view.length}`
}

export function createUserSamples({ idb = globalThis.indexedDB } = {}) {
  let open = null
  const db = () => (open ||= request(Object.assign(idb.open(DB_NAME, 1), {
    onupgradeneeded: event => {
      const database = event.target.result
      if (!database.objectStoreNames.contains(STORE)) database.createObjectStore(STORE)
    }
  })).catch(error => { open = null; throw error }))
  const get = async id => request((await db()).transaction(STORE, 'readonly').objectStore(STORE).get(id))

  return {
    async put({ name, type, bytes }) {
      if (!idb) throw new Error('no-storage')
      const id = sampleIdOf(bytes)
      if (await this.has(id)) return { id, name }
      const tx = (await db()).transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put({ bytes, name, type }, id)
      await done(tx)
      return { id, name }
    },
    async read(id) {
      if (!idb) return null
      return (await get(id))?.bytes ?? null
    },
    async has(id) {
      if (!idb) return false
      return !!(await get(id))
    }
  }
}

let shared
const stores = new WeakMap()

/** Decoded-sample cache for one ctx (live and offline contexts decode at their own rate). */
export function userSampleStoreFor(ctx) {
  if (!ctx?.decodeAudioData) return null
  let store = stores.get(ctx)
  if (!store) {
    const samples = (shared ||= createUserSamples())
    store = createSampleStore({
      ctx,
      load: async id => {
        const bytes = await samples.read(id)
        if (!bytes) throw new Error(`Sample unavailable: ${id}`)
        return bytes.slice(0) // decodeAudioData detaches its input
      }
    })
    stores.set(ctx, store)
  }
  return store
}
