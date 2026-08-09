import { describe, it, expect } from 'vitest'
import {
  C4_HZ, PITCH_CV_GAIN, midiToPitchCv, pitchCvToMidi,
  pitchCvToHz, hzToPitchCv, voltsToCents, gateFromVelocity, clampCv
} from '../src/renderer/js/utils/cv.js'

describe('midiToPitchCv / pitchCvToMidi', () => {
  it('midi 60 (C4) is cv 0', () => {
    expect(midiToPitchCv(60)).toBe(0)
  })
  it('midi 72 (C5, one octave up) is cv 0.1', () => {
    expect(midiToPitchCv(72)).toBeCloseTo(0.1, 10)
  })
  it('midi 48 (C3, one octave down) is cv -0.1', () => {
    expect(midiToPitchCv(48)).toBeCloseTo(-0.1, 10)
  })
  it('round-trips', () => {
    expect(pitchCvToMidi(midiToPitchCv(67))).toBeCloseTo(67, 10)
  })
})

describe('pitchCvToHz / hzToPitchCv', () => {
  it('cv 0 is C4', () => {
    expect(pitchCvToHz(0)).toBeCloseTo(C4_HZ, 8)
  })
  it('cv 0.1 (one octave up) is C5', () => {
    expect(pitchCvToHz(0.1)).toBeCloseTo(523.2511306011972, 6)
  })
  it('cv -0.1 (one octave down) is C3', () => {
    expect(pitchCvToHz(-0.1)).toBeCloseTo(130.8127826502993, 6)
  })
  it('round-trips through several values', () => {
    for (const cv of [0, 0.1, -0.1, 0.25, -0.35, 0.05]) {
      expect(hzToPitchCv(pitchCvToHz(cv))).toBeCloseTo(cv, 8)
    }
  })
  it('returns 0 for non-positive hz', () => {
    expect(hzToPitchCv(0)).toBe(0)
    expect(hzToPitchCv(-10)).toBe(0)
  })
})

describe('PITCH_CV_GAIN', () => {
  it('turns 0.1 graph units into 1200 cents', () => {
    expect(0.1 * PITCH_CV_GAIN).toBe(1200)
  })
})

describe('voltsToCents', () => {
  it('1 volt is 1200 cents', () => {
    expect(voltsToCents(1)).toBe(1200)
  })
  it('0 volts is 0 cents', () => {
    expect(voltsToCents(0)).toBe(0)
  })
  it('scales linearly', () => {
    expect(voltsToCents(0.5)).toBe(600)
  })
})

describe('gateFromVelocity', () => {
  it('positive velocity gives gate 1', () => {
    expect(gateFromVelocity(0.8)).toBe(1)
    expect(gateFromVelocity(1)).toBe(1)
  })
  it('zero velocity gives gate 0', () => {
    expect(gateFromVelocity(0)).toBe(0)
  })
})

describe('clampCv', () => {
  it('passes through in-range values', () => {
    expect(clampCv(0.5)).toBe(0.5)
  })
  it('clamps above max to default max', () => {
    expect(clampCv(2)).toBe(1)
  })
  it('clamps below min to default min', () => {
    expect(clampCv(-2)).toBe(-1)
  })
  it('respects custom bounds', () => {
    expect(clampCv(10, 0, 5)).toBe(5)
    expect(clampCv(-10, 0, 5)).toBe(0)
  })
  it('non-finite input treats value as 0, then clamps into range', () => {
    expect(clampCv(NaN)).toBe(0)
    expect(clampCv(Infinity)).toBe(0)
    expect(clampCv(-Infinity)).toBe(0)
    expect(clampCv(NaN, 2, 5)).toBe(2)
  })
})
