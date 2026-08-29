// pack-store-idb.js — browser-side instrument pack storage.
//
// The Electron build keeps packs on disk under userData; a plain browser build
// keeps the same manifests and WAV bytes in IndexedDB. Both return the shape
// `listInstrumentPacks()` returns, so the catalog never learns where a pack
// came from.

import { validatePackManifest } from './pack-registry.js'

const DB_NAME = 'synth-instrument-packs'
const DB_VERSION = 1
const PACKS = 'packs'
const SAMPLES = 'samples'

const packKey = (id, version) => `${id}@${version}`
const sampleKey = (id, version, sampleId) => `${packKey(id, version)}/${sampleId}`

/** Shared with the folder library, which keeps its own database, not its own plumbing. */
export const request = req => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result)
  req.onerror = () => reject(req.error || new Error('IndexedDB request failed'))
})

export const done = tx => new Promise((resolve, reject) => {
  tx.oncomplete = () => resolve()
  tx.onabort = tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'))
})

/** Quota is the one failure a user can actually act on, so say so. */
function storageError(error) {
  if (error?.name === 'QuotaExceededError') {
    return new Error('Not enough browser storage for this pack. Remove an installed pack, free space, or use the desktop app.')
  }
  return error instanceof Error ? error : new Error(String(error))
}

const bytesOf = value => value?.byteLength ?? 0
const toBuffer = value => value instanceof ArrayBuffer
  ? value
  : (ArrayBuffer.isView(value) ? value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) : null)

/** importSf2 emits `[{ id, wav }]`; callers may also pass `{ sampleId: bytes }`. */
function sampleEntries(samples) {
  const raw = Array.isArray(samples) ? samples.map(item => [item.id, item.wav]) : Object.entries(samples || {})
  return raw.map(([id, value]) => {
    const buffer = toBuffer(value)
    if (!id || !buffer) throw new TypeError(`Sample ${id} is not audio bytes`)
    return [id, buffer]
  })
}

/**
 * Append the patches of a per-preset import to a pack that already exists.
 * Behaviourally identical to the Electron `mergeIntoPack`: patches merge by id,
 * re-importing a preset changes nothing, and the defaults always name a patch
 * that is present. Returns null when there is nothing to add.
 */
function mergeManifests(existing, incoming) {
  const present = new Set(existing.patches.map(patch => patch.id))
  const added = incoming.patches.filter(patch => !present.has(patch.id))
  if (!added.length) return null
  const merged = { ...existing, patches: [...existing.patches, ...added] }
  const ids = new Set(merged.patches.map(patch => patch.id))
  if (!ids.has(merged.defaultPatchId)) merged.defaultPatchId = merged.patches[0].id
  if (!merged.defaultDrumPatchId || !ids.has(merged.defaultDrumPatchId)) {
    const drum = incoming.defaultDrumPatchId
    if (drum && ids.has(drum)) merged.defaultDrumPatchId = drum
    else delete merged.defaultDrumPatchId
  }
  return merged
}

export function createPackStore({ idb = typeof indexedDB === 'undefined' ? null : indexedDB } = {}) {
  if (!idb) throw new TypeError('createPackStore needs an IndexedDB factory')
  let open = null

  const db = () => (open ||= request(Object.assign(idb.open(DB_NAME, DB_VERSION), {
    onupgradeneeded: event => {
      const database = event.target.result
      if (!database.objectStoreNames.contains(PACKS)) database.createObjectStore(PACKS)
      if (!database.objectStoreNames.contains(SAMPLES)) database.createObjectStore(SAMPLES)
    }
  })).catch(error => { open = null; throw storageError(error) }))

  return {
    /** Replace any previous copy of this exact id@version. */
    async savePack(manifest, samples) {
      const validation = validatePackManifest(manifest)
      if (!validation.ok) throw new Error(`Converted pack is invalid: ${validation.errors.join('; ')}`)
      const entries = sampleEntries(samples)
      const bytes = entries.reduce((total, [, buffer]) => total + bytesOf(buffer), 0)
      const record = { id: manifest.id, version: manifest.version, manifest, bytes, sampleIds: entries.map(([id]) => id) }
      const database = await db()
      try {
        const tx = database.transaction([PACKS, SAMPLES], 'readwrite')
        const packs = tx.objectStore(PACKS), store = tx.objectStore(SAMPLES)
        packs.put(record, packKey(manifest.id, manifest.version))
        for (const [id, buffer] of entries) store.put(buffer, sampleKey(manifest.id, manifest.version, id))
        await done(tx)
      } catch (error) { throw storageError(error) }
      return { id: record.id, version: record.version, manifest, bytes }
    },

    /**
     * Per-preset import: merge into the pack of the same id@version, or create
     * it. One transaction covers samples and manifest, so unlike the Electron
     * path there is no write order to get right — IndexedDB commits both or
     * neither.
     */
    async appendPack(manifest, samples) {
      const key = packKey(manifest.id, manifest.version)
      const database = await db()
      const existing = await request(database.transaction(PACKS, 'readonly').objectStore(PACKS).get(key))
      if (!existing?.manifest) return this.savePack(manifest, samples)
      const merged = mergeManifests(existing.manifest, manifest)
      if (!merged) return { id: existing.id, version: existing.version, manifest: existing.manifest, bytes: existing.bytes || 0 }
      const validation = validatePackManifest(merged)
      if (!validation.ok) throw new Error(`Merged pack is invalid: ${validation.errors.join('; ')}`)
      const entries = sampleEntries(samples)
      const bytes = (existing.bytes || 0) + entries.reduce((total, [, buffer]) => total + bytesOf(buffer), 0)
      const record = {
        id: existing.id,
        version: existing.version,
        manifest: merged,
        bytes,
        sampleIds: [...new Set([...(existing.sampleIds || []), ...entries.map(([id]) => id)])]
      }
      try {
        const tx = database.transaction([PACKS, SAMPLES], 'readwrite')
        const store = tx.objectStore(SAMPLES)
        tx.objectStore(PACKS).put(record, key)
        for (const [id, buffer] of entries) store.put(buffer, sampleKey(manifest.id, manifest.version, id))
        await done(tx)
      } catch (error) { throw storageError(error) }
      return { id: record.id, version: record.version, manifest: merged, bytes }
    },

    /** Only valid packs; corrupt storage stays invisible rather than crashing the catalog. */
    async listPacks() {
      const database = await db()
      const records = await request(database.transaction(PACKS, 'readonly').objectStore(PACKS).getAll())
      return records
        .filter(record => record?.manifest && validatePackManifest(record.manifest).ok
          && record.manifest.id === record.id && record.manifest.version === record.version)
        .map(record => ({ id: record.id, version: record.version, manifest: record.manifest, bytes: record.bytes || 0 }))
        .sort((a, b) => a.id.localeCompare(b.id) || a.version.localeCompare(b.version))
    },

    async readSample(packId, version, sampleId) {
      const database = await db()
      const buffer = await request(database.transaction(SAMPLES, 'readonly').objectStore(SAMPLES).get(sampleKey(packId, version, sampleId)))
      if (!buffer) throw new Error(`Sample unavailable: ${sampleId}`)
      return toBuffer(buffer)
    },

    async removePack(packId, version) {
      const database = await db()
      const key = packKey(packId, version)
      const record = await request(database.transaction(PACKS, 'readonly').objectStore(PACKS).get(key))
      const ids = record?.sampleIds || []
      const tx = database.transaction([PACKS, SAMPLES], 'readwrite')
      tx.objectStore(PACKS).delete(key)
      for (const id of ids) tx.objectStore(SAMPLES).delete(sampleKey(packId, version, id))
      await done(tx)
      return !!record
    },

    /** Bytes we actually wrote; the browser estimate is advisory only. */
    async usage() {
      const packs = await this.listPacks()
      const bytes = packs.reduce((total, pack) => total + (pack.bytes || 0), 0)
      let quota = null
      try { quota = (await navigator.storage.estimate()).quota ?? null } catch { /* Not available everywhere. */ }
      return { bytes, packs: packs.length, quota }
    }
  }
}
