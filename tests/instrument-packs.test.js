import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { importSf2Preset, instrumentPackRoot, listInstrumentPacks, readInstrumentSample } from '../src/main/instrument-packs.js'
import { addSoundFontFolder } from '../src/main/soundfont-folders.js'
import { multiPresetFixture } from './helpers/sf2-bytes.js'

const roots = []
async function root() { const value = await mkdtemp(join(tmpdir(), 'synth-packs-')); roots.push(value); return value }
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

async function install(userData, { id = 'tiny-pack', version = '1.0.0', sample = true } = {}) {
  const dir = join(instrumentPackRoot(userData), id, version)
  await mkdir(join(dir, 'audio'), { recursive: true })
  await writeFile(join(dir, 'NOTICE.txt'), 'notice')
  await writeFile(join(dir, 'manifest.json'), JSON.stringify({
    schemaVersion: 1, id, version, name: 'Tiny', license: { spdx: 'MIT', noticeFile: 'NOTICE.txt' },
    patches: [{ id: 'piano', name: 'Piano', kind: 'sample', address: { bankMsb: 0, bankLsb: 0, program: 0 }, zones: [{ keyLo: 0, keyHi: 127, rootKey: 60, sampleId: 'piano-c4' }] }]
  }))
  if (sample) await writeFile(join(dir, 'audio', 'piano-c4.wav'), Buffer.from([1, 2, 3]))
}

describe('Electron instrument packs', () => {
  it('exposes only complete validated installed packs', async () => {
    const userData = await root()
    await install(userData)
    await install(userData, { id: 'broken', sample: false })
    await expect(listInstrumentPacks(userData)).resolves.toMatchObject([{ id: 'tiny-pack', version: '1.0.0', manifest: { name: 'Tiny' } }])
  })

  it('reads samples only through validated pack identities', async () => {
    const userData = await root()
    await install(userData)
    await expect(readInstrumentSample(userData, 'tiny-pack', '1.0.0', 'piano-c4')).resolves.toEqual(new Uint8Array([1, 2, 3]).buffer)
    await expect(readInstrumentSample(userData, '../tiny-pack', '1.0.0', 'piano-c4')).rejects.toThrow('Invalid pack id')
  })
})

describe('per-preset SF2 import', () => {
  const info = { INAM: 'Two Presets', ICOP: 'Copyright 1998 Someone', ICMT: 'Made on an SB AWE32.' }
  async function bank(userData, fileName = 'bank.sf2') {
    const path = join(userData, fileName)
    await writeFile(path, multiPresetFixture({ info }))
    // Importing a preset requires the bank to sit in a registered folder.
    await addSoundFontFolder(userData, userData)
    return path
  }
  const packDir = userData => join(instrumentPackRoot(userData), 'bank', '1.0.0')
  const manifestOf = async userData => JSON.parse(await readFile(join(packDir(userData), 'manifest.json'), 'utf8'))

  it('refuses a bank outside every registered folder', async () => {
    // The renderer names this path, so the folder registry is the authorization
    // list: without it, importPreset reads any .sf2 on the disk.
    const userData = await root()
    const stray = join(userData, 'stray.sf2')
    await writeFile(stray, multiPresetFixture({ info }))
    await expect(importSf2Preset(userData, stray, 0)).rejects.toThrow('not in a registered folder')
    await addSoundFontFolder(userData, userData)
    await expect(importSf2Preset(userData, stray, 0)).resolves.toMatchObject({ id: 'stray' })
  })

  it('appends each preset into one pack per bank', async () => {
    const userData = await root(), source = await bank(userData)
    const first = await importSf2Preset(userData, source, 0)
    expect(first.manifest.patches.map(patch => patch.id)).toEqual(['sf2-0'])
    const second = await importSf2Preset(userData, source, 1)
    expect(second.manifest.patches.map(patch => patch.id)).toEqual(['sf2-0', 'sf2-1'])
    // The percussion preset arrived second, so it fills the missing drum default.
    expect(second.manifest.defaultPatchId).toBe('sf2-0')
    expect(second.manifest.defaultDrumPatchId).toBe('sf2-1')
    await expect(listInstrumentPacks(userData)).resolves.toHaveLength(1)
  })

  it('treats re-importing the same preset as a no-op', async () => {
    const userData = await root(), source = await bank(userData)
    await importSf2Preset(userData, source, 0)
    const before = await manifestOf(userData)
    await expect(importSf2Preset(userData, source, 0)).resolves.toMatchObject({ id: 'bank', version: '1.0.0' })
    expect(await manifestOf(userData)).toEqual(before)
  })

  it('writes merged samples before the manifest that names them', async () => {
    const userData = await root(), source = await bank(userData)
    await importSf2Preset(userData, source, 0)
    const manifestPath = join(packDir(userData), 'manifest.json')
    await chmod(manifestPath, 0o444)
    try {
      await expect(importSf2Preset(userData, source, 1)).rejects.toThrow()
    } finally {
      await chmod(manifestPath, 0o644)
    }
    // Manifest is the commit point: the second preset's audio landed, its patch did not.
    expect(await readdir(join(packDir(userData), 'audio'))).toHaveLength(2)
    expect((await manifestOf(userData)).patches.map(patch => patch.id)).toEqual(['sf2-0'])
  })

  it('carries the bank copyright and comment into NOTICE.txt', async () => {
    const userData = await root(), source = await bank(userData)
    await importSf2Preset(userData, source, 0)
    const notice = await readFile(join(packDir(userData), 'NOTICE.txt'), 'utf8')
    expect(notice).toContain('Copyright 1998 Someone')
    expect(notice).toContain('Made on an SB AWE32.')
  })

  it('rejects a preset index that is not a whole number', async () => {
    const userData = await root(), source = await bank(userData)
    await expect(importSf2Preset(userData, source, -1)).rejects.toThrow('Invalid preset index')
  })
})
