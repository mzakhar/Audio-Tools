// The Worker's flash protocol over a fake emulator: boot sectors reach bootEmulator, ready and
// status carry the revision, snapshots wait for a quiet flash, time out at 1.5 s, and report
// changed=false while the revision is still the session's saved one.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { unpackRestore } from '../src/renderer/js/fm1/flash-asset.js'

const emu = vi.hoisted(() => ({ rev: 0, busy: false, booted: null, records: [] }))
vi.mock('../src/renderer/js/fm1/emulator.js', () => ({
  bootEmulator: async (opts) => { emu.booted = opts; return { x: {} } },
  bootToReady: () => { if (emu.halt) throw new Error('halt'); return 'up' },
  createRunner: () => ({
    frame: 0,
    render() { this.frame += 128; return { l: new Float32Array(128), r: new Float32Array(128), have: 128 } },
    screen: () => ({ lcd: null, leds: new Float32Array(41) }),
    stats: () => ({ rtf: 1, starved: 0, late: 0, dropped: 0, halted: false }),
    flashRevision: () => emu.rev,
    flashBusy: () => emu.busy,
    changedSectors: () => emu.records,
  }),
}))

const sent = []
let saved
beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'performance'] })
  saved = globalThis.self
  globalThis.self = { postMessage: (m) => sent.push(m) }
  await import('../src/renderer/js/workers/fm1-worker.js')
})
afterAll(() => { globalThis.self = saved; vi.useRealTimers() })

const send = (data) => self.onmessage({ data })
const snaps = () => sent.filter(m => m.type === 'snapshot')

describe('fm1 worker flash protocol', () => {
  it('boots with sectors, reports revisions, gates snapshots', async () => {
    emu.rev = 7
    const sectors = new Uint8Array(4100)
    send({ type: 'boot', module: {}, package: new ArrayBuffer(8), mhz: 120, sectors })
    await vi.advanceTimersByTimeAsync(0)
    expect(emu.booted.sectors).toBe(sectors)
    expect(sent.find(m => m.type === 'ready')).toMatchObject({ flashRevision: 7 })

    // unchanged since the saved revision: answered at once, changed false, still the full set
    emu.records = [{ offset: 0x1000, bytes: new Uint8Array(4096).fill(1) }]
    send({ type: 'snapshot', request: 1, since: 7 })
    await vi.advanceTimersByTimeAsync(20)
    expect(snaps()).toHaveLength(1)
    expect(snaps()[0]).toMatchObject({ type: 'snapshot', request: 1, revision: 7, changed: false })
    expect(unpackRestore(snaps()[0].sectors)).toEqual(emu.records)

    // a firmware save: waits for 250 ms of quiet, then sends the changed sectors
    emu.rev = 9
    emu.records = [{ offset: 0xdc000, bytes: new Uint8Array(4096).fill(5) }]
    await vi.advanceTimersByTimeAsync(10)
    send({ type: 'snapshot', request: 2, since: 7 })
    await vi.advanceTimersByTimeAsync(200)
    expect(snaps()).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(80)
    const s = snaps()[1]
    expect(s).toMatchObject({ request: 2, revision: 9, changed: true })
    expect(unpackRestore(s.sectors)).toEqual(emu.records)

    // busy flash: gives up at 1.5 s
    emu.busy = true
    send({ type: 'snapshot', request: 3, since: 9 })
    await vi.advanceTimersByTimeAsync(1400)
    expect(snaps()).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(200)
    expect(snaps()[2]).toEqual({ type: 'snapshot', request: 3, reason: 'busy-timeout' })
    expect(sent.filter(m => m.type === 'status').at(-1)).toMatchObject({ flashRevision: 9 })
  })

  it('a snapshot after a boot that halted answers not-ready instead of throwing (no gate yet)', async () => {
    vi.resetModules()
    emu.halt = true
    await import('../src/renderer/js/workers/fm1-worker.js')   // a fresh worker
    const before = sent.length
    send({ type: 'boot', module: {}, package: new ArrayBuffer(8), mhz: 120 })
    await vi.advanceTimersByTimeAsync(0)
    expect(sent.slice(before).find(m => m.type === 'error')).toMatchObject({ reason: 'halted' })
    expect(() => send({ type: 'snapshot', request: 9, since: 0 })).not.toThrow()
    expect(snaps().at(-1)).toEqual({ type: 'snapshot', request: 9, reason: 'not-ready' })
    emu.halt = false
  })
})
