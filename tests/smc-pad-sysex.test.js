import { describe, it, expect } from 'vitest'
import {
  CMD, packet, pack7, unpack7, identityRequest, readRequest, rgbWrite, parseReply, readPayload,
  isIdentity, parseMode, recordAddr, recordReads, parseRecords, padNoteMap, paintPlan, RECORDS
} from '../src/renderer/js/pads/smc-pad-sysex.js'
import { createSmcPadLink } from '../src/renderer/js/pads/smc-pad-link.js'
import { kitFor, padColours, DEFAULT_KIT_ID } from '../src/renderer/js/pads/kit.js'

// Byte vectors from the Python probe that drove the real device (2026-11-26).
describe('codec matches the hardware-proven packets', () => {
  it('identity', () => {
    expect(identityRequest()).toEqual([0xf0, 0x00, 0x32, 0x45, 0x00, 0x00, 0x00, 0x40, 0x7f, 0xf7])
  })
  it('region 4 read', () => {
    expect(readRequest(4, 0, 12)).toEqual([0xf0, 0x00, 0x32, 0x0d, 0x41, 0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x00, 0x40, 0x01, 0x00, 0x00, 0x6f, 0x01, 0xf7])
  })
  it('rgb write to profile 2 record 16', () => {
    expect(rgbWrite(recordAddr(2, 16) + 5, [0xff, 0, 0])).toEqual([0xf0, 0x00, 0x32, 0x09, 0x59, 0x00, 0x00, 0x40, 0x02, 0x1e, 0x3c, 0x00, 0x00, 0x30, 0x00, 0x00, 0x00, 0x7f, 0x01, 0x00, 0x60, 0x0b, 0xf7])
  })
  it('never emits the save command', () => {
    const save = [0xf0, 0x00, 0x32, 0x09, 0x41, 0x00, 0x00, 0x40, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x7a, 0x01, 0xf7]
    expect(rgbWrite(0, [0, 0, 0])).not.toEqual(save)
    expect(Object.values(CMD)).toEqual([0x00, 0x11, 0x22, 0x23])
  })
})

describe('parseReply', () => {
  it('round-trips a packet', () => {
    expect(parseReply(packet(0x23, [1, 2, 3, 250]))).toEqual({ cmd: 0x23, data: [1, 2, 3, 250] })
  })
  it('rejects a bad checksum and foreign SysEx', () => {
    const logical = unpack7(packet(0x00, [0]).slice(1, -1))
    logical[logical.length - 2] ^= 1
    expect(parseReply([0xf0, ...pack7(logical), 0xf7])).toBeNull()
    expect(parseReply([0xf0, 0x7e, 0x7f, 0x06, 0x02, 0xf7])).toBeNull()
  })
  it('identity text', () => {
    expect(isIdentity({ data: [...'SMC-PAD_004'].map(c => c.charCodeAt(0)) })).toBe(true)
  })
})

describe('config layout', () => {
  it('region 4: Performance vs user preset', () => {
    expect(parseMode([0x78, 0, 0x32, 4, 0, 0, 2, 0, 2, 1, 6, 0])).toEqual({ user: false, mode: 2, profile: 6 })
    expect(parseMode([0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 2, 0]).user).toBe(true)
  })
  it('record reads cover all 128 records in chunks under 400 bytes', () => {
    const reads = recordReads(2)
    expect(reads[0].addr).toBe(recordAddr(2, 0))
    expect(reads.reduce((n, r) => n + r.len, 0)).toBe(RECORDS * 26)
    expect(reads.every(r => r.len < 400)).toBe(true)
  })
})

/** Records like the factory profile: record r plays note 4 + r on ch 10. */
function factoryRecords(colour = [0xf0, 0xf0, 0]) {
  const bytes = []
  for (let r = 0; r < RECORDS; r++) bytes.push(0, 9, (4 + r) & 0xff, 0, 0x7f, ...colour, 0xff, ...new Array(17).fill(0))
  return bytes
}

describe('note map and paint plan', () => {
  it('maps any bank onto kit notes 36–51', () => {
    const map = padNoteMap(parseRecords(factoryRecords()))
    expect(map.get(20)).toBe(36)   // user preset bank 1 pad 1 (record 16)
    expect(map.get(35)).toBe(51)
    expect(map.get(36)).toBe(36)   // record 32 = Performance bank, identity
    expect(map.has(130)).toBe(false)
  })
  it('writes only the records whose colour differs', () => {
    const records = parseRecords(factoryRecords())
    const colours = padColours(kitFor(DEFAULT_KIT_ID))
    const plan = paintPlan(1, records, colours)
    expect(plan).toHaveLength(RECORDS)
    expect(plan[16]).toEqual({ rec: 16, addr: recordAddr(1, 16) + 5, rgb: colours[0] })
    records[16].rgb = colours[0]
    expect(paintPlan(1, records, colours)).toHaveLength(RECORDS - 1)
  })
  it('every default kit pad has a colour', () => {
    expect(padColours(kitFor(DEFAULT_KIT_ID)).every(Boolean)).toBe(true)
  })
})

/** A fake device answering over the real codec: region 4 + region 5 memory. */
function fakeDevice({ mode = 1, profile = 2 } = {}) {
  const region5 = new Array(8 * 3539).fill(0)
  const recs = factoryRecords()
  for (let p = 0; p < 8; p++) recs.forEach((b, i) => { region5[recordAddr(p, 0) + i] = b })
  const region4 = [0, 0, 0, 0, 0, 0, mode, 0, 0, 0, profile, 0]
  const sent = []
  let link
  const device = {
    region5, region4, sent,
    send(bytes) {
      sent.push(bytes)
      const { cmd, data } = parseReply(bytes)
      const u32 = o => data[o] | data[o + 1] << 8 | data[o + 2] << 16 | data[o + 3] << 24
      let reply
      if (cmd === CMD.IDENTITY) reply = packet(0x11, [...'SMC-PAD_004'].map(c => c.charCodeAt(0)))
      if (cmd === CMD.READ) {
        const addr = u32(1), len = data[5] | data[6] << 8
        const mem = data[0] === 4 ? region4 : region5
        reply = packet(0x23, [...new Array(8).fill(0), ...mem.slice(addr, addr + len)])
      }
      if (cmd === CMD.WRITE) {
        const addr = u32(1)
        data.slice(8, 11).forEach((b, i) => { region5[addr + i] = b })
        reply = packet(0x00, [0])
      }
      if (reply) queueMicrotask(() => link.onSysex(reply))
    }
  }
  device.attach = l => { link = l }
  return device
}

describe('createSmcPadLink', () => {
  const colours = padColours(kitFor(DEFAULT_KIT_ID))

  it('paints the active profile and returns the note map', async () => {
    const device = fakeDevice({ profile: 2 })
    const link = createSmcPadLink({ send: b => device.send(b) })
    device.attach(link)
    const map = await link.refresh(colours)
    expect(map.get(20)).toBe(36)
    const rgbAt = (p, rec) => device.region5.slice(recordAddr(p, rec) + 5, recordAddr(p, rec) + 8)
    expect(rgbAt(2, 16)).toEqual(colours[0])
    expect(rgbAt(2, 47)).toEqual(colours[15])
    expect(rgbAt(1, 16)).toEqual([0xf0, 0xf0, 0])   // other profiles untouched
  })

  it('a repeat refresh only reads the mode', async () => {
    const device = fakeDevice()
    const link = createSmcPadLink({ send: b => device.send(b) })
    device.attach(link)
    await link.refresh(colours)
    const before = device.sent.length
    await link.refresh(colours)
    expect(device.sent.length - before).toBe(1)
  })

  it('leaves a Performance-mode device alone', async () => {
    const device = fakeDevice({ mode: 2 })
    const link = createSmcPadLink({ send: b => device.send(b) })
    device.attach(link)
    expect(await link.refresh(colours)).toBeNull()
    expect(device.sent.some(b => parseReply(b).cmd === CMD.WRITE)).toBe(false)
  })

  it('a silent device yields null instead of hanging', async () => {
    const link = createSmcPadLink({ send: () => {}, timeoutMs: 5 })
    expect(await link.refresh(colours)).toBeNull()
  })
})
