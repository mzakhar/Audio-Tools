// smc-pad-sysex.js — PURE M-Vave SMC-PAD vendor SysEx codec (clean-room).
//
// Logical packet: 00 59 <cmd> <len24le> <data> <~sum(data) & 0xFF>, bit-packed
// LSB-first into 7-bit bytes between F0 and F7. Only three commands are built
// here: identity (0x11), flash read (0x23) and a working-memory RGB write
// (0x22). The device's save command is deliberately absent: writes must never
// persist, a power cycle restores the factory colours.
// Facts and tests behind every constant: specs/pads-view.md (SMC-PAD sections).

export const CMD = { ACK: 0x00, IDENTITY: 0x11, WRITE: 0x22, READ: 0x23 }

export const CONFIG_REGION = 5
export const MODE_REGION = 4
export const PROFILE_SIZE = 3539
export const RECORDS = 128          // 8 banks × 16 pads per profile
const RECORD_BASE = 211
const RECORD_SIZE = 26
const RGB_OFFSET = 5
const READ_CHUNK = 390              // 15 records; replies over ~1 KB truncate on WinMM
const READ_HEADER = 8               // a read reply's data starts with an echo header

export function pack7(bytes) {
  const out = []
  let acc = 0, bits = 0
  for (const b of bytes) {
    acc |= b << bits; bits += 8
    while (bits >= 7) { out.push(acc & 0x7f); acc >>= 7; bits -= 7 }
  }
  if (bits) out.push(acc & 0x7f)
  return out
}

export function unpack7(bytes) {
  const out = []
  let acc = 0, bits = 0
  for (const b of bytes) {
    acc |= (b & 0x7f) << bits; bits += 7
    while (bits >= 8) { out.push(acc & 0xff); acc >>= 8; bits -= 8 }
  }
  return out
}

const le = (value, n) => Array.from({ length: n }, (_, i) => (value >>> (8 * i)) & 0xff)
const checksum = data => ~data.reduce((sum, b) => sum + b, 0) & 0xff

export function packet(cmd, data = []) {
  return [0xf0, ...pack7([0x00, 0x59, cmd, ...le(data.length, 3), ...data, checksum(data)]), 0xf7]
}

export const identityRequest = () => packet(CMD.IDENTITY)
export const readRequest = (region, addr, len) => packet(CMD.READ, [region, ...le(addr, 4), ...le(len, 3)])
export const rgbWrite = (addr, [r, g, b]) => packet(CMD.WRITE, [CONFIG_REGION, ...le(addr, 4), 3, 0, 0, r, g, b])

/** Raw SysEx from the device → { cmd, data }, or null if it is not a valid vendor packet. */
export function parseReply(bytes) {
  if (bytes[0] !== 0xf0 || bytes[bytes.length - 1] !== 0xf7) return null
  const logical = unpack7(bytes.slice(1, -1))
  if (logical[0] !== 0x00 || logical[1] !== 0x59) return null
  const len = logical[3] | logical[4] << 8 | logical[5] << 16
  if (logical.length < 7 + len) return null
  const data = logical.slice(6, 6 + len)
  if (logical[6 + len] !== checksum(data)) return null
  return { cmd: logical[2], data }
}

/** A read reply's payload, header stripped. */
export const readPayload = reply => reply.data.slice(READ_HEADER)

export const isIdentity = reply => String.fromCharCode(...reply.data).includes('SMC-PAD')

/** Region 4: byte 6 = mode (1 user preset, 2 Performance), byte 10 = active profile. */
export function parseMode(payload) {
  const mode = payload[6]
  return { user: mode === 1, mode, profile: payload[10] }
}

export const recordAddr = (profile, rec) => profile * PROFILE_SIZE + RECORD_BASE + rec * RECORD_SIZE

/** Reads covering all pad records of a profile, each small enough not to truncate. */
export function recordReads(profile) {
  const start = recordAddr(profile, 0)
  const total = RECORDS * RECORD_SIZE
  const reads = []
  for (let off = 0; off < total; off += READ_CHUNK) {
    reads.push({ addr: start + off, len: Math.min(READ_CHUNK, total - off) })
  }
  return reads
}

/** Concatenated record bytes → [{ rec, pad, channel, note, rgb }]. Record: 00 <ch> <note> 00 7f R G B ff … */
export function parseRecords(bytes) {
  const records = []
  for (let rec = 0; rec * RECORD_SIZE + RECORD_SIZE <= bytes.length; rec++) {
    const r = bytes.slice(rec * RECORD_SIZE, rec * RECORD_SIZE + RECORD_SIZE)
    records.push({ rec, pad: rec % 16, channel: r[1], note: r[2], rgb: r.slice(RGB_OFFSET, RGB_OFFSET + 3) })
  }
  return records
}

/** Incoming device note → kit pad note (36 + pad), so any bank and any stored map plays the kit. */
export function padNoteMap(records) {
  const map = new Map()
  for (const { note, pad } of records) if (note < 128 && !map.has(note)) map.set(note, 36 + pad)
  return map
}

/** Writes that paint every bank's pad i with colours[i], skipping records already that colour. */
export function paintPlan(profile, records, colours) {
  return records
    .filter(({ pad, rgb }) => colours[pad] && colours[pad].some((c, i) => c !== rgb[i]))
    .map(({ rec, pad }) => ({ rec, addr: recordAddr(profile, rec) + RGB_OFFSET, rgb: colours[pad] }))
}
