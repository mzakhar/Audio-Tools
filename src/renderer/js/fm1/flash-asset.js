// FM-1 flash persistence, pure. A device's saves are the 4 KiB flash sectors that differ from the
// booted package image (fm1_flash_base); they are restored with fm1_flash_restore right after boot.
//
// Asset file (`<project>/fm1/<id>.flash`, or a `.fm1flash` export), all little-endian:
//   "SFM1" | u16 version (1) | 32 B firmware sha256 | u16 record count (<= 256)
//   | count x (u32 offset, 4096 B sector) | 32 B sha256 of everything before it
// Restore wire (fm1_flash_restore): the records alone, back to back.
import { sha256Hex } from './sha256.js'

export const FLASH_EXT = '.flash'
export const EXPORT_EXT = '.fm1flash'
export const SECTOR = 4096
export const FLASH_SIZE = 1 << 20
export const MAX_RECORDS = FLASH_SIZE / SECTOR
const RECORD = 4 + SECTOR
const MAGIC = [0x53, 0x46, 0x4d, 0x31]   // "SFM1"
const VERSION = 1
const HEAD = 4 + 2 + 32 + 2
const SUM = 32

const hexToBytes = (hex) => Uint8Array.from(hex.match(/../g), (h) => parseInt(h, 16))
function hashBytes(firmwareHash) {
  const hex = String(firmwareHash).replace(/^sha256:/, '')
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error(`fm1 flash: bad firmware hash ${firmwareHash}`)
  return hexToBytes(hex.toLowerCase())
}

// Every 4 KiB sector of flash that differs from base (erased sectors included), as records.
export function changedSectors(base, flash) {
  const records = []
  for (let at = 0; at < FLASH_SIZE; at += SECTOR) {
    for (let i = at; i < at + SECTOR; i++) {
      if (base[i] !== flash[i]) { records.push({ offset: at, bytes: flash.slice(at, at + SECTOR) }); break }
    }
  }
  return records
}

// null when valid, else why not: aligned, in range, unique, whole sectors, at most 256.
function recordsProblem(records) {
  if (records.length > MAX_RECORDS) return 'too-many'
  const seen = new Set()
  for (const { offset, bytes } of records) {
    if (!Number.isInteger(offset) || offset < 0 || offset % SECTOR || offset >= FLASH_SIZE || seen.has(offset)) return 'bad-record'
    if (!(bytes instanceof Uint8Array) || bytes.length !== SECTOR) return 'bad-record'
    seen.add(offset)
  }
  return null
}

function writeRecords(out, at, records) {
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength)
  for (const { offset, bytes } of records) {
    view.setUint32(at, offset, true)
    out.set(bytes, at + 4)
    at += RECORD
  }
}

// The fm1_flash_restore format. Throws on invalid records (a caller bug).
export function packRestore(records) {
  const why = recordsProblem(records)
  if (why) throw new Error(`fm1 flash: ${why}`)
  const out = new Uint8Array(records.length * RECORD)
  writeRecords(out, 0, records)
  return out
}

// Inverse of packRestore (the Worker's snapshot wire). Copies.
export function unpackRestore(packed) {
  const bytes = packed instanceof Uint8Array ? packed : new Uint8Array(packed)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const records = []
  for (let at = 0; at + RECORD <= bytes.length; at += RECORD) {
    records.push({ offset: view.getUint32(at, true), bytes: bytes.slice(at + 4, at + RECORD) })
  }
  return records
}

export function encodeFlashAsset({ firmwareHash, records }) {
  const why = recordsProblem(records)
  if (why) throw new Error(`fm1 flash: ${why}`)
  const body = HEAD + records.length * RECORD
  const out = new Uint8Array(body + SUM)
  const view = new DataView(out.buffer)
  out.set(MAGIC, 0)
  view.setUint16(4, VERSION, true)
  out.set(hashBytes(firmwareHash), 6)
  view.setUint16(38, records.length, true)
  writeRecords(out, HEAD, records)
  out.set(hexToBytes(sha256Hex(out.subarray(0, body))), body)
  return out
}

// -> { ok:true, records } | { ok:false, reason }. Never throws.
export function decodeFlashAsset(bytes, { firmwareHash }) {
  try {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
    if (b.length < HEAD + SUM) return { ok: false, reason: 'too-small' }
    if (MAGIC.some((m, i) => b[i] !== m)) return { ok: false, reason: 'bad-magic' }
    const view = new DataView(b.buffer, b.byteOffset, b.byteLength)
    if (view.getUint16(4, true) !== VERSION) return { ok: false, reason: 'bad-version' }
    const body = b.length - SUM
    const sum = hexToBytes(sha256Hex(b.subarray(0, body)))
    if (sum.some((v, i) => b[body + i] !== v)) return { ok: false, reason: 'bad-checksum' }
    let want
    try { want = hashBytes(firmwareHash) } catch { return { ok: false, reason: 'wrong-firmware' } }
    if (want.some((v, i) => b[6 + i] !== v)) return { ok: false, reason: 'wrong-firmware' }
    const count = view.getUint16(38, true)
    if (count > MAX_RECORDS) return { ok: false, reason: 'too-many' }
    if (body !== HEAD + count * RECORD) return { ok: false, reason: 'bad-record' }
    const records = unpackRestore(b.subarray(HEAD, body))
    const why = recordsProblem(records)
    return why ? { ok: false, reason: why } : { ok: true, records }
  } catch {
    return { ok: false, reason: 'bad-record' }
  }
}
