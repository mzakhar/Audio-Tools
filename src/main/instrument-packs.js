import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'fs/promises'
import { basename, join, relative, resolve } from 'path'
import { importSf2 } from '../shared/sf2-import.js'
import { validatePackManifest } from '../renderer/js/instruments/pack-registry.js'
import { isRegisteredBank } from './soundfont-folders.js'

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

function sampleFile(sampleId, ext = 'wav') {
  return `${safePart(sampleId, 'sample id')}.${ext === 'ogg' ? 'ogg' : 'wav'}`
}

export function instrumentPackRoot(userData) {
  return join(resolve(userData), 'instrument-packs')
}

async function regularFile(path) {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Instrument pack contains a non-file asset')
}

/** A pack's samples are WAV from SF2 and Ogg from SF3; the manifest names neither. */
async function assetPath(dir, sampleId) {
  for (const ext of ['wav', 'ogg']) {
    const path = within(join(dir, 'audio', sampleFile(sampleId, ext)), dir)
    try {
      await regularFile(path)
      return path
    } catch { /* Try the other encoding before giving up. */ }
  }
  throw new Error(`Instrument pack is missing sample ${sampleId}`)
}

async function validatePackDirectory(root, dir, id, version) {
  within(dir, root)
  const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'))
  const validation = validatePackManifest(manifest)
  if (!validation.ok) throw new Error(`Invalid installed pack: ${validation.errors.join('; ')}`)
  if (manifest.id !== id || manifest.version !== version) throw new Error('Installed pack identity mismatch')
  await regularFile(within(join(dir, manifest.license.noticeFile), dir))
  // Banks reuse one sample across many zones; stat each asset once, not once per zone.
  const sampleIds = new Set(manifest.patches.flatMap(patch => (patch.zones || []).map(zone => zone.sampleId)))
  for (const sampleId of sampleIds) await assetPath(dir, sampleId)
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
  const bytes = await readFile(await assetPath(within(join(root, pack.id, pack.version), root), sampleId))
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
}

/** A path from the renderer: a real regular file with a bank extension, never a symlink. */
async function sf2Source(sourcePath) {
  if (typeof sourcePath !== 'string' || !/\.sf[23]$/i.test(sourcePath)) throw new Error('Choose a .sf2 or .sf3 file')
  const source = resolve(sourcePath), info = await lstat(source)
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_SF2_BYTES) throw new Error('Invalid or oversized SoundFont file')
  return source
}

function checkConverted(converted) {
  if (converted.samples.length > MAX_SAMPLES) throw new Error('SoundFont has too many samples')
  const sampleBytes = converted.samples.reduce((total, sample) => total + sample.wav.byteLength, 0)
  if (sampleBytes > MAX_PACK_BYTES) throw new Error('Converted pack is too large')
  const validation = validatePackManifest(converted.manifest)
  if (!validation.ok) throw new Error(`Converted pack is invalid: ${validation.errors.join('; ')}`)
}

/** The bank's own notice: 81% of real banks carry a copyright and 70% a comment. */
function noticeText(sourceName, info) {
  const lines = [`Imported from ${sourceName}.`]
  if (info?.copyright) lines.push(info.copyright)
  if (info?.comment) lines.push(info.comment)
  lines.push('Verify upstream license and attribution before redistribution.')
  return `${lines.join('\n')}\n`
}

/** Stage a whole converted pack and swap it into place, replacing any same version. */
async function publishPack(root, converted, sourceName) {
  const { manifest } = converted
  const id = safePart(manifest.id, 'id'), version = safePart(manifest.version, 'version')
  await mkdir(root, { recursive: true })
  const staging = within(join(root, `.install-${process.pid}-${Date.now()}`), root)
  const target = within(join(root, id, version), root), backup = `${target}.previous`
  try {
    await mkdir(join(staging, 'audio'), { recursive: true })
    await writeFile(join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2))
    await writeFile(join(staging, 'NOTICE.txt'), noticeText(sourceName, manifest.source?.info))
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

/**
 * Append the converted patches to an installed pack. Samples are written first
 * and the manifest last, because the manifest is the commit point: a crash may
 * leave orphan audio, never a manifest naming audio that is not on disk.
 */
async function mergeIntoPack(root, target, converted, id, version) {
  const existing = JSON.parse(await readFile(join(target, 'manifest.json'), 'utf8'))
  const present = new Set(existing.patches.map(patch => patch.id))
  const added = converted.manifest.patches.filter(patch => !present.has(patch.id))
  if (!added.length) return validateInstalled(root, id, version) // Re-importing a preset is a no-op.
  const merged = { ...existing, patches: [...existing.patches, ...added] }
  // Appending keeps the existing defaults valid; the new bank's only fill a gap.
  const ids = new Set(merged.patches.map(patch => patch.id))
  if (!ids.has(merged.defaultPatchId)) merged.defaultPatchId = merged.patches[0].id
  if (!merged.defaultDrumPatchId || !ids.has(merged.defaultDrumPatchId)) {
    const drum = converted.manifest.defaultDrumPatchId
    if (drum && ids.has(drum)) merged.defaultDrumPatchId = drum
    else delete merged.defaultDrumPatchId
  }
  const validation = validatePackManifest(merged)
  if (!validation.ok) throw new Error(`Merged pack is invalid: ${validation.errors.join('; ')}`)
  for (const sample of converted.samples) await writeFile(within(join(target, 'audio', sampleFile(sample.id)), target), new Uint8Array(sample.wav))
  for (const sampleId of new Set(merged.patches.flatMap(patch => (patch.zones || []).map(zone => zone.sampleId)))) await assetPath(target, sampleId)
  await writeFile(join(target, 'manifest.json'), JSON.stringify(merged, null, 2))
  return validateInstalled(root, id, version)
}

/** Convert one local PCM SF2 and atomically publish it under Electron userData. */
export async function importSf2Pack(userData, sourcePath) {
  const source = await sf2Source(sourcePath)
  const converted = importSf2(await readFile(source), { id: basename(source).replace(/\.sf[23]$/i, '') })
  checkConverted(converted)
  return publishPack(instrumentPackRoot(userData), converted, basename(source))
}

/** Convert one preset of a bank into that bank's pack, appending to it if it exists. */
export async function importSf2Preset(userData, sourcePath, presetIndex) {
  if (!Number.isInteger(presetIndex) || presetIndex < 0) throw new Error('Invalid preset index')
  // Unlike importSf2Pack, which opens its own dialog, this path is named by the
  // renderer. Registering a folder is what authorizes reading the banks in it.
  if (!await isRegisteredBank(userData, sourcePath)) throw new Error('That SoundFont is not in a registered folder')
  const source = await sf2Source(sourcePath)
  const converted = importSf2(await readFile(source), { id: basename(source).replace(/\.sf[23]$/i, ''), presets: [presetIndex] })
  checkConverted(converted)
  const root = instrumentPackRoot(userData)
  const id = safePart(converted.manifest.id, 'id'), version = safePart(converted.manifest.version, 'version')
  const target = within(join(root, id, version), root)
  try { await regularFile(join(target, 'manifest.json')) } catch { return publishPack(root, converted, basename(source)) }
  return mergeIntoPack(root, target, converted, id, version)
}
