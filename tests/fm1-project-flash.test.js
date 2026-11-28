import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The real codec is the session side's (fm1/flash-asset.js); a JSON stand-in keeps these tests about the flow.
vi.mock('../src/renderer/js/fm1/flash-asset.js', () => ({
  FLASH_EXT: '.flash',
  EXPORT_EXT: '.fm1flash',
  encodeFlashAsset: ({ firmwareHash, records }) => new TextEncoder().encode(JSON.stringify({ firmwareHash, records })),
  decodeFlashAsset: (bytes, { firmwareHash }) => {
    let parsed
    try { parsed = JSON.parse(new TextDecoder().decode(bytes)) } catch { return { ok: false, reason: 'bad-magic' } }
    return parsed.firmwareHash === firmwareHash ? { ok: true, records: parsed.records } : { ok: false, reason: 'wrong-firmware' }
  }
}))

import { fm1FlashPath, writeFm1Flash, readFm1Flash } from '../src/main/fm1-flash-files.js'
import { BrowserAdapter, ElectronAdapter } from '../src/renderer/js/io/FileAdapter.js'
import ProjectStore, { AddTrack, SetTrackInstrument, SetTrackFlashAssets, SetBpm } from '../src/renderer/js/store/ProjectStore.js'
import { saveProject, flashReader, anyFlashDirty, exportDeviceState, importDeviceState, resetDeviceState } from '../src/renderer/js/fm1/project-flash.js'
import { decodeFlashAsset } from '../src/renderer/js/fm1/flash-asset.js'
import { fm1Descriptor, fm1Sig } from '../src/renderer/js/fm1/descriptor.js'

const HASH = 'sha256:' + 'a'.repeat(64)
const fm1 = (extra = {}) => ({ type: 'fm1', firmwareHash: HASH, deviceChannel: 0, mhz: 120, ...extra })

describe('main: fm1 flash files', () => {
  let dir
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'fm1flash-')) })
  afterEach(() => rm(dir, { recursive: true, force: true }))

  it('rejects every name that is not a plain <id>.flash', () => {
    for (const name of ['../x.flash', '..\\x.flash', 'a/b.flash', 'x.flash/../../y.flash', '/etc/x.flash', 'C:\\x.flash', 'x.wav', '.flash', 'x.flash.tmp', '', null]) {
      expect(() => fm1FlashPath(dir, name), String(name)).toThrow(/Invalid/)
    }
    expect(() => fm1FlashPath(null, 'a.flash')).toThrow(/Invalid/)
    expect(fm1FlashPath(dir, 'abc-1_2.flash').file).toBe(join(dir, 'fm1', 'abc-1_2.flash'))
  })

  it('writes under <project>/fm1/ (creating it), reads back, null when missing, no temp left', async () => {
    await writeFm1Flash(dir, 'one.flash', new Uint8Array([1, 2, 3]))
    expect([...await readFile(join(dir, 'fm1', 'one.flash'))]).toEqual([1, 2, 3])
    expect(await readdir(join(dir, 'fm1'))).toEqual(['one.flash'])
    expect([...await readFm1Flash(dir, 'one.flash')]).toEqual([1, 2, 3])
    expect(await readFm1Flash(dir, 'nope.flash')).toBeNull()
    await expect(writeFm1Flash(dir, '../escape.flash', new Uint8Array(1))).rejects.toThrow(/Invalid/)
  })
})

describe('FileAdapter fm1 flash', () => {
  function fakeFolder() {
    const files = new Map()
    const fm1Dir = {
      getFileHandle: vi.fn(async (name, opts) => {
        if (!files.has(name) && !opts?.create) throw Object.assign(new Error('nf'), { name: 'NotFoundError' })
        return {
          getFile: async () => ({ arrayBuffer: async () => files.get(name).buffer }),
          createWritable: async () => { let data; return { write: async b => { data = b }, close: async () => { files.set(name, new Uint8Array(data)) }, abort: async () => {} } }
        }
      })
    }
    let created = false
    const root = {
      getDirectoryHandle: vi.fn(async (name, opts) => {
        if (name !== 'fm1') throw new Error('wrong dir')
        if (!created && !opts?.create) throw Object.assign(new Error('nf'), { name: 'NotFoundError' })
        created = true
        return fm1Dir
      })
    }
    return { root, files }
  }

  it('browser: writes into the fm1/ subfolder and reads back; missing is null', async () => {
    const { root, files } = fakeFolder()
    expect(await BrowserAdapter.readFm1Flash(root, 'a.flash')).toBeNull()
    await BrowserAdapter.writeFm1Flash(root, 'a.flash', new Uint8Array([9, 8]))
    expect(root.getDirectoryHandle).toHaveBeenCalledWith('fm1', { create: true })
    expect([...files.get('a.flash')]).toEqual([9, 8])
    expect([...await BrowserAdapter.readFm1Flash(root, 'a.flash')]).toEqual([9, 8])
    expect(await BrowserAdapter.readFm1Flash(root, 'b.flash')).toBeNull()
    await expect(BrowserAdapter.writeFm1Flash(root, '../x.flash', new Uint8Array(1))).rejects.toThrow(/Invalid/)
  })

  it('no folder (LAN, unsaved project) rejects with no-folder in both adapters', async () => {
    await expect(BrowserAdapter.writeFm1Flash(null, 'a.flash', new Uint8Array(1))).rejects.toThrow('no-folder')
    await expect(BrowserAdapter.readFm1Flash(null, 'a.flash')).rejects.toThrow('no-folder')
    await expect(ElectronAdapter.writeFm1Flash(null, 'a.flash', new Uint8Array(1))).rejects.toThrow('no-folder')
    await expect(ElectronAdapter.readFm1Flash(null, 'a.flash')).rejects.toThrow('no-folder')
  })

  it('electron: goes through the bridge', async () => {
    globalThis.window = { electronFS: { writeFm1Flash: vi.fn(async () => {}), readFm1Flash: vi.fn(async () => new Uint8Array([5])) } }
    try {
      await ElectronAdapter.writeFm1Flash('/p', 'a.flash', new Uint8Array([1]))
      expect(window.electronFS.writeFm1Flash).toHaveBeenCalledWith('/p', 'a.flash', new Uint8Array([1]))
      expect([...await ElectronAdapter.readFm1Flash('/p', 'a.flash')]).toEqual([5])
      window.electronFS.readFm1Flash.mockResolvedValue(null)
      expect(await ElectronAdapter.readFm1Flash('/p', 'a.flash')).toBeNull()
    } finally { delete globalThis.window }
  })
})

describe('descriptor: flashAssetId is kept but is not identity', () => {
  it('fm1Descriptor keeps a valid id, drops a bad one; fm1Sig ignores it', () => {
    expect(fm1Descriptor(fm1({ flashAssetId: 'abc-1' })).flashAssetId).toBe('abc-1')
    expect(fm1Descriptor(fm1({ flashAssetId: '../x' }))).not.toHaveProperty('flashAssetId')
    expect(fm1Sig(fm1({ flashAssetId: 'one' }))).toBe(fm1Sig(fm1({ flashAssetId: 'two' })))
    expect(fm1Sig(fm1())).toBe(fm1Sig(fm1({ flashAssetId: 'two' })))
    expect(fm1Sig(fm1({ mhz: 200 }))).not.toBe(fm1Sig(fm1()))
  })
})

/** A project with two FM-1 tracks, through the real store. */
function project() {
  ProjectStore.reset()
  ProjectStore.dispatch(AddTrack('midi', 'Lead'))
  ProjectStore.dispatch(AddTrack('midi', 'Bass'))
  const [a, b] = ProjectStore.getState().tracks.slice(-2).map(t => t.id)
  ProjectStore.dispatch(SetTrackInstrument(a, fm1({ flashAssetId: 'old-a' })))
  ProjectStore.dispatch(SetTrackInstrument(b, fm1({ flashAssetId: 'old-b' })))
  return { a, b }
}
const idOf = trackId => ProjectStore.getState().tracks.find(t => t.id === trackId).instrument.flashAssetId
const rec = n => ({ offset: n * 4096, bytes: new Uint8Array(4096).fill(n) })

describe('store: flash asset commands', () => {
  it('SetTrackFlashAssets adds no undo entry, and patches history so undo keeps the newest asset', () => {
    const { a } = project()
    ProjectStore.dispatch(SetBpm(140))
    const depth = ProjectStore.getUndoStackSize()
    ProjectStore.dispatch(SetTrackFlashAssets([{ trackId: a, assetId: 'new-a', firmwareHash: HASH }]))
    expect(ProjectStore.getUndoStackSize()).toBe(depth)
    expect(idOf(a)).toBe('new-a')
    ProjectStore.undo()
    expect(ProjectStore.getState().bpm).not.toBe(140)
    expect(idOf(a)).toBe('new-a')
    ProjectStore.redo()
    expect(idOf(a)).toBe('new-a')
  })

  it('SetTrackFlashAssets ignores a track whose firmware differs', () => {
    const { a } = project()
    ProjectStore.dispatch(SetTrackFlashAssets([{ trackId: a, assetId: 'new-a', firmwareHash: 'sha256:other' }]))
    expect(idOf(a)).toBe('old-a')
  })

  it('reset: undoable clear, then re-acquire', () => {
    const { a } = project()
    const order = []
    const depth = ProjectStore.getUndoStackSize()
    resetDeviceState(a, {
      dispatch: c => { order.push('dispatch'); ProjectStore.dispatch(c) },
      reacquire: id => order.push(`acquire:${id}:${idOf(id) ?? 'none'}`)
    })
    expect(order).toEqual(['dispatch', `acquire:${a}:none`])
    expect(ProjectStore.getUndoStackSize()).toBe(depth + 1)
    ProjectStore.undo()
    expect(idOf(a)).toBe('old-a')
  })
})

describe('save flow', () => {
  function run(results, { writeFlash } = {}) {
    const log = []
    const sessions = new Map()
    const getSession = id => sessions.get(id) ?? sessions.set(id, { markFlashSaved: vi.fn(r => log.push(`saved:${id}:${r}`)) }).get(id)
    let n = 0
    const deps = {
      getState: () => ProjectStore.getState(),
      snapshotAll: async () => { log.push('snapshot'); return new Map(results) },
      writeFlash: writeFlash ?? (async (name, bytes) => { log.push(`asset:${name}`); deps.assets.set(name, bytes) }),
      commit: assignments => { log.push('commit'); ProjectStore.dispatch(SetTrackFlashAssets(assignments)) },
      writeProject: async state => { log.push('project'); deps.written = state },
      getSession,
      newId: () => `id${++n}`,
      assets: new Map()
    }
    return { deps, log, sessions, promise: saveProject(deps) }
  }

  it('changed track: asset, then one commit, then project.json, then markFlashSaved; unchanged skipped', async () => {
    const { a, b } = project()
    const { deps, log, promise } = run([[a, { ok: true, changed: true, records: [rec(1)], revision: 7 }], [b, { ok: true, changed: false, records: [], revision: 3 }]])
    const { messages } = await promise
    expect(messages).toEqual([])
    expect(log).toEqual(['snapshot', 'asset:id1.flash', 'commit', 'project', `saved:${a}:7`])
    const track = deps.written.tracks.find(t => t.id === a)
    expect(track.instrument.flashAssetId).toBe('id1')
    expect(deps.written.tracks.find(t => t.id === b).instrument.flashAssetId).toBe('old-b')
    expect(decodeFlashAsset(deps.assets.get('id1.flash'), { firmwareHash: HASH })).toEqual({ ok: true, records: JSON.parse(JSON.stringify([rec(1)])) })
  })

  it('busy timeout keeps the old id, toasts, and still writes project.json', async () => {
    const { a, b } = project()
    const { deps, log, promise } = run([[a, { ok: false, reason: 'busy-timeout' }], [b, { ok: false, reason: 'not-ready' }]])
    const { messages } = await promise
    expect(messages).toEqual(['FM-1 on Lead: device busy, previous state kept'])
    expect(log).toEqual(['snapshot', 'project'])
    expect(deps.written.tracks.find(t => t.id === a).instrument.flashAssetId).toBe('old-a')
  })

  it('a failed asset write keeps that track\'s old id, others still save, project.json last', async () => {
    const { a, b } = project()
    const { deps, log, promise } = run(
      [[a, { ok: true, changed: true, records: [rec(1)], revision: 2 }], [b, { ok: true, changed: true, records: [rec(2)], revision: 5 }]],
      { writeFlash: async name => { if (name === 'id1.flash') throw new Error('disk full'); log.push(`asset:${name}`) } }
    )
    const { messages } = await promise
    expect(messages).toEqual(['FM-1 on Lead: device state not saved (disk full), previous state kept'])
    expect(log).toEqual(['snapshot', 'asset:id2.flash', 'commit', 'project', `saved:${b}:5`])
    expect(deps.written.tracks.find(t => t.id === a).instrument.flashAssetId).toBe('old-a')
    expect(deps.written.tracks.find(t => t.id === b).instrument.flashAssetId).toBe('id2')
  })

  it('the device sig does not move when a save changes flashAssetId (no reboot on save)', async () => {
    const { a } = project()
    const before = fm1Sig(ProjectStore.getState().tracks.find(t => t.id === a).instrument)
    await run([[a, { ok: true, changed: true, records: [rec(1)], revision: 1 }]]).promise
    expect(idOf(a)).toBe('id1')
    expect(fm1Sig(ProjectStore.getState().tracks.find(t => t.id === a).instrument)).toBe(before)
  })

  it('no sessions at all: just project.json', async () => {
    project()
    const { log, promise } = run([])
    await promise
    expect(log).toEqual(['snapshot', 'project'])
  })
})

describe('open: readFlash', () => {
  it('null without an asset id; the bytes with one; flash-missing when missing or no folder', async () => {
    const readFm1Flash = vi.fn(async (dir, name) => name === 'have.flash' ? new Uint8Array([1]) : null)
    const read = flashReader({ getDir: () => '/p', readFm1Flash })
    expect(await read(fm1())).toBeNull()
    expect([...await read(fm1({ flashAssetId: 'have' }))]).toEqual([1])
    expect(readFm1Flash).toHaveBeenCalledWith('/p', 'have.flash')
    await expect(read(fm1({ flashAssetId: 'gone' }))).rejects.toThrow('flash-missing')
    await expect(flashReader({ getDir: () => null, readFm1Flash })(fm1({ flashAssetId: 'have' }))).rejects.toThrow('flash-missing')
    await expect(flashReader({ getDir: () => '/p', readFm1Flash: async () => { throw new Error('EACCES') } })(fm1({ flashAssetId: 'x' }))).rejects.toThrow('flash-missing')
  })

  it('anyFlashDirty reads session status().flash.dirty', () => {
    const sessions = new Map([['a', { status: () => ({ flash: { dirty: false } }) }], ['b', { status: () => ({ flash: { dirty: true } }) }]])
    expect(anyFlashDirty(sessions, ['a'])).toBe(false)
    expect(anyFlashDirty(sessions, ['a', 'b'])).toBe(true)
    expect(anyFlashDirty(sessions, ['missing'])).toBe(false)
    expect(anyFlashDirty(null, ['a'])).toBe(false)
  })
})

describe('export / import device state', () => {
  it('export produces a decodable file for this firmware', async () => {
    const session = { snapshotFlash: async () => ({ ok: true, changed: false, records: [rec(3)], revision: 1 }) }
    const out = await exportDeviceState(session, HASH)
    expect(out.ok).toBe(true)
    expect(decodeFlashAsset(out.bytes, { firmwareHash: HASH })).toEqual({ ok: true, records: JSON.parse(JSON.stringify([rec(3)])) })
    expect(await exportDeviceState({ snapshotFlash: async () => ({ ok: false, reason: 'busy-timeout' }) }, HASH)).toEqual({ ok: false, reason: 'busy-timeout' })
    expect(await exportDeviceState(null, HASH)).toEqual({ ok: false, reason: 'not-ready' })
  })

  it('import validates first: wrong firmware never reaches the device', async () => {
    const session = { importFlash: vi.fn(async () => {}), snapshotFlash: async () => ({ ok: true, records: [rec(4)] }) }
    const { bytes } = await exportDeviceState(session, HASH)
    expect(await importDeviceState(session, bytes, 'sha256:other')).toEqual({ ok: false, reason: 'wrong-firmware' })
    expect(await importDeviceState(session, new Uint8Array([1, 2]), HASH)).toEqual({ ok: false, reason: 'bad-magic' })
    expect(session.importFlash).not.toHaveBeenCalled()
    expect(await importDeviceState(session, bytes, HASH)).toEqual({ ok: true })
    expect(session.importFlash).toHaveBeenCalledWith(JSON.parse(JSON.stringify([rec(4)])))
  })
})
