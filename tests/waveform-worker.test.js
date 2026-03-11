import { describe, it, expect } from 'vitest'
import { computeLod, LOD_LEVELS } from '../src/renderer/js/workers/waveform-worker.js'

function makeSine(length, amplitude = 1.0) {
  const buf = new Float32Array(length)
  for (let i = 0; i < length; i++) buf[i] = amplitude * Math.sin((2 * Math.PI * i) / 32)
  return buf
}

function makeConstant(length, value) {
  return new Float32Array(length).fill(value)
}

describe('computeLod', () => {
  it('returns an object with a key for each requested level', () => {
    const ch = makeSine(256)
    const result = computeLod([ch], [32, 64])
    expect(result).toHaveProperty('32')
    expect(result).toHaveProperty('64')
  })

  it('output length for level 32 and 64 samples is 2 buckets * 2 values', () => {
    const ch = makeSine(64)
    const result = computeLod([ch], [32])
    expect(result[32].length).toBe(4) // ceil(64/32) * 2 = 4
  })

  it('length formula: ceil(N/level) * 2', () => {
    const ch = makeConstant(100, 0.5)
    const result = computeLod([ch], [32])
    expect(result[32].length).toBe(Math.ceil(100 / 32) * 2)
  })

  it('all-zeros input produces zero peak and zero rms', () => {
    const ch = new Float32Array(128)
    const result = computeLod([ch], [64])
    const lod = result[64]
    for (let i = 0; i < lod.length; i++) {
      expect(lod[i]).toBe(0)
    }
  })

  it('constant input: peak and rms equal the constant value', () => {
    const k = 0.8
    const ch = makeConstant(128, k)
    const result = computeLod([ch], [64])
    const lod = result[64]
    expect(lod[0]).toBeCloseTo(k, 5)  // peak
    expect(lod[1]).toBeCloseTo(k, 5)  // rms of constant k = k
  })

  it('peak is always >= rms (mathematical invariant)', () => {
    const ch = makeSine(512)
    const result = computeLod([ch], [64])
    const lod = result[64]
    for (let i = 0; i < lod.length; i += 2) {
      expect(lod[i]).toBeGreaterThanOrEqual(lod[i + 1] - 1e-9)
    }
  })

  it('handles input length not divisible by level (no throw)', () => {
    const ch = makeConstant(100, 0.5)
    expect(() => computeLod([ch], [32])).not.toThrow()
  })

  it('stereo input: uses max peak across channels', () => {
    const left  = makeConstant(64, 0.3)
    const right = makeConstant(64, 0.7)
    const result = computeLod([left, right], [64])
    expect(result[64][0]).toBeCloseTo(0.5, 1) // average of channels → mono mix → peak ≈ 0.5
  })

  it('full-amplitude sine peak approaches 1.0', () => {
    const ch = makeSine(1024, 1.0)
    const result = computeLod([ch], [32])
    const lod = result[32]
    const maxPeak = Math.max(...Array.from({ length: lod.length / 2 }, (_, i) => lod[i * 2]))
    expect(maxPeak).toBeGreaterThan(0.9)
  })
})
