import { describe, it, expect } from 'vitest'
import {
  framesAt, createEventQueue, createKeyHold, createResampler, rgb565ToRgba,
  noteOnBytes, noteOffBytes, allNotesOffBytes, overload, createBlockWriter, createBootWatch, createNoteCounts, createTake,
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

describe('createBootWatch', () => {
  it('up at the first LCD redraw >= 100 ms after audio started; redraws before audio do not count', () => {
    const w = createBootWatch()
    expect(w({ have: 0, lcdRev: 1, ms: 60 })).toBeNull()       // splash before audio
    expect(w({ have: 0, lcdRev: 2, ms: 200 })).toBeNull()
    expect(w({ have: 128, lcdRev: 3, ms: 320 })).toBeNull()    // audio starts (same render redraw)
    expect(w({ have: 128, lcdRev: 4, ms: 380 })).toBeNull()    // too soon
    expect(w({ have: 128, lcdRev: 4, ms: 700 })).toBeNull()    // no redraw
    expect(w({ have: 128, lcdRev: 5, ms: 796 })).toBe('up')
  })
  it('timeout after 8 s emulated', () => {
    const w = createBootWatch()
    expect(w({ have: 128, lcdRev: 1, ms: 300 })).toBeNull()
    expect(w({ have: 128, lcdRev: 1, ms: 8000 })).toBe('timeout')
    expect(createBootWatch()({ have: 0, lcdRev: 1, ms: 8000 })).toBe('timeout')
  })
})

describe('createNoteCounts', () => {
  const on = (p, ch = 2) => [0x90 | ch, p, 100], off = (p, ch = 2) => [0x80 | ch, p, 0]
  it('every on passes; an off is dropped only while ANOTHER source holds the note; reset clears', () => {
    const c = createNoteCounts()
    expect(c.filter(on(60), 'live')).toEqual(on(60))
    expect(c.filter(on(60), 'timeline')).toEqual(on(60))
    expect(c.filter(on(60, 3), 'timeline')).toEqual(on(60, 3))   // another channel is another note
    expect(c.filter(off(60), 'timeline')).toBeNull()              // live still holds it
    expect(c.filter(off(60), 'live')).toEqual(off(60))
    expect(c.filter(off(60, 3), 'timeline')).toEqual(off(60, 3))
    expect(c.filter(off(60), 'live')).toEqual(off(60))           // nobody holds it: passes (harmless)
    expect(c.filter([0x92, 61, 0], 'live')).toEqual([0x92, 61, 0])   // velocity 0 = an off
    c.filter(on(61), 'live'); c.reset()
    expect(c.filter(off(61), 'timeline')).toEqual(off(61))
    expect(c.filter([0xB2, 1, 64], 'live')).toEqual([0xB2, 1, 64])  // not a note
  })
  it('plain repeated notes from one source: every on and every off passes', () => {
    const c = createNoteCounts()
    for (let i = 0; i < 3; i++) {
      expect(c.filter(on(64), 'live')).toEqual(on(64))
      expect(c.filter(on(64), 'live')).toEqual(on(64))     // a retrigger without an off
      expect(c.filter(off(64), 'live')).toEqual(off(64))   // the source's own off is never held back
    }
  })
})

describe('event queue dropFrom (transport stop without panic)', () => {
  it('drops what was queued to start from the frame on, keeps note-offs (also velocity-0 ons)', () => {
    const q = createEventQueue()
    q.push({ frame: 100, bytes: [0x90, 60, 100] })
    q.push({ frame: 300, bytes: [0x80, 60, 0] })
    q.push({ frame: 400, bytes: [0x90, 62, 100] })
    q.push({ frame: 500, bytes: [0x90, 62, 0] })
    q.push({ frame: 450, bytes: [0xB0, 1, 64] })
    q.dropFrom(200)
    expect(q.takeUpTo(1e9)).toEqual([[0x90, 60, 100], [0x80, 60, 0], [0x90, 62, 0]])
  })
})

describe('event queue with the note gate (frame order, not call order)', () => {
  const on = [0x92, 60, 100], off = [0x82, 60, 0]
  it("reviewer's case: live holds P, the timeline queues P later, live lets go first -> no stuck note", () => {
    const q = createEventQueue(4096, createNoteCounts())
    q.push({ frame: 0, bytes: on, src: 'live' })          // live press
    q.push({ frame: 1000, bytes: on, src: 'timeline' })   // timeline note, queued (sent a lead early)
    q.push({ frame: 2000, bytes: off, src: 'timeline' })  //   with its off
    q.push({ frame: 500, bytes: off, src: 'live' })       // live release, before the timeline note sounds
    expect(q.takeUpTo(0)).toEqual([on])
    expect(q.takeUpTo(500)).toEqual([off])                // nobody else holds it at frame 500
    expect(q.takeUpTo(1000)).toEqual([on])
    expect(q.takeUpTo(2000)).toEqual([off])               // the timeline's own off releases it
  })
  it('live still held when the timeline note ends: the timeline off is held back until the live off', () => {
    const q = createEventQueue(4096, createNoteCounts())
    q.push({ frame: 0, bytes: on, src: 'live' })
    q.push({ frame: 100, bytes: on, src: 'timeline' })
    q.push({ frame: 200, bytes: off, src: 'timeline' })
    q.push({ frame: 900, bytes: off, src: 'live' })
    expect(q.takeUpTo(899)).toEqual([on, on])
    expect(q.takeUpTo(900)).toEqual([off])
  })
})

describe('createTake', () => {
  const ramp = (n, from = 1) => Float32Array.from({ length: n }, (_, i) => (from + i) / 1000)
  it('places blocks by audible time and leaves an underrun gap silent', () => {
    const t = createTake({ rate: 1000, startTime: 2, maxFrames: 100 })
    t.add(ramp(10), ramp(10).map(v => -v), 2)
    t.add(ramp(5, 50), ramp(5, 50), 2.02)          // 10 frames late: 10..19 stay 0
    expect(t.frames()).toBe(25)
    const { L, R, rate, frames } = t.finish()
    expect([rate, frames, L.length]).toEqual([1000, 25, 25])
    expect(L[0]).toBeCloseTo(0.001); expect(R[9]).toBeCloseTo(-0.010)
    expect([...L.subarray(10, 20)].every(v => v === 0)).toBe(true)
    expect(L[20]).toBeCloseTo(0.050)
    expect(t.peak).toBeCloseTo(0.054)
  })
  it('rounds the start index, drops samples before startTime', () => {
    const t = createTake({ rate: 1000, startTime: 1, maxFrames: 100 })
    t.add(ramp(10), ramp(10), 0.9954)               // index round(-4.6) = -5: first 5 dropped
    const { L } = t.finish()
    expect(L.length).toBe(5)
    expect(L[0]).toBeCloseTo(0.006)
    t.add(ramp(3), ramp(3), 0.5)                    // wholly before: ignored
    expect(t.frames()).toBe(5)
  })
  it('stops at maxFrames and says full; finish truncates or extends to an end time', () => {
    const t = createTake({ rate: 1000, startTime: 0, maxFrames: 8 })
    t.add(ramp(6), ramp(6), 0)
    expect(t.full).toBe(false)
    t.add(ramp(6, 100), ramp(6, 100), 0.006)
    expect(t.full).toBe(true)
    expect(t.frames()).toBe(8)
    expect(t.finish(0.003).L).toEqual(ramp(3))
    const long = t.finish(0.02)                      // capped at maxFrames
    expect(long.frames).toBe(8)
    const u = createTake({ rate: 1000, startTime: 0, maxFrames: 100 })
    u.add(ramp(4), ramp(4), 0)
    const ext = u.finish(0.01)
    expect(ext.frames).toBe(10)
    expect([...ext.R.subarray(4)].every(v => v === 0)).toBe(true)
    expect(createTake({ rate: 1000, startTime: 0, maxFrames: 10 }).finish()).toMatchObject({ frames: 0 })
  })
  it('grows across many blocks without losing earlier samples', () => {
    const t = createTake({ rate: 100, startTime: 0, maxFrames: 1e6 })
    for (let i = 0; i < 300; i++) t.add(new Float32Array(64).fill(i / 1000), new Float32Array(64), i * 0.64)
    const { L } = t.finish()
    expect(L.length).toBe(300 * 64)
    expect(L[0]).toBe(0); expect(L[64 * 150]).toBeCloseTo(0.15); expect(L.at(-1)).toBeCloseTo(0.299)
  })
  it('finish returns views (no copy) when the buffers already hold the length', () => {
    const t = createTake({ rate: 1000, startTime: 0, maxFrames: 5000 })
    t.add(ramp(10), ramp(10), 0)
    const a = t.finish(0.005), b = t.finish()
    expect(a.L.buffer).toBe(b.L.buffer)               // same storage
    expect([a.frames, b.frames]).toEqual([5, 10])
  })
  it('takeRecentPeak is the peak since the previous call (meter window); peak stays the take peak', () => {
    const t = createTake({ rate: 1000, startTime: 0, maxFrames: 100 })
    t.add(new Float32Array([0.5]), new Float32Array([0]), 0)
    expect(t.takeRecentPeak()).toBe(0.5)
    expect(t.takeRecentPeak()).toBe(0)
    t.add(new Float32Array([0.1]), new Float32Array([-0.2]), 0.001)
    expect(t.takeRecentPeak()).toBeCloseTo(0.2)
    expect(t.peak).toBe(0.5)
  })
})
