import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { instrumentPackRoot, listInstrumentPacks, readInstrumentSample } from '../src/main/instrument-packs.js'

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
