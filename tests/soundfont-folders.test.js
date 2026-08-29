import { lstat, mkdtemp, mkdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { addSoundFontFolder, listSoundFontFolders, removeSoundFontFolder, scanSoundFontFolders } from '../src/main/soundfont-folders.js'
import { multiPresetFixture } from './helpers/sf2-bytes.js'

const roots = []
async function root() { const value = await mkdtemp(join(tmpdir(), 'synth-fonts-')); roots.push(value); return value }
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

async function bank(dir, fileName, info) {
  const path = join(dir, fileName)
  await writeFile(path, multiPresetFixture({ info }))
  return path
}

async function registered(info = { INAM: 'Two Presets' }) {
  const userData = await root(), folder = join(await root(), 'banks')
  await mkdir(folder, { recursive: true })
  await bank(folder, 'two.sf2', info)
  await addSoundFontFolder(userData, folder)
  return { userData, folder }
}

describe('SoundFont folders', () => {
  it('registers, lists and removes folders without copying them', async () => {
    const { userData, folder } = await registered()
    await expect(listSoundFontFolders(userData)).resolves.toEqual([folder])
    await addSoundFontFolder(userData, folder)
    await expect(listSoundFontFolders(userData)).resolves.toEqual([folder])
    await expect(removeSoundFontFolder(userData, folder)).resolves.toEqual([])
  })

  it('indexes every bank in a registered folder', async () => {
    const { userData, folder } = await registered()
    const scan = await scanSoundFontFolders(userData)
    expect(scan.skipped).toBe(0)
    expect(scan.banks).toHaveLength(1)
    expect(scan.banks[0]).toMatchObject({ folder, fileName: 'two.sf2', title: 'Two Presets' })
    expect(scan.banks[0].presets).toEqual([
      { bank: 0, program: 0, name: 'Piano' },
      { bank: 128, program: 5, name: 'Kit' },
    ])
  })

  it('reuses cached rows whose size and mtime are unchanged', async () => {
    const { userData, folder } = await registered()
    const path = join(folder, 'two.sf2'), stat = await lstat(path)
    await writeFile(join(userData, 'soundfont-index.json'), JSON.stringify({
      version: 1,
      banks: { [path]: { path, folder, fileName: 'two.sf2', size: stat.size, mtimeMs: stat.mtimeMs, title: 'From Cache', info: {}, presets: [] } },
    }))
    // Unchanged bank: the cached row comes back untouched, the file is never read.
    const cached = await scanSoundFontFolders(userData)
    expect(cached.banks[0].title).toBe('From Cache')
    // A size change invalidates the key, so the bank is indexed again.
    await writeFile(path, Buffer.concat([Buffer.from(multiPresetFixture({ info: { INAM: 'Two Presets' } })), Buffer.from([0])]))
    const rescanned = await scanSoundFontFolders(userData)
    expect(rescanned.banks[0].title).toBe('Two Presets')
  })

  it('skips and counts a malformed bank without failing the scan', async () => {
    const { userData, folder } = await registered()
    await writeFile(join(folder, 'broken.sf2'), Buffer.from('not a soundfont'))
    const scan = await scanSoundFontFolders(userData)
    expect(scan.skipped).toBe(1)
    expect(scan.banks.map(entry => entry.fileName)).toEqual(['two.sf2'])
  })

  it('disambiguates only colliding titles, by author then filename', async () => {
    const { userData, folder } = await registered({ INAM: 'Shared', IENG: 'Alice' })
    await bank(folder, 'other.sf2', { INAM: 'Shared' })
    await bank(folder, 'alone.sf2', { INAM: 'Alone', IENG: 'Bob' })
    const scan = await scanSoundFontFolders(userData)
    expect(scan.banks.map(entry => entry.title).sort()).toEqual(['Alone', 'Shared — Alice', 'Shared — other.sf2'])
  })
})
