// project-flash.js — FM-1 device flash and the project: the save sequence, the reader a session
// boots from, and Export / Import device state. Every IO is a passed-in function, so the order
// (assets first, project.json last: the commit point) is testable with fakes.
import { encodeFlashAsset, decodeFlashAsset, FLASH_EXT } from './flash-asset.js'
import { ClearTrackFlashAsset } from '../store/ProjectStore.js'

const label = track => track?.name || 'MIDI'

/**
 * Save the project: snapshot every track device, write one NEW asset per changed device, point
 * the tracks at them (one store update, no undo entry), write project.json, then mark the
 * devices saved. A device that timed out or whose asset failed to write keeps its previous
 * asset; project.json is written regardless.
 * deps: getState() → state, snapshotAll() → Map<trackId, snapshot>, writeFlash(name, bytes),
 *       commit([{ trackId, assetId, firmwareHash }]), writeProject(state), getSession(trackId), newId()
 * Resolves { messages: string[] } — one per track whose device state was not saved.
 */
export async function saveProject({ getState, snapshotAll, writeFlash, commit, writeProject, getSession, newId }) {
  const messages = []
  const written = []
  const results = (await snapshotAll?.()) ?? new Map()
  const tracks = new Map(getState().tracks.filter(t => t.instrument?.type === 'fm1').map(t => [t.id, t]))
  for (const [trackId, result] of results) {
    const track = tracks.get(trackId)
    if (!track || !result) continue
    if (!result.ok) {
      if (result.reason === 'busy-timeout') messages.push(`FM-1 on ${label(track)}: device busy, previous state kept`)
      continue   // 'not-ready' / 'unsupported': nothing to save
    }
    if (!result.changed) continue
    const { firmwareHash } = track.instrument
    const assetId = newId()
    try {
      await writeFlash(`${assetId}${FLASH_EXT}`, encodeFlashAsset({ firmwareHash, records: result.records }))
      written.push({ trackId, assetId, firmwareHash, revision: result.revision })
    } catch (e) {
      messages.push(`FM-1 on ${label(track)}: device state not saved (${e?.message || 'write failed'}), previous state kept`)
    }
  }
  if (written.length) commit(written.map(({ trackId, assetId, firmwareHash }) => ({ trackId, assetId, firmwareHash })))
  await writeProject(getState())
  for (const { trackId, revision } of written) getSession(trackId)?.markFlashSaved(revision)
  return { messages }
}

/**
 * The `readFlash(descriptor)` a session boots from: null when the track has no saved state,
 * else the raw asset bytes (the session decodes them against the firmware hash). A referenced
 * file that cannot be found — or no project folder to find it in — throws Error('flash-missing').
 */
export const flashReader = ({ getDir, readFm1Flash }) => async descriptor => {
  const id = descriptor?.flashAssetId
  if (!id) return null
  const dir = getDir()
  const bytes = dir ? await readFm1Flash(dir, `${id}${FLASH_EXT}`).catch(() => null) : null
  if (!bytes) throw new Error('flash-missing')
  return bytes
}

/** True when any of these tracks' devices has flash changes not yet saved. */
export const anyFlashDirty = (sessions, trackIds) => trackIds.some(id => !!sessions?.get(id)?.status?.().flash?.dirty)

/** Export device state: { ok:true, bytes } (a .fm1flash file) or { ok:false, reason }. */
export async function exportDeviceState(session, firmwareHash) {
  if (!session) return { ok: false, reason: 'not-ready' }
  const result = await session.snapshotFlash()
  if (!result.ok) return result
  return { ok: true, bytes: encodeFlashAsset({ firmwareHash, records: result.records }) }
}

/** Import device state: validate against the track's firmware, then re-boot the device from it. */
export async function importDeviceState(session, bytes, firmwareHash) {
  if (!session) return { ok: false, reason: 'not-ready' }
  const decoded = decodeFlashAsset(bytes, { firmwareHash })
  if (!decoded.ok) return decoded
  await session.importFlash(decoded.records)
  return { ok: true }
}

/**
 * "Start from firmware defaults": an undoable store edit that forgets the saved state (the file
 * stays on disk), then a re-acquire — the device sig ignores flashAssetId, so nothing else reboots it.
 */
export function resetDeviceState(trackId, { dispatch, reacquire }) {
  dispatch(ClearTrackFlashAsset(trackId))
  reacquire(trackId)
}

const REASON_TEXT = {
  'busy-timeout': 'the device is busy, try again',
  'not-ready': 'the device is not running',
  unsupported: 'this device cannot export its state',
  'wrong-firmware': 'it belongs to a different firmware',
  'too-small': 'not a device state file',
  'bad-magic': 'not a device state file',
  'bad-version': 'made by a newer version',
  'bad-checksum': 'the file is damaged',
  'too-many': 'the file is damaged',
  'bad-record': 'the file is damaged'
}
export const flashReasonText = reason => REASON_TEXT[reason] || reason || 'unknown error'
