// Synthetic .fwsc builder for parser tests (no real firmware is ever committed).
import { unmask, crc16, chipKey, xorArea, areaFirst } from '../../src/renderer/js/fm1/fwsc.js'

const u16 = v => [v & 255, (v >>> 8) & 255]
const u32 = v => [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255]

function jlfsHead({ name, offset, size, flags, last }) {
  const h = new Uint8Array(32)
  h.set(u32(offset), 4)
  h.set(u32(size), 8)
  h[12] = flags
  h.set(u16(last ? 1 : 0), 14)
  for (let i = 0; i < name.length; i++) h[16 + i] = name.charCodeAt(i)
  return h
}

/**
 * @param {object} o
 * @param {string} [o.identity] header identity, e.g. 'FM-1_918'
 * @param {boolean} [o.corruptCrc] break the header CRC
 * @param {number} [o.truncate] cut the file to this many bytes
 * @param {boolean} [o.omitAppBin] app directory without app.bin
 * @param {boolean} [o.omitFlash] no type-0 entry
 * @param {boolean} [o.omitArea] no app_dir_head
 * @param {boolean} [o.omitConfig] no isd_config.ini
 * @param {number} [o.areaOffset] app area start inside the flash image (default 256)
 * @param {number} [o.appLength] app.bin payload bytes (default 100)
 * @param {number} [o.blocks] header blocks (default 20)
 * @returns {{ bytes: Uint8Array, appBin: Uint8Array }}
 */
export function buildFwsc({
  identity = 'FM-1_918', corruptCrc = false, truncate = null, omitAppBin = false, omitFlash = false,
  omitArea = false, omitConfig = false, areaOffset = 256, appLength = 100, blocks = 20
} = {}) {
  const appBin = new Uint8Array(appLength).map((_, i) => (i % 250) + 1) // never 0xFF
  const cfgOff = 128
  const blob = new Uint8Array(34)
  for (let i = 0; i < 32; i++) blob[i] = (i * 37 + 11) & 255
  blob.set(u16(crc16(blob, 0, 32)), 32)
  const key = chipKey(blob)

  // app area (plaintext): head, directory, app.bin payload at 128 padded with 0xFF
  const areaSize = 128 + appLength + 16
  const area = new Uint8Array(areaSize).fill(0xff)
  area.fill(0, 0, 128)
  area.set(jlfsHead({ name: 'app_dir_head', offset: 0, size: areaSize, flags: 0x81, last: true }), 0)
  area.set(jlfsHead({ name: omitAppBin ? 'other.bin' : 'app.bin', offset: 128, size: appLength + 16, flags: 0x82, last: true }), 32)
  area.set(appBin, 128)

  const flash = new Uint8Array(areaOffset + areaSize)
  const heads = []
  if (!omitConfig) heads.push({ name: 'isd_config.ini', offset: cfgOff, size: 34, flags: 0, last: false })
  if (!omitArea) heads.push({ name: 'app_dir_head', offset: areaOffset, size: areaSize, flags: 0x81, last: false })
  if (!heads.length) heads.push({ name: 'nothing', offset: 0, size: 0, flags: 0, last: false })
  heads.forEach((h, i) => {
    h.last = i === heads.length - 1
    const bytes = jlfsHead(h)
    unmask(bytes, 0, 32)
    flash.set(bytes, 32 + i * 32)
  })
  flash.set(blob, cfgOff)
  flash.set(area, areaOffset)
  xorArea(flash, areaOffset, areaOffset, areaFirst(areaOffset), key)
  if (areaSize > areaFirst(areaOffset)) xorArea(flash, areaOffset, areaOffset + areaFirst(areaOffset), areaSize - areaFirst(areaOffset), key)

  // UFW header (0x40) + one entry (0x50), padded to blocks * 0x2F; flash starts right after it
  const hdrLen = blocks * 0x2f
  const hdr = new Uint8Array(hdrLen)
  hdr.set(u16(omitFlash ? 0 : 1), 8)
  hdr.set(u16(crc16(hdr, 2, 0x3e)), 0)
  if (corruptCrc) hdr[0] ^= 0xff
  unmask(hdr, 0, 0x40)
  const entry = new Uint8Array(0x50)
  entry.set(u16(omitFlash ? 7 : 0), 0)
  entry.set(u32(hdrLen), 8)
  entry.set(u32(flash.length), 12)
  unmask(entry, 0, 0x50)
  hdr.set(entry, 0x40)

  const file = new Uint8Array(blocks * 0x30 + flash.length)
  for (let i = 0; i < blocks; i++) {
    file.set(hdr.subarray(i * 0x2f, i * 0x2f + 0x2f), i * 0x30)
    file[i * 0x30 + 0x2f] = i < identity.length ? (identity.charCodeAt(i) + i + 1) & 255 : 0x7d
  }
  file.set(flash, blocks * 0x30)
  return { bytes: truncate == null ? file : file.slice(0, truncate), appBin }
}
