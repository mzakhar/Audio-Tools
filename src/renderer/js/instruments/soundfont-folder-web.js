// soundfont-folder-web.js — the browser half of a registered SoundFont folder.
//
// The Electron half (src/main/soundfont-folders.js) registers a path; here the
// user grants a FileSystemDirectoryHandle, which IndexedDB stores natively
// through structured clone, so a folder survives a reload. Same index, same
// per-preset import, same cache keyed on name + size + lastModified.
//
// File System Access is secure-context only — it exists on
// https://synth.zakharhome.org and nowhere else we ship (not in Electron's
// renderer, not on the plain-http LAN route). canBrowseFolders() gates the
// entry point exactly as AudioEngine.hasRecorder() gates the worklet recorder,
// and nothing else may depend on this module.

import { readBankIndex, withDisplayTitles } from '../../../shared/sf2-index.js'
import { MAX_SF2_BYTES, parseInWorker } from './pack-import-web.js'
import { done, request } from './pack-store-idb.js'

const DB_NAME = 'synth-soundfont-folders'
const DB_VERSION = 1
const FOLDERS = 'folders'
const BANKS = 'banks'
const BANK_EXT = /\.sf[23]$/i

/** Feature detection only — never call the picker to find out whether it works. */
export function canBrowseFolders() {
  return typeof globalThis.showDirectoryPicker === 'function' && typeof indexedDB !== 'undefined'
}

/**
 * A denied, revoked or dead handle is an absent folder, not an error: the user
 * closed the browser and that is normal. `prompt` may only be true inside a
 * user gesture, which is why nothing here runs at module load or boot.
 */
async function readable(handle, prompt = false) {
  try {
    if (typeof handle?.queryPermission !== 'function') return !!handle
    if (await handle.queryPermission({ mode: 'read' }) === 'granted') return true
    if (!prompt || typeof handle.requestPermission !== 'function') return false
    return await handle.requestPermission({ mode: 'read' }) === 'granted'
  } catch {
    return false
  }
}

/** ponytail: non-recursive, mirroring the Electron scan — real collections are one flat folder. */
async function bankFiles(dirHandle) {
  const found = []
  for await (const handle of dirHandle.values()) {
    if (handle.kind === 'file' && BANK_EXT.test(handle.name)) found.push(handle)
  }
  return found
}

async function indexBank(path, folder, handle) {
  const file = await handle.getFile()
  // Chunk headers and pdta only: sdta is walked past on its declared size, so
  // indexing a 1.9 GB bank costs a few kilobytes of slices.
  const read = async (offset, length) => new Uint8Array(await file.slice(offset, offset + length).arrayBuffer())
  const { title, info, presets } = await readBankIndex(read, { fileName: handle.name, byteLength: file.size })
  return { path, folder: folder.id, folderName: folder.name, fileName: handle.name, size: file.size, mtimeMs: file.lastModified, title, info, presets }
}


/** Readable, stable and unique across registered folders; also the row-path prefix. */
function folderId(name, taken) {
  const base = String(name || 'folder').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'folder'
  let id = base
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`
  return id
}

export function createFolderLibrary({
  idb = typeof indexedDB === 'undefined' ? null : indexedDB,
  packStore = null,
  pickDirectory = () => globalThis.showDirectoryPicker({ mode: 'read' }),
  parse = parseInWorker
} = {}) {
  if (!idb) throw new TypeError('createFolderLibrary needs an IndexedDB factory')
  let open = null

  const db = () => (open ||= request(Object.assign(idb.open(DB_NAME, DB_VERSION), {
    onupgradeneeded: event => {
      const database = event.target.result
      if (!database.objectStoreNames.contains(FOLDERS)) database.createObjectStore(FOLDERS)
      if (!database.objectStoreNames.contains(BANKS)) database.createObjectStore(BANKS)
    }
  })).catch(error => { open = null; throw error }))

  const all = (database, store) => request(database.transaction(store, 'readonly').objectStore(store).getAll())
  const one = (database, store, key) => request(database.transaction(store, 'readonly').objectStore(store).get(key))

  return {
    /** `[{ id, name, granted }]` — `granted` is a query, never a prompt. */
    async listFolders() {
      const folders = await all(await db(), FOLDERS)
      const listed = []
      for (const folder of folders) listed.push({ id: folder.id, name: folder.name, granted: await readable(folder.handle) })
      return listed
    },

    /** Must be called from a user gesture. Returns null when the picker is cancelled. */
    async addFolder() {
      let handle = null
      try { handle = await pickDirectory() } catch (error) {
        if (error?.name === 'AbortError') return null
        throw error
      }
      if (!handle) return null
      const database = await db()
      const folders = await all(database, FOLDERS)
      for (const folder of folders) {
        if (folder.handle && await folder.handle.isSameEntry?.(handle)) return this.listFolders()
      }
      const id = folderId(handle.name, new Set(folders.map(folder => folder.id)))
      const tx = database.transaction(FOLDERS, 'readwrite')
      tx.objectStore(FOLDERS).put({ id, name: handle.name, handle }, id)
      await done(tx)
      return this.listFolders()
    },

    /** Re-prompt for a folder whose permission lapsed. User gesture only. */
    async requestAccess(id) {
      const folder = await one(await db(), FOLDERS, String(id))
      return folder ? readable(folder.handle, true) : false
    },

    async removeFolder(id) {
      const database = await db()
      const key = String(id)
      const stale = (await all(database, BANKS)).filter(row => row.folder === key)
      const tx = database.transaction([FOLDERS, BANKS], 'readwrite')
      tx.objectStore(FOLDERS).delete(key)
      for (const row of stale) tx.objectStore(BANKS).delete(row.path)
      await done(tx)
      return this.listFolders()
    },

    /**
     * Index every bank in every readable folder, reusing cached rows whose size
     * and lastModified still match. A bank that fails to index is counted and
     * skipped — the collection holds malformed files and one must not cost you
     * the other 494.
     */
    async scan() {
      const database = await db()
      const registered = await all(database, FOLDERS)
      const cached = new Map((await all(database, BANKS)).map(row => [row.path, row]))
      const folders = [], banks = [], fresh = [], scanned = new Set()
      let skipped = 0
      for (const folder of registered) {
        const granted = await readable(folder.handle)
        folders.push({ id: folder.id, name: folder.name, granted })
        // No permission is the reload default, so leave that folder's cached
        // rows alone rather than throwing the index away every startup.
        if (!granted) continue
        let entries
        try { entries = await bankFiles(folder.handle) } catch { continue }
        scanned.add(folder.id)
        for (const handle of entries) {
          const path = `${folder.id}/${handle.name}`
          try {
            const hit = cached.get(path)
            const file = hit ? await handle.getFile() : null
            const row = hit && hit.size === file.size && hit.mtimeMs === file.lastModified
              ? hit
              : await indexBank(path, folder, handle)
            banks.push(row)
            if (row !== hit) fresh.push(row)
          } catch {
            skipped++
          }
        }
      }
      const live = new Set(banks.map(row => row.path))
      const ids = new Set(registered.map(folder => folder.id))
      const drop = [...cached.values()].filter(row => !ids.has(row.folder) || (scanned.has(row.folder) && !live.has(row.path)))
      if (fresh.length || drop.length) {
        const tx = database.transaction(BANKS, 'readwrite')
        const store = tx.objectStore(BANKS)
        for (const row of drop) store.delete(row.path)
        for (const row of fresh) store.put(row, row.path)
        await done(tx)
      }
      const rows = withDisplayTitles(banks)
      return { folders, banks: rows.sort((a, b) => a.title.localeCompare(b.title) || a.path.localeCompare(b.path)), skipped }
    },

    /**
     * Convert one preset of an indexed bank into that bank's pack, appending to
     * it if it exists. `presetIndex` is the position in the row's `presets`
     * array, which is the phdr index — never sort or filter that array.
     */
    async importPreset(bankPath, presetIndex, { onProgress = () => {} } = {}) {
      if (!packStore) throw new Error('This browser cannot store instrument packs (IndexedDB is unavailable).')
      if (!Number.isInteger(presetIndex) || presetIndex < 0) throw new Error('Invalid preset index')
      const database = await db()
      const row = await one(database, BANKS, String(bankPath))
      if (!row) throw new Error('That SoundFont is not in a registered folder')
      const folder = await one(database, FOLDERS, row.folder)
      // Importing is a user gesture, so this is where a lapsed permission is re-asked.
      if (!folder || !await readable(folder.handle, true)) throw new Error('Grant access to that folder again to import from it')

      onProgress({ stage: 'reading', name: row.fileName })
      const file = await (await folder.handle.getFileHandle(row.fileName)).getFile()
      if (file.size > MAX_SF2_BYTES) {
        throw new Error(`That SoundFont is ${Math.round(file.size / 1048576)} MB. The browser build accepts up to ${MAX_SF2_BYTES / 1048576} MB — use the desktop app for larger files.`)
      }
      const bytes = await file.arrayBuffer()

      onProgress({ stage: 'parsing', name: row.fileName })
      const { manifest, samples } = await parse(bytes, row.fileName.replace(BANK_EXT, ''), [presetIndex])

      onProgress({ stage: 'storing', name: row.fileName })
      const saved = await packStore.appendPack(manifest, samples)
      onProgress({ stage: 'done', name: row.fileName })
      return saved
    }
  }
}
