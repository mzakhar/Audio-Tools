// Bounded, pure validator for FM-1 update packages (.fwsc). Never throws.
//
// Container logic (unmask, crc16, chipKey, JLFS heads, app-area unscramble) is ported from
// fm1-emu web/fwsc.js and crates/fm1-soc/src/fwsc.rs, MIT, Copyright (c) 2026 Joakim Eriksson,
// https://github.com/joakimeriksson/fm1-emu pinned at 69cb1ef. Differences: every length and
// offset is bounds-checked, block count follows the Rust container() rule, and the target
// device is read from the header block marker bytes.

export const MIN_PACKAGE = 960 // 20 blocks * 0x30
export const MAX_PACKAGE = 8 * 1024 * 1024
const BLOCK = 0x30
const MAX_BLOCKS = 64

export function unmask(buf, off, len, key = 0xffff) {
  for (let i = 0; i < len; i++) {
    buf[off + i] ^= key & 0xff
    key = ((key << 1) ^ (key & 0x8000 ? 0x1021 : 0)) & 0xffff
  }
}

export function crc16(buf, off, len) {
  let crc = 0
  for (let i = 0; i < len; i++) {
    crc ^= buf[off + i] << 8
    for (let b = 0; b < 8; b++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff
  }
  return crc
}

const u16 = (b, o) => b[o] | (b[o + 1] << 8)
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0
const cstr = (b, o, n) => {
  let s = ''
  for (let i = 0; i < n && b[o + i]; i++) s += String.fromCharCode(b[o + i])
  return s
}
const head = (b, o) => ({ offset: u32(b, o + 4), size: u32(b, o + 8), flags: b[o + 12], last: u16(b, o + 14), name: cstr(b, o + 16, 16) })

export function chipKey(blob) {
  let sum = 0
  for (let i = 0; i < 16; i++) sum += blob[i]
  sum &= 0xff
  if (sum >= 0xe0) sum = 0xaa
  else if (sum <= 0x10) sum = 0x55
  let key = 0
  for (let i = 0; i < 16; i++) if ((blob[16 + i] ^ blob[15 - i]) < sum) key |= 1 << i
  return key
}

// XOR keystream per 32-byte block, keyed by position in the area (symmetric: scrambles and unscrambles)
export function xorArea(buf, base, from, len, key) {
  for (let i = 0; i < len; i += 32) unmask(buf, from + i, Math.min(32, len - i), key ^ ((from + i - base) >> 2))
}

export const areaFirst = area => 32 + ((32 - (area % 32)) % 32)

const fail = reason => ({ ok: false, reason })

// Identity from the marker byte (last of each block): marker[i] = char[i] + i + 1, then 0x7D padding.
function readIdentity(bytes, blocks) {
  let s = ''
  for (let i = 0; i < blocks; i++) {
    const m = bytes[i * BLOCK + 0x2f]
    if (m === 0x7d) break
    const c = (m - (i + 1)) & 0xff
    if (c < 0x20 || c > 0x7e) return null
    s += String.fromCharCode(c)
  }
  return s || null
}

function parseWith(bytes, blocks) {
  const len = bytes.length
  if (blocks * BLOCK > len) return fail('bad-header')
  const hdrLen = blocks * 0x2f
  const hdr = new Uint8Array(hdrLen)
  for (let i = 0; i < blocks; i++) hdr.set(bytes.subarray(i * BLOCK, i * BLOCK + 0x2f), i * 0x2f)
  const ufw = hdr.slice(0, 0x40)
  unmask(ufw, 0, 0x40)
  if (crc16(ufw, 2, 0x3e) !== u16(ufw, 0)) return fail('bad-header')

  const identity = readIdentity(bytes, blocks)
  if (identity === null) return fail('bad-header')
  const us = identity.lastIndexOf('_')
  const target = us < 0 ? identity : identity.slice(0, us)
  const product = us < 0 ? '' : identity.slice(us + 1)
  if (target !== 'FM-1') return { ...fail('unsupported-target'), identity }

  const entries = Math.min(u16(ufw, 8), Math.floor((hdrLen - 0x40) / 0x50))
  let off = -1
  let flen = 0
  for (let k = 0; k < entries; k++) {
    const e = hdr.slice(0x40 + k * 0x50, 0x90 + k * 0x50)
    unmask(e, 0, 0x50)
    if (u16(e, 0) === 0) { off = u32(e, 8); flen = u32(e, 12); break }
  }
  if (off < 0) return fail('no-flash-image')

  // stream = hdr + file after the header blocks
  const streamLen = hdrLen + (len - blocks * BLOCK)
  if (flen > MAX_PACKAGE || off + flen > streamLen) return fail('truncated')
  const flash = new Uint8Array(flen)
  for (let i = 0; i < flen;) {
    const at = off + i
    if (at < hdrLen) {
      const n = Math.min(hdrLen - at, flen - i)
      flash.set(hdr.subarray(at, at + n), i)
      i += n
    } else {
      const f = blocks * BLOCK + at - hdrLen
      flash.set(bytes.subarray(f, f + flen - i), i)
      i = flen
    }
  }

  // JLFS directory: chip key + app area
  if (flen < 64) return fail('no-app-area')
  unmask(flash, 0, 32)
  let key = null
  let fallbackKey = null
  let area = null
  for (let o = 32; o + 32 <= flen; o += 32) {
    unmask(flash, o, 32)
    const h = head(flash, o)
    if (h.name === 'isd_config.ini' && h.offset + 34 <= flen) {
      const k = chipKey(flash.subarray(h.offset, h.offset + 32))
      if (crc16(flash, h.offset, 32) === u16(flash, h.offset + 32)) key = k
      else fallbackKey ??= k // upstream is soft on this CRC
    }
    if (h.name === 'app_dir_head' && h.flags === 0x81 && area === null) area = h.offset
    if (h.last) break
  }
  key ??= fallbackKey
  if (key === null || area === null) return fail('no-app-area')

  const first = areaFirst(area)
  if (area + first > flen) return fail('no-app-area')
  xorArea(flash, area, area, first, key) // reveals the area head, which holds the area size
  const size = head(flash, area).size
  if (area + size > flen) return fail('no-app-area')
  if (size > first) xorArea(flash, area, area + first, size - first, key)

  for (let o = area + 32; o + 32 <= area + size; o += 32) {
    const h = head(flash, o)
    if (h.name === 'app.bin' && h.flags === 0x82) {
      if (h.size === 0 || h.offset + h.size > size) return fail('no-app-bin')
      let end = h.size
      while (end > 0 && flash[area + h.offset + end - 1] === 0xff) end--
      return { ok: true, identity, target, product, size: len, blocks, appBinSize: end }
    }
    if (h.last) break
  }
  return fail('no-app-bin')
}

/** @param {Uint8Array|ArrayBuffer} input */
export function parseFwsc(input) {
  try {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input)
    if (bytes.length < MIN_PACKAGE) return fail('too-small')
    if (bytes.length > MAX_PACKAGE) return fail('too-large')
    let blocks = 20
    while (blocks < MAX_BLOCKS && (blocks + 1) * BLOCK <= bytes.length && bytes[blocks * BLOCK + 0x2f] === 0x7d) blocks++
    const r = parseWith(bytes, blocks)
    if (!r.ok && blocks !== 20) {
      const r20 = parseWith(bytes, 20)
      return r20.ok ? r20 : r
    }
    return r
  } catch {
    return fail('bad-header')
  }
}
