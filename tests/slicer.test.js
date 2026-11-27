import { describe, it, expect } from 'vitest'
import {
  mono, onsetEnvelope, pickOnsets, snapToZero, trimEnd, sliceRegions, estimateBars, slicePattern,
} from '../src/renderer/js/pads/slicer.js'

const SR = 48000
// decaying 200 Hz bursts at given sample positions over low noise; deterministic PRNG
function burstBuffer(seconds, positions, { amp = [] } = {}) {
  const x = new Float32Array(Math.floor(seconds * SR))
  let s = 1
  for (let i = 0; i < x.length; i++) { s = (s * 16807) % 2147483647; x[i] = ((s / 2147483647) - 0.5) * 0.002 }
  positions.forEach((p, k) => {
    for (let i = 0; i < 4800 && p + i < x.length; i++) x[p + i] += (amp[k] ?? 0.8) * Math.exp(-i / 800) * Math.sin(2 * Math.PI * 200 * i / SR)
  })
  return x
}
const detect = (x, opts) => { const { env, hop } = onsetEnvelope(x, SR); return pickOnsets(env, hop, SR, opts) }
const contiguous = (r, end) => r[0].start === 0 && r.at(-1).end === end && r.every((g, i) => i === 0 || g.start === r[i - 1].end)

describe('slicer', () => {
  it('mono averages and copies', () => {
    const a = new Float32Array([1, 0]); const m = mono([a])
    expect(Array.from(m)).toEqual([1, 0]); expect(m).not.toBe(a)
    expect(Array.from(mono([a, new Float32Array([0, 1])]))).toEqual([0.5, 0.5])
  })

  it('finds bursts within 10 ms', () => {
    const pos = [0.5, 1.0, 1.6, 2.2].map((t) => Math.round(t * SR))
    const on = detect(burstBuffer(3, pos))
    expect(on).toHaveLength(4)
    on.forEach((o, i) => expect(Math.abs(o.at - pos[i])).toBeLessThanOrEqual(SR * 0.01))
  })

  it('higher sensitivity never yields fewer onsets', () => {
    const pos = [0.4, 0.9, 1.4, 1.9, 2.4].map((t) => Math.round(t * SR))
    const x = burstBuffer(3, pos, { amp: [0.9, 0.2, 0.6, 0.1, 0.8] })
    const counts = [0, 0.25, 0.5, 0.75, 1].map((s) => detect(x, { sensitivity: s }).length)
    for (let i = 1; i < counts.length; i++) expect(counts[i]).toBeGreaterThanOrEqual(counts[i - 1])
  })

  it('minGap keeps the stronger of two close onsets', () => {
    const p = Math.round(0.5 * SR)
    const x = burstBuffer(2, [p, p + Math.round(0.03 * SR)], { amp: [0.3, 0.9] })
    const on = detect(x, { sensitivity: 1, minGapMs: 100 })
    expect(on.filter((o) => Math.abs(o.at - p) < SR * 0.1)).toHaveLength(1)
  })

  it('silence -> equal 16 regions', () => {
    const x = new Float32Array(SR).fill(0.5)
    expect(detect(new Float32Array(SR))).toEqual([])
    const r = sliceRegions(x, SR, [])
    expect(r).toHaveLength(16)
    expect(r.every((g) => Math.abs((g.end - g.start) - SR / 16) <= 1)).toBe(true)
    expect(contiguous(r, SR)).toBe(true)
  })

  it('always exactly 16 contiguous regions', () => {
    const x = burstBuffer(4, [Math.round(3.5 * SR)]) // a loud tail: pure noise trims to 1 sample
    const mk = (n) => Array.from({ length: n }, (_, i) => ({ at: Math.round((i + 1) * SR * 3.9 / (n + 1)), strength: 1 + (i % 7) }))
    for (const n of [0, 1, 2, 15, 16, 40]) {
      const r = sliceRegions(x, SR, mk(n))
      expect(r).toHaveLength(16)
      expect(contiguous(r, trimEnd(x))).toBe(true)
    }
  })

  it('merges too-short slices and still yields 16', () => {
    const x = burstBuffer(2, [Math.round(1.8 * SR)])
    const r = sliceRegions(x, SR, [{ at: 24000, strength: 1 }, { at: 24100, strength: 2 }])
    expect(r).toHaveLength(16)
    expect(contiguous(r, trimEnd(x))).toBe(true)
  })

  it('keeps strongest onsets when over count', () => {
    const x = new Float32Array(SR * 2).fill(0.5)
    const on = Array.from({ length: 20 }, (_, i) => ({ at: 4000 + i * 4000, strength: i === 3 ? 100 : i }))
    expect(sliceRegions(x, SR, on).some((g) => g.start === 16000)).toBe(true)
  })

  it('snapToZero', () => {
    const x = new Float32Array([1, 1, -1, -1, -1, 1])
    expect(snapToZero(x, 4)).toBe(2)
    expect(snapToZero(x, 0)).toBe(0)
    expect(snapToZero(new Float32Array([0.5, 0.4, 0.1, 0.3]), 3)).toBe(2)
    expect(snapToZero(x, 1000)).toBeGreaterThanOrEqual(0)
  })

  it('trimEnd', () => {
    const x = new Float32Array(100); x[40] = 0.5; x[90] = 0.0005
    expect(trimEnd(x)).toBe(41)
    expect(trimEnd(new Float32Array(10))).toBe(1)
  })

  it('estimateBars', () => {
    expect(estimateBars(2)).toEqual({ bars: 1, bpm: 120 })
    expect(estimateBars(3)).toEqual({ bars: 1, bpm: 80 }) // 80 and 160 tie; fewer bars wins
    expect(estimateBars(8)).toEqual({ bars: 4, bpm: 120 })
    expect(estimateBars(0.5)).toBeNull()
  })

  it('slicePattern beats', () => {
    const r = [{ start: 0, end: 24000 }, { start: 24000, end: 48000 }]
    expect(slicePattern(r, SR, 120)).toEqual([{ pad: 0, beat: 0 }, { pad: 1, beat: 1 }])
  })

  it('30 s buffer slices fast', () => {
    const x = burstBuffer(30, Array.from({ length: 30 }, (_, i) => i * SR))
    const t = performance.now()
    sliceRegions(x, SR, detect(x))
    expect(performance.now() - t).toBeLessThan(500)
  })
})

describe('sliceRegions degenerate input', () => {
  it('never returns a zero-length region (silent / 1-sample file)', () => {
    for (const x of [new Float32Array(SR), new Float32Array(1), Float32Array.from([0.5, 0.5, 0.5])]) {
      const r = sliceRegions(x, SR, [])
      expect(r.length).toBeGreaterThan(0)
      expect(r.every((g) => g.end > g.start)).toBe(true)
    }
  })
})
