import { describe, it, expect, vi, afterEach } from 'vitest'
import { createRunner, bootToReady, bootEmulator, CHUNK } from '../src/renderer/js/fm1/emulator.js'
import { fakeFm1Exports } from './helpers/fm1-fake-exports.js'

const bytesAt = (x, at) => x.midi.filter(m => m.at === at).map(m => m.b)

describe('emulator runner', () => {
  it('injects timed MIDI at the first chunk whose start >= frame, in order', () => {
    const x = fakeFm1Exports()
    const run = createRunner(x, { mhz: 120 })
    run.midi([0x90, 60, 100], 300)
    run.midi([0x90, 64, 100], 256)
    run.midi([0x80, 60, 0], 300)
    for (let i = 0; i < 4; i++) run.render()
    // chunk starts 0,128,256,384: 256 -> before render #2, 300 -> before render #3
    expect(bytesAt(x, 2)).toEqual([0x90, 64, 100])
    expect(bytesAt(x, 3)).toEqual([0x90, 60, 100, 0x80, 60, 0])
    expect(run.frame).toBe(4 * CHUNK)
  })

  it('counts late events and applies them at the next chunk', () => {
    const x = fakeFm1Exports()
    const run = createRunner(x, { mhz: 120 })
    run.render(); run.render()
    run.midi([0x90, 1, 1], 10)
    run.midi([0x90, 2, 1])            // untimed: next chunk, not late
    run.render()
    expect(bytesAt(x, 2)).toEqual([0x90, 1, 1, 0x90, 2, 1])
    expect(run.stats().late).toBe(1)
  })

  it('panic drops the queue and sends its bytes next', () => {
    const x = fakeFm1Exports()
    const run = createRunner(x, { mhz: 120 })
    run.midi([0x90, 60, 100], 1000)
    run.panic([0xB0, 123, 0])
    for (let i = 0; i < 12; i++) run.render()
    expect(x.midi.map(m => m.b)).toEqual([0xB0, 123, 0])
  })

  it('holds a panel key for 4410 emulated frames', () => {
    const x = fakeFm1Exports()
    const run = createRunner(x, { mhz: 120 })
    run.key(7, true)
    run.key(7, false)
    for (let i = 0; i < 40; i++) run.render()
    expect(x.keys).toEqual([{ id: 7, down: 1, at: 0 }, { id: 7, down: 0, at: Math.ceil(4410 / CHUNK) }])
  })

  it('returns the LCD only when its revision changes', () => {
    const x = fakeFm1Exports()
    const run = createRunner(x, { mhz: 120 })
    expect(run.screen().lcd).toHaveLength(57600)
    expect(run.screen().lcd).toBeNull()
    expect(run.screen(true).lcd).toHaveLength(57600)
    x.lcdRev++
    const s = run.screen()
    expect(s.lcd).toHaveLength(57600)
    expect(s.leds).toHaveLength(41)
  })
})

describe('bootToReady', () => {
  it('renders until audio started and the UI redrew, and reports a halt', () => {
    const x = fakeFm1Exports({ silentFor: 3, ms: () => x.rendered.length * 50 })
    const rev = x.fm1_lcd_revision
    x.fm1_lcd_revision = () => (x.rendered.length >= 8 ? 2 : rev())
    expect(bootToReady(createRunner(x, { mhz: 120 }), x)).toBe('up')
    expect(x.rendered).toHaveLength(8)
    let ms = 0
    const slow = fakeFm1Exports({ silentFor: 1e9, ms: () => (ms += 1000) })
    expect(bootToReady(createRunner(slow, { mhz: 120 }), slow)).toBe('timeout')
    expect(bootToReady(createRunner(slow, { mhz: 120 }), { ...slow, fm1_halted: () => 1 })).toBe('halted')
  })
})

describe('bootEmulator flash restore', () => {
  const pkg = new Uint8Array(16).buffer
  function restoring(result = 0) {
    const x = fakeFm1Exports()
    const calls = []
    x.fm1_boot_fwsc = () => { calls.push('boot'); return 0 }
    x.fm1_flash_restore = (p, n) => { calls.push(['restore', n, new Uint8Array(x.memory.buffer, p, n).slice()]); return result }
    const render = x.fm1_render
    x.fm1_render = (...a) => { calls.push('render'); return render(...a) }
    vi.spyOn(WebAssembly, 'instantiate').mockResolvedValue({ exports: x })
    return { x, calls }
  }
  afterEach(() => vi.restoreAllMocks())

  it('restores the sectors after boot, before the first render', async () => {
    const { x, calls } = restoring()
    const sectors = new Uint8Array(4100).fill(3)
    await bootEmulator({ module: {}, pkg, mhz: 120, jit: false, sectors })
    createRunner(x, { mhz: 120 }).render()
    expect(calls[0]).toBe('boot')
    expect(calls[1][0]).toBe('restore')
    expect(calls[1][1]).toBe(4100)
    expect(calls[1][2]).toEqual(sectors)
    expect(calls[2]).toBe('render')
  })

  it('no sectors: no restore call', async () => {
    const { calls } = restoring()
    await bootEmulator({ module: {}, pkg, mhz: 120, jit: false, sectors: new Uint8Array(0) })
    expect(calls).toEqual(['boot'])
  })

  it('a rejected restore fails the boot as flash-corrupt', async () => {
    restoring(1)
    await expect(bootEmulator({ module: {}, pkg, mhz: 120, jit: false, sectors: new Uint8Array(4100) }))
      .rejects.toMatchObject({ reason: 'flash-corrupt' })
  })
})
