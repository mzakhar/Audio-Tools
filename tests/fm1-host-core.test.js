import { describe, it, expect } from 'vitest'
import {
  framesAt, createEventQueue, createKeyHold, createResampler, rgb565ToRgba,
  noteOnBytes, noteOffBytes, allNotesOffBytes, overload, createBlockWriter, bootCheck,
} from '../src/renderer/js/fm1/host-core.js'

describe('framesAt', () => {
  it('maps context time to emulator frames from an anchor', () => {
    expect(framesAt(1.5, { time: 1, frame: 1000 })).toBe(1000 + 22050)
    expect(framesAt(0.5, { time: 1, frame: 100000 })).toBe(100000 - 22050)
    expect(framesAt(2, { time: 1, frame: 0 }, 48000)).toBe(48000)
  })
})

describe('createEventQueue', () => {
  it('orders by frame and keeps push order for equal frames', () => {
    const q = createEventQueue()
    q.push({ frame: 300, bytes: ['c'] })
    q.push({ frame: 100, bytes: ['a1'] })
    q.push({ frame: 100, bytes: ['a2'] })
    q.push({ frame: 200, bytes: ['b'] })
    q.push({ frame: 100, bytes: ['a3'] })
    expect(q.size).toBe(5)
    expect(q.takeUpTo(99)).toEqual([])
    expect(q.takeUpTo(200)).toEqual([['a1'], ['a2'], ['a3'], ['b']])
    expect(q.takeUpTo(1e9)).toEqual([['c']])
    expect(q.size).toBe(0)
  })

  it('is bounded and clears', () => {
    const q = createEventQueue(2)
    expect(q.push({ frame: 1, bytes: [1] })).toBe(true)
    expect(q.push({ frame: 2, bytes: [2] })).toBe(true)
    expect(q.push({ frame: 3, bytes: [3] })).toBe(false)
    q.clear()
    expect(q.size).toBe(0)
    expect(q.takeUpTo(10)).toEqual([])
  })
})

describe('createKeyHold', () => {
  it('holds a short press for the minimum and releases on time', () => {
    const k = createKeyHold(4410)
    k.down(5, 1000)
    expect(k.up(5, 1100)).toBe(5410)
    expect(k.due(5409)).toEqual([])
    expect(k.due(5410)).toEqual([5])
    expect(k.due(9999)).toEqual([])
  })

  it('releases a long press when it is let go', () => {
    const k = createKeyHold(4410)
    k.down(1, 0)
    expect(k.up(1, 10000)).toBe(10000)
    expect(k.due(10000)).toEqual([1])
  })

  it('a re-press before the release keeps the key held', () => {
    const k = createKeyHold(4410)
    k.down(2, 0)
    k.up(2, 10)
    k.down(2, 20)
    expect(k.due(1e6)).toEqual([])
  })
})

describe('createResampler', () => {
  const sine = (n, f, rate, start = 0) => Float32Array.from({ length: n }, (_, i) => Math.sin(2 * Math.PI * f * (start + i) / rate))
  // frequency by counting rising zero crossings with linear interpolation
  function freqOf(x, rate) {
    const cross = []
    for (let i = 1; i < x.length; i++) if (x[i - 1] < 0 && x[i] >= 0) cross.push(i - 1 + -x[i - 1] / (x[i] - x[i - 1]))
    return (cross.length - 1) / ((cross.at(-1) - cross[0]) / rate)
  }

  it('44100 -> 48000 keeps a sine frequency within 0.5 % and fills each quantum exactly', () => {
    const rs = createResampler(44100, 48000)
    const out = []
    let inPos = 0
    for (let q = 0; q < 400; q++) {
      const need = rs.need(128)
      const l = sine(need, 440, 44100, inPos)
      inPos += need
      const oL = new Float32Array(128), oR = new Float32Array(128)
      expect(rs.process(l, l, oL, oR)).toBe(128)
      out.push(...oL)
    }
    expect(Math.abs(inPos - 400 * 128 * 44100 / 48000)).toBeLessThan(3)
    const f = freqOf(Float32Array.from(out), 48000)
    expect(Math.abs(f - 440) / 440).toBeLessThan(0.005)
  })

  it('is continuous across calls of any size', () => {
    const rs = createResampler(44100, 48000)
    const input = sine(20000, 1000, 44100)
    const out = []
    const sizes = [1, 7, 128, 300, 2, 999, 64]
    for (let i = 0, k = 0; i < input.length; k++) {
      const n = sizes[k % sizes.length]
      const l = input.subarray(i, i + n); i += n
      const oL = new Float32Array(2048), oR = new Float32Array(2048)
      out.push(...oL.subarray(0, rs.process(l, l, oL, oR)))
    }
    // compare against the ideal resampled sine: linear interpolation error stays small
    for (let k = 0; k < out.length; k++) {
      expect(Math.abs(out[k] - Math.sin(2 * Math.PI * 1000 * k / 48000))).toBeLessThan(0.02)
    }
    expect(out.length).toBeGreaterThan(1000)
  })
})

describe('rgb565ToRgba', () => {
  it('expands 5/6/5 to bytes with full alpha', () => {
    const out = new Uint8ClampedArray(12)
    rgb565ToRgba(Uint16Array.of(0xF800, 0x07E0, 0x001F), out)
    expect([...out]).toEqual([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255])
    rgb565ToRgba(Uint16Array.of(0xFFFF, 0, 0x8410), out)
    expect([...out.subarray(0, 8)]).toEqual([255, 255, 255, 255, 0, 0, 0, 255])
    expect(out[8]).toBe(132)
  })
})

describe('MIDI bytes', () => {
  it('stamps the channel and clamps', () => {
    expect(noteOnBytes(2, 60, 100)).toEqual([0x92, 60, 100])
    expect(noteOnBytes(0, 60, 0)).toEqual([0x90, 60, 1])
    expect(noteOnBytes(15, 200, 300)).toEqual([0x9F, 127, 127])
    expect(noteOffBytes(3, 64)).toEqual([0x83, 64, 0])
    const all = allNotesOffBytes()
    expect(all.length).toBe(48)
    expect(all.slice(0, 3)).toEqual([0xB0, 123, 0])
    expect(all.slice(45)).toEqual([0xBF, 123, 0])
  })
})

describe('overload', () => {
  it('is starved or underruns rising, not late', () => {
    expect(overload({ starved: 1, underruns: 0, late: 0 }, { starved: 0, underruns: 0 })).toBe(true)
    expect(overload({ starved: 1, underruns: 2 }, { starved: 1, underruns: 1 })).toBe(true)
    expect(overload({ starved: 1, underruns: 1, late: 50 }, { starved: 1, underruns: 1, late: 0 })).toBe(false)
  })
})

describe('createBlockWriter (Worker path: 44.1 kHz -> context rate, fixed blocks)', () => {
  it('cuts contiguous 1024-frame blocks of the right total length at 48 kHz, keeping a sine in tune', () => {
    const w = createBlockWriter(44100, 48000, 1024)
    const blocks = []
    const chunks = 3445                                // ~10 s of 128-frame chunks
    for (let c = 0; c < chunks; c++) {
      const l = new Float32Array(128), r = new Float32Array(128)
      for (let i = 0; i < 128; i++) { const t = (c * 128 + i) / 44100; l[i] = Math.sin(2 * Math.PI * 1000 * t); r[i] = -l[i] }
      blocks.push(...w.push(l, r))
    }
    const expected = chunks * 128 * 48000 / 44100
    expect(blocks.every((b, i) => b.frame === i * 1024 && b.l.length === 1024 && b.r.length === 1024)).toBe(true)
    expect(blocks.length).toBe(Math.floor((expected - 2) / 1024))
    expect(new Set(blocks.map(b => b.l.buffer)).size).toBe(blocks.length)   // each block owns its buffer
    // continuity across chunk and block seams: compare against the ideal 48 kHz sine
    let worst = 0
    blocks.forEach(b => b.l.forEach((v, i) => {
      worst = Math.max(worst, Math.abs(v - Math.sin(2 * Math.PI * 1000 * (b.frame + i) / 48000)))
    }))
    expect(worst).toBeLessThan(0.02)
  })
})

describe('bootCheck', () => {
  it('up once the firmware fills audio frames, timeout after 8 s, else still booting', () => {
    expect(bootCheck({ have: 0, ms: 100 })).toBeNull()
    expect(bootCheck({ have: 128, ms: 100 })).toBe('up')
    expect(bootCheck({ have: 128, ms: 9000 })).toBe('up')
    expect(bootCheck({ have: 0, ms: 8000 })).toBe('timeout')
  })
})
