const PERCUSSION_PROFILE = 'gm-percussion'

function isByte(value) {
  return Number.isInteger(value) && value >= 0 && value <= 127
}

function isText(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function addressOf(patch) {
  return patch?.address
}

/** A stable key for the only MIDI address dimensions packs currently support. */
export function patchAddressKey(address, channelProfile = '') {
  if (!address || !isByte(address.bankMsb) || !isByte(address.bankLsb) || !isByte(address.program)) return null
  return `${address.bankMsb}:${address.bankLsb}:${address.program}:${channelProfile || ''}`
}

/**
 * Validate the renderer-facing part of a pack manifest. Files, archive quotas, and
 * hashes belong to the installer, before a manifest reaches this module.
 */
export function validatePackManifest(manifest) {
  const errors = []
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return { ok: false, errors: ['Manifest must be an object'] }
  if (manifest.schemaVersion !== 1) errors.push('Unsupported manifest schemaVersion')
  for (const field of ['id', 'version', 'name']) if (!isText(manifest[field])) errors.push(`Manifest ${field} is required`)
  if (!manifest.license || typeof manifest.license !== 'object' || !isText(manifest.license.spdx) || !isText(manifest.license.noticeFile)) {
    errors.push('Manifest license.spdx and license.noticeFile are required')
  }
  if (manifest.profiles !== undefined && (!Array.isArray(manifest.profiles) || manifest.profiles.some(profile => !isText(profile)))) {
    errors.push('Manifest profiles must be an array of names')
  }
  if (!Array.isArray(manifest.patches)) {
    errors.push('Manifest patches must be an array')
    return { ok: false, errors }
  }

  const ids = new Set()
  const addresses = new Set()
  for (const [index, patch] of manifest.patches.entries()) {
    const label = `Patch ${index}`
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      errors.push(`${label} must be an object`)
      continue
    }
    if (!isText(patch.id)) errors.push(`${label} id is required`)
    else if (ids.has(patch.id)) errors.push(`${label} id is duplicated`)
    else ids.add(patch.id)
    if (!isText(patch.name)) errors.push(`${label} name is required`)
    if (!isText(patch.kind)) errors.push(`${label} kind is required`)
    if (patch.channelProfile !== undefined && !isText(patch.channelProfile)) errors.push(`${label} channelProfile must be a name`)

    const key = patchAddressKey(addressOf(patch), patch.channelProfile)
    if (!key) errors.push(`${label} address must contain bankMsb, bankLsb, and program bytes`)
    else if (addresses.has(key)) errors.push(`${label} address is duplicated`)
    else addresses.add(key)

    if (patch.zones !== undefined) {
      if (!Array.isArray(patch.zones) || patch.zones.length === 0) errors.push(`${label} zones must be a non-empty array`)
      else for (const [zoneIndex, zone] of patch.zones.entries()) {
        if (!zone || !isByte(zone.keyLo) || !isByte(zone.keyHi) || zone.keyLo > zone.keyHi || !isByte(zone.rootKey) || !isText(zone.sampleId)) {
          errors.push(`${label} zone ${zoneIndex} is invalid`)
        }
      }
    }
  }

  for (const field of ['defaultPatchId', 'defaultDrumPatchId']) {
    if (manifest[field] !== undefined && (!isText(manifest[field]) || !ids.has(manifest[field]))) errors.push(`Manifest ${field} must name a patch`)
  }
  return { ok: errors.length === 0, errors }
}

export function compilePackManifest(manifest) {
  const validation = validatePackManifest(manifest)
  if (!validation.ok) throw new TypeError(`Invalid pack manifest: ${validation.errors.join('; ')}`)
  const byAddress = new Map()
  const byId = new Map()
  for (const patch of manifest.patches) {
    byId.set(patch.id, patch)
    byAddress.set(patchAddressKey(patch.address, patch.channelProfile), patch)
  }
  return Object.freeze({
    id: manifest.id,
    version: manifest.version,
    manifest,
    byAddress,
    byId,
  })
}

/**
 * Resolves an address without making GM assumptions. Channel ten prefers its
 * percussion profile; all other channels resolve the normal melodic patch.
 */
export function resolvePatch(pack, address, { channel, channelProfile } = {}) {
  if (!pack?.byAddress || !pack?.byId || !patchAddressKey(address)) return { patch: null, source: 'unresolved' }
  const profile = channelProfile === undefined ? (channel === 9 ? PERCUSSION_PROFILE : '') : channelProfile
  const exact = pack.byAddress.get(patchAddressKey(address, profile)) || (profile && pack.byAddress.get(patchAddressKey(address)))
  if (exact) return resolved(pack, address, exact, 'exact')

  const fallbackId = channel === 9 ? pack.manifest.defaultDrumPatchId || pack.manifest.defaultPatchId : pack.manifest.defaultPatchId
  const fallback = fallbackId && pack.byId.get(fallbackId)
  return resolved(pack, address, fallback, fallback ? 'default' : 'unresolved')
}

export { PERCUSSION_PROFILE }

function resolved(pack, address, patch, source) {
  return {
    patch: patch || null,
    source,
    selection: {
      packId: pack.id,
      packVersion: pack.version,
      patchId: patch?.id || null,
      bankMsb: address.bankMsb,
      bankLsb: address.bankLsb,
      program: address.program,
      source: 'midi',
      unresolved: !patch,
    },
  }
}

/**
 * 'ready' | 'unavailable' | 'missing' for one patch of a compiled pack.
 * Readability is a property of the pack's origin — a browser pack plays without
 * Electron and an Electron pack does not play without it — so the caller hands
 * over the loader lookup rather than a "have we got Electron" flag.
 */
export function packPatchState(pack, patchId, loaderFor) {
  if (!pack?.byId?.get(patchId)) return 'missing'
  return loaderFor(pack) ? 'ready' : 'unavailable'
}
