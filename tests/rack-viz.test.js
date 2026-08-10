import { describe, it, expect } from 'vitest'
import {
  findTrigger, levels, bipolar, dbfs, dbToFraction, approach, peakHold, fftSizeFor
} from '../src/renderer/js/rack/viz.js'

function makeSine(length, period, phase = 0, amp = 1) {
  const buf = new Array(length)
  for (let i = 0; i < length; i++) buf[i] = amp * Math.sin((2 * Math.PI * i) / period + phase)
  return buf
}

describe('findTrigger', () => {
  it('locks a sine to a stable rising zero crossing', () => {
    const buf = makeSine(1000, 100)
    const displaySamples = 200
    const idx = findTrigger(buf, displaySamples)
    expect(idx).toBeGreaterThan(0)
    expect(buf[idx - 1]).toBeLessThan(0)
    expect(buf[idx]).toBeGreaterThanOrEqual(0)
  })

  it('locks a phase-shifted copy of the same wave to the same phase', () => {
    const period = 100
    const displaySamples = 200
    const bufA = makeSine(1000, period)
    const bufB = makeSine(1000, period, 1.7) // arbitrary phase offset
    const idxA = findTrigger(bufA, displaySamples)
    const idxB = findTrigger(bufB, displaySamples)
    expect(idxA).toBeGreaterThan(-1)
    expect(idxB).toBeGreaterThan(-1)
    // both windows start at the same point in the waveform's cycle, up to
    // one sample's worth of quantization in where each buffer's discrete
    // samples happened to land relative to the true zero crossing
    const sampleStep = (2 * Math.PI) / period
    for (let k = 0; k < displaySamples; k += 17) {
      expect(Math.abs(bufA[idxA + k] - bufB[idxB + k])).toBeLessThan(sampleStep)
    }
  })

  it('returns -1 for DC', () => {
    const buf = new Array(1000).fill(0.5)
    expect(findTrigger(buf, 200)).toBe(-1)
  })

  it('returns -1 for silence', () => {
    const buf = new Array(1000).fill(0)
    expect(findTrigger(buf, 200)).toBe(-1)
  })

  it('returns -1 when the signal never crosses the level in the requested direction', () => {
    // dips once, then stays negative for the rest of the buffer — no rising
    // crossing back through 0 ever occurs
    const buf = new Array(1000).fill(0.1)
    for (let i = 200; i < 1000; i++) buf[i] = -0.5
    expect(findTrigger(buf, 200)).toBe(-1)
  })

  it('respects slope: falling', () => {
    const buf = makeSine(1000, 100)
    const displaySamples = 200
    const idx = findTrigger(buf, displaySamples, 0, 'falling')
    expect(idx).toBeGreaterThan(-1)
    expect(buf[idx - 1]).toBeGreaterThan(0)
    expect(buf[idx]).toBeLessThanOrEqual(0)
  })

  it('hysteresis: dithering around the level does not arm the detector', () => {
    // small wiggle around 0, never dropping below level - hysteresis (-0.02)
    const buf = new Array(500)
    for (let i = 0; i < buf.length; i++) buf[i] = i % 2 === 0 ? 0.01 : -0.01
    expect(findTrigger(buf, 100)).toBe(-1)
  })

  it('hysteresis: only the crossing after a real arming dip is reported, not earlier dither', () => {
    const buf = new Array(600)
    // dither for the first 300 samples — crosses 0 repeatedly but never arms
    for (let i = 0; i < 300; i++) buf[i] = i % 2 === 0 ? 0.01 : -0.01
    // then a real dip well past the hysteresis band, followed by a rise
    for (let i = 300; i < 400; i++) buf[i] = -0.5
    for (let i = 400; i < 600; i++) buf[i] = 0.5
    const idx = findTrigger(buf, 100)
    expect(idx).toBeGreaterThanOrEqual(400)
    expect(idx).toBeLessThan(600 - 100)
  })

  it('never returns an index that would run the display window off the end of the buffer', () => {
    const buf = makeSine(1000, 30) // high frequency, many candidate crossings
    const displaySamples = 200
    const idx = findTrigger(buf, displaySamples)
    if (idx !== -1) expect(idx + displaySamples).toBeLessThanOrEqual(buf.length)
  })

  it('returns -1 when displaySamples leaves no room to search', () => {
    const buf = makeSine(50, 10)
    expect(findTrigger(buf, 200)).toBe(-1)
  })
})

describe('levels', () => {
  it('full-scale square: rms === peak === 1', () => {
    const buf = new Array(100)
    for (let i = 0; i < buf.length; i++) buf[i] = i % 2 === 0 ? 1 : -1
    const { peak, rms } = levels(buf)
    expect(peak).toBe(1)
    expect(rms).toBe(1)
  })

  it('sine of amplitude a: rms ~= a / sqrt(2)', () => {
    const a = 0.7
    const buf = makeSine(1000, 100, 0, a) // 10 full periods
    const { peak, rms } = levels(buf)
    expect(peak).toBeCloseTo(a, 2)
    expect(rms).toBeCloseTo(a / Math.SQRT2, 2)
  })
})

describe('bipolar', () => {
  it('reports signed extremes and mean for a steady negative DC signal', () => {
    const buf = new Array(50).fill(-0.3)
    const { min, max, mean } = bipolar(buf)
    expect(min).toBe(-0.3)
    expect(max).toBe(-0.3)
    expect(mean).toBeCloseTo(-0.3, 10)
  })

  it('reports min/max/mean for a mixed signal', () => {
    const buf = [-1, 0, 1, 0.5, -0.5]
    const { min, max, mean } = bipolar(buf)
    expect(min).toBe(-1)
    expect(max).toBe(1)
    expect(mean).toBeCloseTo(0, 10)
  })
})

describe('dbfs', () => {
  it('dbfs(1) === 0', () => {
    expect(dbfs(1)).toBe(0)
  })
  it('dbfs(0) === floor, not -Infinity', () => {
    expect(dbfs(0)).toBe(-60)
    expect(dbfs(0, -72)).toBe(-72)
  })
  it('dbfs(0.5) ~= -6.02', () => {
    expect(dbfs(0.5)).toBeCloseTo(-6.02, 2)
  })
})

describe('dbToFraction', () => {
  it('dbToFraction(0) === 1, dbToFraction(floor) === 0', () => {
    expect(dbToFraction(0)).toBe(1)
    expect(dbToFraction(-60)).toBe(0)
  })
  it('clamps above 0 and below floor', () => {
    expect(dbToFraction(10)).toBe(1)
    expect(dbToFraction(-1000)).toBe(0)
  })
})

describe('approach', () => {
  it('is frame-rate independent: one big step === many small steps', () => {
    const tau = 0.1
    const oneStep = approach(0, 1, 0.1, tau)
    let manySteps = 0
    for (let i = 0; i < 10; i++) manySteps = approach(manySteps, 1, 0.01, tau)
    expect(manySteps).toBeCloseTo(oneStep, 9)
  })
  it('snaps to target when tau <= 0 or dt <= 0', () => {
    expect(approach(0, 5, 0.1, 0)).toBe(5)
    expect(approach(0, 5, 0.1, -1)).toBe(5)
    expect(approach(0, 5, 0, 1)).toBe(5)
    expect(approach(0, 5, -1, 1)).toBe(5)
  })
})

describe('peakHold', () => {
  it('snaps up instantly to a higher target', () => {
    const state = { value: -60, hold: 0 }
    const next = peakHold(state, -10, 0.016)
    expect(next.value).toBe(-10)
    expect(next.hold).toBe(1.5)
  })

  it('holds flat across the hold window, then decays', () => {
    let state = { value: -10, hold: 1.5 }
    // lower target arrives, but we're inside the hold window
    state = peakHold(state, -40, 1.0, { holdSeconds: 1.5, decayTau: 0.5, floor: -60 })
    expect(state.value).toBe(-10)
    expect(state.hold).toBeCloseTo(0.5, 10)

    // still inside the (now shorter) hold window
    state = peakHold(state, -40, 0.4, { holdSeconds: 1.5, decayTau: 0.5, floor: -60 })
    expect(state.value).toBe(-10)
    expect(state.hold).toBeCloseTo(0.1, 10)

    // this frame's dt pushes hold negative, but decay only starts once
    // hold is already <= 0 at the *start* of a frame
    state = peakHold(state, -40, 0.2, { holdSeconds: 1.5, decayTau: 0.5, floor: -60 })
    expect(state.value).toBe(-10)
    expect(state.hold).toBeCloseTo(-0.1, 10)

    // hold is now <= 0 going in — decay begins
    state = peakHold(state, -40, 0.1, { holdSeconds: 1.5, decayTau: 0.5, floor: -60 })
    expect(state.value).toBeLessThan(-10)
  })

  it('does not mutate the state object passed in', () => {
    const state = { value: -10, hold: 1.5 }
    const snapshot = { ...state }
    peakHold(state, -40, 1.0)
    expect(state).toEqual(snapshot)
  })
})

describe('fftSizeFor', () => {
  it('returns a power of two', () => {
    for (const win of [0.001, 0.01, 0.1, 0.5, 1]) {
      const size = fftSizeFor(win, 48000)
      expect(Number.isInteger(Math.log2(size))).toBe(true)
    }
  })

  it('clamps to [32, 32768]', () => {
    expect(fftSizeFor(0, 48000)).toBe(32)
    expect(fftSizeFor(0.00001, 48000)).toBe(32)
    expect(fftSizeFor(10, 48000)).toBe(32768)
  })

  it('covers the requested window when not clamped at the ceiling', () => {
    const windowSeconds = 0.01
    const sampleRate = 48000
    const size = fftSizeFor(windowSeconds, sampleRate)
    expect(size / sampleRate).toBeGreaterThanOrEqual(windowSeconds)
    expect(size).toBe(512)
  })
})
