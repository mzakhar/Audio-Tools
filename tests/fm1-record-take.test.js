import { describe, it, expect } from 'vitest'
import { takeFileName, clipFields, endTimeFor, lengthBeats, parseOptions, nextPhase, isActive } from '../src/renderer/js/fm1/record-take.js'

describe('takeFileName', () => {
  const d = new Date(2026, 10, 28, 9, 5, 7)
  it('stamps and sanitises to the Electron writer pattern', () => {
    expect(takeFileName('Lead', d)).toBe('fm1-Lead-20261128-090507-000.wav')
    // two takes in one second get different names
    expect(takeFileName('Lead', new Date(2026, 10, 28, 9, 5, 7, 42))).toBe('fm1-Lead-20261128-090507-042.wav')
    for (const name of ['../../etc/passwd', 'a b/c\\d:e*?"<>|', 'Süß ünï', '', '   ', null, 'x'.repeat(200)]) {
      expect(takeFileName(name, d)).toMatch(/^[\w.-]+\.wav$/i)
    }
    expect(takeFileName('x'.repeat(200), d).length).toBeLessThan(80)
  })
})

describe('clipFields', () => {
  it('beats math at 120 bpm', () => {
    expect(clipFields({ startBeat: 0, frames: 96000, rate: 48000, bpm: 120 })).toEqual({ startBeat: 0, duration: 4, offset: 0, fadeIn: 0, fadeOut: 0 })
  })
  it('beats math at 97.5 bpm with a nonzero start beat', () => {
    const c = clipFields({ startBeat: 8, frames: 44100 * 3, rate: 44100, bpm: 97.5 })
    expect(c.startBeat).toBe(8)
    expect(c.duration).toBeCloseTo(3 * 97.5 / 60, 10)
    expect(c.offset).toBe(0)
  })
})

describe('endTimeFor', () => {
  it('is null until Stop; bars are 4 beats at the frozen bpm', () => {
    expect(endTimeFor({ startTime: 5, bars: null, bpm: 120 })).toBeNull()
    expect(endTimeFor({ startTime: 5, bars: 2, bpm: 120 })).toBe(9)
    expect(endTimeFor({ startTime: 1, bars: 1, bpm: 97.5 })).toBeCloseTo(1 + 4 * 60 / 97.5, 9)
  })
  it('uses the project time signature: 2 bars of 3/4 at 120 bpm = 6 beats = 3 s', () => {
    expect(lengthBeats(2, 3)).toBe(6)
    expect(lengthBeats(null, 3)).toBeNull()
    expect(endTimeFor({ startTime: 5, bars: 2, bpm: 120, beatsPerBar: 3 })).toBe(8)
  })
})

describe('parseOptions', () => {
  it('defaults', () => {
    expect(parseOptions({})).toEqual({ opts: { startBeat: 0, bars: null, tail: 2, mute: false } })
  })
  it('parses valid input', () => {
    expect(parseOptions({ startBeat: '8', bars: '4', tail: '0', mute: true }).opts).toEqual({ startBeat: 8, bars: 4, tail: 0, mute: true })
  })
  it.each([[{ startBeat: '-1' }], [{ startBeat: '1.5' }], [{ bars: '0' }], [{ bars: '2.5' }], [{ tail: '11' }], [{ tail: '-1' }], [{ tail: 'x' }]])('rejects %j', raw => {
    expect(parseOptions(raw).error).toBeTruthy()
  })
})

describe('phase machine', () => {
  it('walks the happy path and ignores events that do not apply', () => {
    let p = 'idle'
    for (const e of ['start', 'armed', 'stop', 'finish', 'saved']) p = nextPhase(p, e)
    expect(p).toBe('done')
    expect(nextPhase('idle', 'stop')).toBe('idle')
    expect(nextPhase('saving', 'cancel')).toBe('saving')
  })
  it('failure keeps the take pending; discard clears it', () => {
    expect(nextPhase('saving', 'failed')).toBe('pending')
    expect(nextPhase('pending', 'retry')).toBe('saving')
    expect(nextPhase('pending', 'discard')).toBe('idle')
  })
  it('cancel from any live phase goes idle', () => {
    for (const p of ['arming', 'recording', 'tail']) expect(nextPhase(p, 'cancel')).toBe('idle')
    expect(isActive('pending')).toBe(false)
    expect(isActive('recording')).toBe(true)
  })
})
