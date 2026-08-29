import { afterEach, describe, expect, it } from 'vitest'
import { canBrowseFolders, createFolderLibrary } from '../src/renderer/js/instruments/soundfont-folder-web.js'
import { createPackStore } from '../src/renderer/js/instruments/pack-store-idb.js'
import { importSf2 } from '../src/shared/sf2-import.js'
import { chunk, fourCC, list, multiPresetFixture, record, str, u16, u32 } from './helpers/sf2-bytes.js'

// Same hand-rolled in-memory IndexedDB as tests/pack-store-idb.test.js, copied
// rather than shared so neither test can break the other.
function fakeIdb() {
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
      put(value, key) { map.set(key, value) },
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

/** A bank whose sdta is far bigger than its metadata, so reading it would show. */
function bankBytes({ name = 'Nice Bank', author = '', sdtaBytes = 4096 } = {}) {
  const fields = [chunk('ifil', [...u16(2), ...u16(1)]), chunk('INAM', str(name, name.length + 1))]
  if (author) fields.push(chunk('IENG', str(author, author.length + 1)))
  const sdta = list('sdta', [chunk('smpl', new Array(sdtaBytes).fill(0))])
  const phdr = chunk('phdr', [
    record('Piano', u16(0), u16(0), u16(0), u32(0), u32(0), u32(0)),
    record('Kit', u16(5), u16(128), u16(1), u32(0), u32(0), u32(0)),
    record('EOP', u16(0), u16(0), u16(2), u32(0), u32(0), u32(0))
  ])
  const body = [...fourCC('sfbk'), ...list('INFO', fields), ...sdta, ...list('pdta', [phdr])]
  return new Uint8Array([...fourCC('RIFF'), ...u32(body.length), ...body])
}

/** Byte range of the smpl chunk body — the range nothing here may ever read. */
function smplRange(bytes) {
  const needle = fourCC('smpl')
  for (let at = 0; at + 8 <= bytes.byteLength; at++) {
    if (needle.every((byte, i) => bytes[at + i] === byte)) {
      const size = bytes[at + 4] | (bytes[at + 5] << 8) | (bytes[at + 6] << 16) | (bytes[at + 7] << 24)
      return { start: at + 8, end: at + 8 + size }
    }
  }
  throw new Error('no smpl chunk')
}

/** File.slice/arrayBuffer over a byte array, recording every range asked for. */
function fakeFile(bytes, lastModified, reads) {
  const at = (start, end) => bytes.subarray(start, Math.min(end, bytes.byteLength))
  return {
    size: bytes.byteLength,
    lastModified,
    async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) },
    slice(start, end) {
      reads.push({ start, end })
      return { async arrayBuffer() { const part = at(start, end); return part.buffer.slice(part.byteOffset, part.byteOffset + part.byteLength) } }
    }
  }
}

function fakeDir(name, files, { permission = 'granted' } = {}) {
  const reads = []
  const opens = []
  const handles = new Map(Object.entries(files).map(([fileName, spec]) => [fileName, {
    kind: 'file',
    name: fileName,
    async getFile() {
      opens.push(fileName)
      return fakeFile(spec.bytes, spec.lastModified ?? 1, reads)
    }
  }]))
  const dir = {
    kind: 'directory',
    name,
    permission,
    reads,
    opens,
    files,
    async queryPermission() { return dir.permission },
    async requestPermission() { dir.permission = dir.prompted ?? 'granted'; return dir.permission },
    async isSameEntry(other) { return other === dir },
    async getFileHandle(fileName) {
      const handle = handles.get(fileName)
      if (!handle) throw new Error('not found')
      return handle
    },
    async * values() { yield * handles.values() }
  }
  return dir
}

const library = (dir, extra = {}) => createFolderLibrary({ idb: fakeIdb(), pickDirectory: async () => dir, ...extra })

const priorPicker = Object.getOwnPropertyDescriptor(globalThis, 'showDirectoryPicker')
afterEach(() => {
  delete globalThis.showDirectoryPicker
  if (priorPicker) Object.defineProperty(globalThis, 'showDirectoryPicker', priorPicker)
})

describe('canBrowseFolders', () => {
  it('is false without showDirectoryPicker, and nothing else breaks', () => {
    delete globalThis.showDirectoryPicker
    expect(canBrowseFolders()).toBe(false)
    // The picker is only touched when the user acts, so the module still builds.
    expect(() => createFolderLibrary({ idb: fakeIdb() })).not.toThrow()
  })

  it('is true when the picker and IndexedDB both exist', () => {
    globalThis.showDirectoryPicker = async () => ({})
    expect(canBrowseFolders()).toBe(typeof indexedDB !== 'undefined')
  })
})

describe('folder library scan', () => {
  it('indexes from chunk headers and never reads the sdta byte range', async () => {
    const bytes = bankBytes({ name: 'Nice Bank', sdtaBytes: 8192 })
    const dir = fakeDir('Banks', { 'nice.sf2': { bytes } })
    const lib = library(dir)

    await lib.addFolder()
    const { banks, skipped } = await lib.scan()

    expect(skipped).toBe(0)
    expect(banks).toHaveLength(1)
    expect(banks[0]).toMatchObject({ title: 'Nice Bank', fileName: 'nice.sf2', folderName: 'Banks', size: bytes.byteLength })
    expect(banks[0].presets).toEqual([
      { bank: 0, program: 0, name: 'Piano' },
      { bank: 128, program: 5, name: 'Kit' }
    ])

    const smpl = smplRange(bytes)
    expect(dir.reads.length).toBeGreaterThan(0)
    for (const { start, end } of dir.reads) expect(start >= smpl.end || end <= smpl.start).toBe(true)
    const read = dir.reads.reduce((total, { start, end }) => total + Math.min(end, bytes.byteLength) - start, 0)
    expect(read).toBeLessThan(bytes.byteLength / 4)
  })

  it('reuses cached rows for unchanged banks and re-indexes a changed one', async () => {
    const dir = fakeDir('Banks', { 'a.sf2': { bytes: bankBytes({ name: 'A' }), lastModified: 10 } })
    const lib = library(dir)
    await lib.addFolder()
    await lib.scan()
    const firstPass = dir.reads.length

    await lib.scan()
    expect(dir.reads.length).toBe(firstPass) // Cache hit: no slice at all.

    dir.files['a.sf2'].lastModified = 11
    const { banks } = await lib.scan()
    expect(dir.reads.length).toBeGreaterThan(firstPass)
    expect(banks[0].mtimeMs).toBe(11)
  })

  it('skips a malformed bank without failing the scan', async () => {
    const dir = fakeDir('Banks', {
      'broken.sf2': { bytes: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) },
      'good.sf2': { bytes: bankBytes({ name: 'Good' }) }
    })
    const lib = library(dir)
    await lib.addFolder()

    const { banks, skipped } = await lib.scan()
    expect(skipped).toBe(1)
    expect(banks.map(bank => bank.title)).toEqual(['Good'])
  })

  it('disambiguates colliding titles with the author, else the filename', async () => {
    const dir = fakeDir('Banks', {
      'one.sf2': { bytes: bankBytes({ name: 'Shared', author: 'Yingchun Soul' }) },
      'two.sf2': { bytes: bankBytes({ name: 'Shared' }) },
      'solo.sf2': { bytes: bankBytes({ name: 'Alone', author: 'Someone' }) }
    })
    const lib = library(dir)
    await lib.addFolder()

    const { banks } = await lib.scan()
    expect(banks.map(bank => bank.title)).toEqual(['Alone', 'Shared — two.sf2', 'Shared — Yingchun Soul'])
  })

  it('treats a denied handle as an absent folder and keeps its index', async () => {
    const dir = fakeDir('Banks', { 'a.sf2': { bytes: bankBytes({ name: 'A' }) } })
    const lib = library(dir)
    await lib.addFolder()
    expect((await lib.scan()).banks).toHaveLength(1)

    dir.permission = 'prompt'
    const denied = await lib.scan()
    expect(denied.banks).toEqual([])
    expect(denied.folders).toEqual([{ id: 'banks', name: 'Banks', granted: false }])

    // Re-granting from a user gesture brings the cached rows back without a re-index.
    const reads = dir.reads.length
    expect(await lib.requestAccess('banks')).toBe(true)
    expect((await lib.scan()).banks).toHaveLength(1)
    expect(dir.reads.length).toBe(reads)
  })

  it('registers a folder once and drops its banks when it is removed', async () => {
    const dir = fakeDir('Banks', { 'a.sf2': { bytes: bankBytes({ name: 'A' }) } })
    const lib = library(dir)

    expect(await lib.addFolder()).toEqual([{ id: 'banks', name: 'Banks', granted: true }])
    expect(await lib.addFolder()).toHaveLength(1)
    await lib.scan()

    expect(await lib.removeFolder('banks')).toEqual([])
    expect(await lib.scan()).toMatchObject({ folders: [], banks: [], skipped: 0 })
  })

  it('returns null when the picker is cancelled', async () => {
    const lib = library(null, { pickDirectory: async () => { const error = new Error('cancel'); error.name = 'AbortError'; throw error } })
    expect(await lib.addFolder()).toBe(null)
  })
})

describe('per-preset import', () => {
  // The real importer, off the worker: parseInWorker's own message shape is
  // covered by the worker test; what matters here is the merge.
  const parse = async (bytes, name, presets) => importSf2(new Uint8Array(bytes), { id: name, presets })

  const setup = () => {
    const dir = fakeDir('Banks', { 'two.sf2': { bytes: multiPresetFixture() } })
    const packStore = createPackStore({ idb: fakeIdb() })
    return { dir, packStore, lib: library(dir, { packStore, parse }) }
  }

  it('appends a second preset into the same pack, and re-importing is a no-op', async () => {
    const { lib, packStore } = setup()
    await lib.addFolder()
    await lib.scan()

    const first = await lib.importPreset('banks/two.sf2', 0)
    expect(first.manifest.patches.map(patch => patch.id)).toEqual(['sf2-0'])

    const second = await lib.importPreset('banks/two.sf2', 1)
    expect(second.id).toBe(first.id)
    expect(second.manifest.patches.map(patch => patch.id)).toEqual(['sf2-0', 'sf2-1'])
    // Defaults always name a patch that exists.
    expect(second.manifest.patches.some(patch => patch.id === second.manifest.defaultPatchId)).toBe(true)
    expect(second.manifest.patches.some(patch => patch.id === second.manifest.defaultDrumPatchId)).toBe(true)

    const again = await lib.importPreset('banks/two.sf2', 1)
    expect(again.manifest).toEqual(second.manifest)
    const installed = await packStore.listPacks()
    expect(installed).toHaveLength(1)
    expect(installed[0].manifest.patches).toHaveLength(2)
    // Both presets' samples survived the merge.
    for (const patch of installed[0].manifest.patches) {
      for (const zone of patch.zones) expect((await packStore.readSample(installed[0].id, installed[0].version, zone.sampleId)).byteLength).toBeGreaterThan(0)
    }
  })

  it('reports progress and rejects an unknown bank or a bad index', async () => {
    const { lib } = setup()
    await lib.addFolder()
    await lib.scan()

    const stages = []
    await lib.importPreset('banks/two.sf2', 0, { onProgress: step => stages.push(step.stage) })
    expect(stages).toEqual(['reading', 'parsing', 'storing', 'done'])

    await expect(lib.importPreset('banks/nope.sf2', 0)).rejects.toThrow(/not in a registered folder/)
    await expect(lib.importPreset('banks/two.sf2', -1)).rejects.toThrow(/Invalid preset index/)
  })

  it('re-asks for permission at import time and fails cleanly when refused', async () => {
    const { dir, lib } = setup()
    await lib.addFolder()
    await lib.scan()
    dir.permission = 'prompt'
    dir.prompted = 'denied'

    await expect(lib.importPreset('banks/two.sf2', 0)).rejects.toThrow(/Grant access/)
  })
})
