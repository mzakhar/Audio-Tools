import { describe, it, expect } from 'vitest'
import { createRunner, bootToReady, CHUNK } from '../src/renderer/js/fm1/emulator.js'
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
  it('renders until the firmware makes sound, and reports a halt', () => {
    const x = fakeFm1Exports({ silentFor: 3 })
    expect(bootToReady(createRunner(x, { mhz: 120 }), x)).toBe('up')
    expect(x.rendered).toHaveLength(4)
    let ms = 0
    const slow = fakeFm1Exports({ silentFor: 1e9, ms: () => (ms += 1000) })
    expect(bootToReady(createRunner(slow, { mhz: 120 }), slow)).toBe('timeout')
    expect(bootToReady(createRunner(slow, { mhz: 120 }), { ...slow, fm1_halted: () => 1 })).toBe('halted')
  })
})
