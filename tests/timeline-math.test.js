import { describe, it, expect } from 'vitest'
import {
  beatsToSeconds, secondsToBeats, barBeats, snapToGrid,
  beatsToPx, pxToBeats, samplesPerPixel, selectLodLevel,
  visibleBeatRange, rulerTicks, LOD_LEVELS
} from '../src/renderer/js/utils/timeline-math.js'

describe('beatsToSeconds', () => {
  it('converts 4 beats at 120bpm to 2 seconds', () => {
    expect(beatsToSeconds(4, 120)).toBe(2.0)
  })
  it('returns 0 for 0 beats', () => {
    expect(beatsToSeconds(0, 120)).toBe(0)
  })
  it('handles non-standard BPM', () => {
    expect(beatsToSeconds(1, 60)).toBe(1.0)
  })
})

describe('secondsToBeats', () => {
  it('converts 2 seconds at 120bpm to 4 beats', () => {
    expect(secondsToBeats(2.0, 120)).toBe(4.0)
  })
  it('round-trip with beatsToSeconds', () => {
    const orig = 7
    expect(secondsToBeats(beatsToSeconds(orig, 95), 95)).toBeCloseTo(orig, 10)
  })
})

describe('barBeats', () => {
  it('beat 0 is bar 1, beat-in-bar 1', () => {
    expect(barBeats(0, [4, 4])).toEqual({ bar: 1, beatInBar: 1 })
  })
  it('beat 4 is bar 2, beat-in-bar 1', () => {
    expect(barBeats(4, [4, 4])).toEqual({ bar: 2, beatInBar: 1 })
  })
  it('beat 5 is bar 2, beat-in-bar 2', () => {
    expect(barBeats(5, [4, 4])).toEqual({ bar: 2, beatInBar: 2 })
  })
})

describe('snapToGrid', () => {
  it('snaps 1.3 to 1.25 with subdivisions=4', () => {
    expect(snapToGrid(1.3, 4)).toBeCloseTo(1.25, 5)
  })
  it('returns 0 for 0', () => {
    expect(snapToGrid(0, 4)).toBe(0)
  })
  it('snaps 0.9 to 1 with subdivisions=1', () => {
    expect(snapToGrid(0.9, 1)).toBe(1)
  })
})

describe('beatsToPx / pxToBeats', () => {
  it('1 beat = pixelsPerBeat px', () => {
    expect(beatsToPx(1, 64)).toBe(64)
  })
  it('64px at 64ppb = 1 beat', () => {
    expect(pxToBeats(64, 64)).toBe(1.0)
  })
  it('round-trip', () => {
    expect(pxToBeats(beatsToPx(3.5, 40), 40)).toBeCloseTo(3.5, 10)
  })
})

describe('samplesPerPixel', () => {
  it('computes correct value at 40ppb, 120bpm, 44100sr', () => {
    // samplesPerBeat = 44100 * (60/120) = 22050
    // spp = 22050 / 40 = 551.25
    expect(samplesPerPixel(40, 120, 44100)).toBeCloseTo(551.25, 2)
  })
  it('higher zoom = fewer samples per pixel', () => {
    expect(samplesPerPixel(128, 120, 44100)).toBeLessThan(samplesPerPixel(40, 120, 44100))
  })
})

describe('selectLodLevel', () => {
  it('returns minimum LOD for very small SPP', () => {
    expect(selectLodLevel(10)).toBe(LOD_LEVELS[0])
  })
  it('returns maximum LOD for very large SPP', () => {
    expect(selectLodLevel(99999)).toBe(LOD_LEVELS[LOD_LEVELS.length - 1])
  })
  it('selects correct level for 551', () => {
    expect(selectLodLevel(551)).toBe(1024)
  })
  it('selects exact match', () => {
    expect(selectLodLevel(128)).toBe(128)
  })
  it('selects next level up when between levels', () => {
    expect(selectLodLevel(100)).toBe(128)
  })
})

describe('visibleBeatRange', () => {
  it('returns correct range with no scroll', () => {
    const range = visibleBeatRange(0, 640, 64)
    expect(range.startBeat).toBeCloseTo(0, 5)
    expect(range.endBeat).toBeCloseTo(10, 5)
  })
  it('scrollLeft shifts range', () => {
    const range = visibleBeatRange(128, 640, 64)
    expect(range.startBeat).toBeCloseTo(2, 5)
    expect(range.endBeat).toBeCloseTo(12, 5)
  })
})

describe('rulerTicks', () => {
  it('returns empty array for zero range', () => {
    expect(rulerTicks(5, 5, 40, [4, 4])).toHaveLength(0)
  })
  it('includes bar ticks at multiples of time signature numerator', () => {
    const ticks = rulerTicks(0, 8, 40, [4, 4])
    const barTicks = ticks.filter(t => t.isBar)
    const barBeatsVals = barTicks.map(t => t.beat)
    expect(barBeatsVals).toContain(0)
    expect(barBeatsVals).toContain(4)
    expect(barBeatsVals).toContain(8)
  })
  it('bar ticks have numeric string labels', () => {
    const ticks = rulerTicks(0, 4, 40, [4, 4])
    const barTick = ticks.find(t => t.isBar && t.beat === 0)
    expect(barTick).toBeDefined()
    expect(barTick.label).toBe('1')
  })
  it('x position = beatsToPx(beat, ppb) - scrollLeft', () => {
    const ticks = rulerTicks(0, 8, 64, [4, 4], 128)
    const barAtBeat4 = ticks.find(t => t.beat === 4)
    expect(barAtBeat4.x).toBeCloseTo(4 * 64 - 128, 5)
  })
})
