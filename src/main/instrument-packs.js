import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'fs/promises'
import { basename, join, relative, resolve } from 'path'
import { importSf2 } from './sf2-import.js'
import { validatePackManifest } from '../renderer/js/instruments/pack-registry.js'

const MAX_SF2_BYTES = 256 * 1024 * 1024
const MAX_PACK_BYTES = 512 * 1024 * 1024
const MAX_SAMPLES = 4096

function within(path, base) {
  const value = resolve(path), root = resolve(base), rel = relative(root, value)
  if (rel.startsWith('..') || resolve(root, rel) !== value) throw new Error('Instrument pack path escapes storage')
  return value
}

function safePart(value, label) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/i.test(value)) throw new Error(`Invalid pack ${label}`)
  return value
}

function sampleFile(sampleId) {
  return `${safePart(sampleId, 'sample id')}.wav`
}

export function instrumentPackRoot(userData) {
  return join(resolve(userData), 'instrument-packs')
}

async function regularFile(path) {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Instrument pack contains a non-file asset')
}

async function validatePackDirectory(root, dir, id, version) {
  within(dir, root)
  const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'))
  const validation = validatePackManifest(manifest)
  if (!validation.ok) throw new Error(`Invalid installed pack: ${validation.errors.join('; ')}`)
  if (manifest.id !== id || manifest.version !== version) throw new Error('Installed pack identity mismatch')
  await regularFile(within(join(dir, manifest.license.noticeFile), dir))
  for (const patch of manifest.patches) for (const zone of patch.zones || []) await regularFile(within(join(dir, 'audio', sampleFile(zone.sampleId)), dir))
  return { id, version, manifest }
}

async function validateInstalled(root, id, version) {
  return validatePackDirectory(root, within(join(root, safePart(id, 'id'), safePart(version, 'version')), root), id, version)
}

/** Return only installed, validated packs; corrupt disk content stays invisible. */
export async function listInstrumentPacks(userData) {
  const root = instrumentPackRoot(userData)
  try { await mkdir(root, { recursive: true }) } catch { return [] }
  const packs = []
  for (const id of await readdir(root, { withFileTypes: true })) {
    if (!id.isDirectory() || !/^[a-z0-9][a-z0-9._-]*$/i.test(id.name)) continue
    for (const version of await readdir(join(root, id.name), { withFileTypes: true })) {
      if (!version.isDirectory() || !/^[a-z0-9][a-z0-9._-]*$/i.test(version.name)) continue
      try { packs.push(await validateInstalled(root, id.name, version.name)) } catch { /* Ignore incomplete or tampered packs. */ }
    }
  }
  return packs.sort((a, b) => a.id.localeCompare(b.id) || a.version.localeCompare(b.version))
}

export async function readInstrumentSample(userData, id, version, sampleId) {
  const root = instrumentPackRoot(userData)
  const pack = await validateInstalled(root, id, version)
  if (!pack.manifest.patches.some(patch => (patch.zones || []).some(zone => zone.sampleId === sampleId))) throw new Error('Sample is not declared by this pack')
  const path = within(join(root, pack.id, pack.version, 'audio', sampleFile(sampleId)), root)
  const bytes = await readFile(path)
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
}

/** Convert one local PCM SF2 and atomically publish it under Electron userData. */
export async function importSf2Pack(userData, sourcePath) {
  if (typeof sourcePath !== 'string' || !sourcePath.toLowerCase().endsWith('.sf2')) throw new Error('Choose a .sf2 file')
  const source = resolve(sourcePath), info = await lstat(source)
  if (!info.isFile() || info.size > MAX_SF2_BYTES) throw new Error('Invalid or oversized .sf2 file')
  const converted = importSf2(await readFile(source), { id: basename(source, '.sf2') })
  if (converted.samples.length > MAX_SAMPLES) throw new Error('SoundFont has too many samples')
  const sampleBytes = converted.samples.reduce((total, sample) => total + sample.wav.byteLength, 0)
  if (sampleBytes > MAX_PACK_BYTES) throw new Error('Converted pack is too large')

  const root = instrumentPackRoot(userData), { manifest } = converted
  const validation = validatePackManifest(manifest)
  if (!validation.ok) throw new Error(`Converted pack is invalid: ${validation.errors.join('; ')}`)
  const id = safePart(manifest.id, 'id'), version = safePart(manifest.version, 'version')
  await mkdir(root, { recursive: true })
  const staging = within(join(root, `.install-${process.pid}-${Date.now()}`), root)
  const target = within(join(root, id, version), root), backup = `${target}.previous`
  try {
    await mkdir(join(staging, 'audio'), { recursive: true })
    await writeFile(join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2))
    await writeFile(join(staging, 'NOTICE.txt'), `Imported from ${basename(source)}. Verify upstream license and attribution before redistribution.\n`)
    await writeFile(join(staging, 'LICENSE.txt'), 'LicenseRef-Imported: upstream license was not supplied with this local import.\n')
    for (const sample of converted.samples) await writeFile(within(join(staging, 'audio', sampleFile(sample.id)), staging), new Uint8Array(sample.wav))
    await validatePackDirectory(root, staging, id, version)
    await mkdir(join(root, id), { recursive: true })
    await rm(backup, { recursive: true, force: true })
    try { await rename(target, backup) } catch (error) { if (error.code !== 'ENOENT') throw error }
    await rename(staging, target)
    await rm(backup, { recursive: true, force: true })
    return await validateInstalled(root, id, version)
  } catch (error) {
    try { await lstat(target) } catch { try { await rename(backup, target) } catch { /* Keep original failure. */ } }
    throw error
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}
