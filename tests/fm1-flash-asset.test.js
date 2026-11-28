import { describe, it, expect } from 'vitest'
import {
  encodeFlashAsset, decodeFlashAsset, packRestore, unpackRestore, changedSectors,
  FLASH_EXT, EXPORT_EXT, SECTOR, FLASH_SIZE,
} from '../src/renderer/js/fm1/flash-asset.js'
import { createFlashGate } from '../src/renderer/js/fm1/host-core.js'
import { sha256Hex } from '../src/renderer/js/fm1/sha256.js'

const HASH = 'sha256:' + 'ab'.repeat(32)
const sector = (fill) => new Uint8Array(SECTOR).fill(fill)
const recs = [{ offset: 0xdc000, bytes: sector(7) }, { offset: 0, bytes: sector(0xff) }]

// a hand-built asset with a valid trailing checksum, so the checks after it can be reached
function build({ magic = 'SFM1', version = 1, hash = 'ab', count, records = [], extra = 0 }) {
  const body = 40 + records.length * 4100 + extra
  const b = new Uint8Array(body + 32)
  const v = new DataView(b.buffer)
  b.set([...magic].map(c => c.charCodeAt(0)), 0)
  v.setUint16(4, version, true)
  b.fill(parseInt(hash, 16), 6, 38)
  v.setUint16(38, count ?? records.length, true)
  records.forEach((r, i) => { v.setUint32(40 + i * 4100, r.offset, true); b.set(r.bytes, 44 + i * 4100) })
  b.set(Uint8Array.from(sha256Hex(b.subarray(0, body)).match(/../g), h => parseInt(h, 16)), body)
  return b
}

describe('fm1 flash asset codec', () => {
  it('round trips records and names its extensions', () => {
    const bytes = encodeFlashAsset({ firmwareHash: HASH, records: recs })
    expect(bytes.length).toBe(40 + 2 * 4100 + 32)
    const got = decodeFlashAsset(bytes, { firmwareHash: HASH })
    expect(got.ok).toBe(true)
    expect(got.records.map(r => r.offset)).toEqual([0xdc000, 0])
    expect(got.records[0].bytes).toEqual(sector(7))
    expect(decodeFlashAsset(encodeFlashAsset({ firmwareHash: HASH, records: [] }), { firmwareHash: HASH })).toEqual({ ok: true, records: [] })
    expect([FLASH_EXT, EXPORT_EXT]).toEqual(['.flash', '.fm1flash'])
  })

  it('reports every failure reason', () => {
    const good = encodeFlashAsset({ firmwareHash: HASH, records: recs })
    const reason = (b, h = HASH) => decodeFlashAsset(b, { firmwareHash: h }).reason
    expect(reason(new Uint8Array(71))).toBe('too-small')
    expect(reason(build({ magic: 'XFM1' }))).toBe('bad-magic')
    expect(reason(build({ version: 2 }))).toBe('bad-version')
    const flipped = good.slice(); flipped[100] ^= 1
    expect(reason(flipped)).toBe('bad-checksum')
    expect(reason(good, 'sha256:' + 'cd'.repeat(32))).toBe('wrong-firmware')
    expect(reason(good, 'nonsense')).toBe('wrong-firmware')
    expect(reason(build({ count: 257 }))).toBe('too-many')
    expect(reason(build({ count: 2, records: recs.slice(0, 1) }))).toBe('bad-record')            // short
    expect(reason(build({ records: [{ offset: 5, bytes: sector(1) }] }))).toBe('bad-record')     // unaligned
    expect(reason(build({ records: [{ offset: FLASH_SIZE, bytes: sector(1) }] }))).toBe('bad-record')
    expect(reason(build({ records: [recs[0], recs[0]] }))).toBe('bad-record')                    // duplicate
  })

  it('takes 256 records, refuses 257', () => {
    const all = Array.from({ length: 256 }, (_, i) => ({ offset: i * SECTOR, bytes: sector(i & 255) }))
    const got = decodeFlashAsset(encodeFlashAsset({ firmwareHash: HASH, records: all }), { firmwareHash: HASH })
    expect(got.ok && got.records.length).toBe(256)
    expect(() => encodeFlashAsset({ firmwareHash: HASH, records: [...all, { offset: 0, bytes: sector(0) }] })).toThrow(/too-many/)
  })

  it('never throws on garbage (fuzz)', () => {
    let seed = 1
    const rnd = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32
    const good = encodeFlashAsset({ firmwareHash: HASH, records: recs })
    for (let i = 0; i < 300; i++) {
      const b = i % 2 ? good.slice(0, Math.floor(rnd() * good.length)) : new Uint8Array(Math.floor(rnd() * 9000)).map(() => rnd() * 256)
      if (i % 3 === 0) for (let k = 0; k < 4; k++) if (b.length) b[Math.floor(rnd() * b.length)] ^= 0xff
      const got = decodeFlashAsset(b, { firmwareHash: HASH })
      expect(typeof got.ok).toBe('boolean')
      if (!got.ok) expect(got.reason).toMatch(/^(too-small|bad-magic|bad-version|bad-checksum|wrong-firmware|too-many|bad-record)$/)
    }
  })

  it('packRestore is the fm1_flash_restore wire; unpack inverts it', () => {
    const p = packRestore(recs)
    expect(p.length).toBe(2 * 4100)
    expect(new DataView(p.buffer).getUint32(0, true)).toBe(0xdc000)
    expect(p[4]).toBe(7)
    expect(unpackRestore(p)).toEqual(recs)
    expect(() => packRestore([{ offset: 3, bytes: sector(0) }])).toThrow()
  })

  it('changedSectors: differing sectors only, erased ones included, copies', () => {
    const base = new Uint8Array(FLASH_SIZE), flash = base.slice()
    flash[SECTOR * 3 + 10] = 1
    flash.fill(0xff, SECTOR * 9, SECTOR * 10)
    const got = changedSectors(base, flash)
    expect(got.map(r => r.offset)).toEqual([SECTOR * 3, SECTOR * 9])
    flash[SECTOR * 3 + 10] = 2
    expect(got[0].bytes[10]).toBe(1)
  })
})

describe('createFlashGate (worker snapshot timing)', () => {
  it('answers once the flash is quiet 250 ms and not busy', () => {
    const g = createFlashGate({ revision: 4 })
    g.observe(5, 1000)
    g.request({ request: 1, since: 4 }, 1010)
    expect(g.take(false, 1200)).toEqual([])
    expect(g.take(true, 1300)).toEqual([])               // SPI command in flight
    expect(g.take(false, 1300)).toEqual([{ request: 1, since: 4, ok: true }])
    expect(g.take(false, 1400)).toEqual([])
    expect(g.revision).toBe(5)
  })

  it('a firmware that keeps writing times out at 1.5 s', () => {
    const g = createFlashGate({ revision: 0 })
    g.request({ request: 7 }, 0)
    for (let t = 0; t < 1500; t += 100) { g.observe(t + 1, t); expect(g.take(false, t)).toEqual([]) }
    expect(g.take(false, 1500)).toEqual([{ request: 7, ok: false }])
  })

  it('an untouched flash answers at once', () => {
    const g = createFlashGate({ revision: 3 })
    g.request({ request: 1, since: 3 }, 50)
    expect(g.take(false, 50)).toEqual([{ request: 1, since: 3, ok: true }])
  })
})
