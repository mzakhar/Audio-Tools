import { describe, it, expect, vi } from 'vitest'
import { chordVoltages, CHORD_TYPES } from '../src/renderer/js/rack/chord.js'
import chord from '../src/renderer/js/rack/modules/chord.js'

const st = n => n / 120   // one semitone in 1 V/oct graph units (0.1 = octave)

function makeCtx(voct = 0) {
  const created = []
  const param = () => ({ value: 0, setValueAtTime: vi.fn(), setTargetAtTime: vi.fn(), cancelScheduledValues: vi.fn() })
  const node = (kind, extra = {}) => {
    const n = { kind, connect: vi.fn(), disconnect: vi.fn(function () { n.disconnected++ }), disconnected: 0, ...extra }
    created.push(n)
    return n
  }
  // The first analyser built is V/OCT's; feed it the root so update() has a pitch.
  let analysers = 0
  return {
    currentTime: 0,
    created,
    createGain: () => node('gain', { gain: param() }),
    createAnalyser: () => {
      const which = analysers++
      return node('analyser', {
        fftSize: 8,
        getFloatTimeDomainData: vi.fn(buf => { buf.fill(which === 0 ? voct : 0) })
      })
    },
    createConstantSource: () => node('const', {
      offset: param(), started: 0, stopped: 0,
      start: vi.fn(function () { this.started++ }), stop: vi.fn(function () { this.stopped++ })
    })
  }
}

describe('chordVoltages', () => {
  it('a major triad from 0.0 is root, +4, +7 semitones plus the octave', () => {
    const cvs = chordVoltages(0, 'maj')
    expect(cvs).toHaveLength(4)
    expect(cvs[0]).toBeCloseTo(0, 9)
    expect(cvs[1]).toBeCloseTo(0.0333333, 6)   // 4/120
    expect(cvs[2]).toBeCloseTo(0.0583333, 6)   // 7/120
    expect(cvs[3]).toBeCloseTo(0.1, 9)         // the octave
  })

  it('transposes with the root, one octave per 0.1', () => {
    expect(chordVoltages(0.1, 'maj').map(v => v - 0.1))
      .toEqual(chordVoltages(0, 'maj').map(v => expect.closeTo(v, 9)))
  })

  it('minor flattens the third and seventh chords keep all four voices', () => {
    expect(chordVoltages(0, 'min')[1]).toBeCloseTo(st(3), 9)
    expect(chordVoltages(0, 'maj7')).toEqual([0, st(4), st(7), st(11)].map(v => expect.closeTo(v, 9)))
    expect(chordVoltages(0, 'min7')[3]).toBeCloseTo(st(10), 9)
    expect(chordVoltages(0, 'add9')[3]).toBeCloseTo(st(14), 9)
  })

  it('inversion rotates voices up an octave, keeping the same pitch classes', () => {
    const first = chordVoltages(0, 'maj', 1)
    expect(first).toEqual([st(4), st(7), st(12), st(16)].map(v => expect.closeTo(v, 9)))
    const second = chordVoltages(0, 'maj', 2)
    expect(second[0]).toBeCloseTo(st(7), 9)
    // Every voice is still one of the chord's pitch classes.
    for (const cv of second) expect([0, 4, 7].includes(Math.round(cv * 120) % 12)).toBe(true)
  })

  it('open lifts the second voice an octave, drop2 drops the second from the top', () => {
    expect(chordVoltages(0, 'maj', 0, 'open')[1]).toBeCloseTo(st(16), 9)
    expect(chordVoltages(0, 'maj', 0, 'drop2')[2]).toBeCloseTo(st(-5), 9)
  })

  it('falls back to a major triad for an unknown type', () => {
    expect(chordVoltages(0, 'nonsense')).toEqual(chordVoltages(0, 'maj'))
  })

  it('every shipped type produces four finite voices', () => {
    for (const type of Object.keys(CHORD_TYPES)) {
      for (const voicing of ['close', 'open', 'drop2']) {
        for (let inv = 0; inv < 4; inv++) {
          const cvs = chordVoltages(0.05, type, inv, voicing)
          expect(cvs).toHaveLength(4)
          for (const cv of cvs) expect(Number.isFinite(cv)).toBe(true)
        }
      }
    }
  })
})

describe('CHORD module', () => {
  it('voices the chord onto four outputs from the V/OCT jack', () => {
    const ctx = makeCtx(0.1)      // root one octave above C4
    const inst = chord.create(ctx, { params: { type: 'maj', inversion: 0, voicing: 'close', scaleLock: 'off', scale: 'major' } })
    inst.onEvent('gate', { type: 'gate-on', time: 2 })

    const sources = ctx.created.filter(n => n.kind === 'const')
    expect(sources).toHaveLength(4)
    const scheduled = sources.map(s => s.offset.setTargetAtTime.mock.calls.at(-1)[0])
    expect(scheduled[0]).toBeCloseTo(0.1, 6)
    expect(scheduled[1]).toBeCloseTo(0.1 + st(4), 6)
    expect(scheduled[2]).toBeCloseTo(0.1 + st(7), 6)
    expect(scheduled[3]).toBeCloseTo(0.2, 6)
    for (const src of sources) expect(src.offset.setTargetAtTime.mock.calls.at(-1)[1]).toBe(2)
    inst.dispose()
  })

  it('passes the gate through unchanged apart from its timestamp', () => {
    const ctx = makeCtx(0)
    const emitEvent = vi.fn()
    const inst = chord.create(ctx, { params: {}, emitEvent })
    inst.onEvent('gate', { type: 'gate-on', time: 5, velocity: 90 })
    expect(emitEvent).toHaveBeenCalledWith('gateOut', expect.objectContaining({ type: 'gate-on', time: 5, velocity: 90 }))
    inst.dispose()
  })

  it('scaleLock snaps every voice into the scale', () => {
    const ctx = makeCtx(0)
    const inst = chord.create(ctx, { params: { type: 'dim', scaleLock: 'on', scale: 'major' } })
    inst.onEvent('gate', { type: 'gate-on', time: 1 })
    for (const src of ctx.created.filter(n => n.kind === 'const')) {
      const semitone = Math.round(src.offset.setTargetAtTime.mock.calls.at(-1)[0] * 120)
      expect([0, 2, 4, 5, 7, 9, 11]).toContain(((semitone % 12) + 12) % 12)
    }
    inst.dispose()
  })

  it('the poll only rewrites the outputs when something actually changed', () => {
    const ctx = makeCtx(0.05)
    const jobs = new Set()
    const poll = { add: job => { jobs.add(job); return () => jobs.delete(job) } }
    const inst = chord.create(ctx, { params: {}, poll })
    const src = ctx.created.find(n => n.kind === 'const')
    jobs.forEach(j => j())
    const after = src.offset.setTargetAtTime.mock.calls.length
    jobs.forEach(j => j())
    expect(src.offset.setTargetAtTime.mock.calls.length).toBe(after)
    inst.dispose()
    expect(jobs.size).toBe(0)
  })

  it('dispose stops every source and disconnects', () => {
    const ctx = makeCtx(0)
    chord.create(ctx, { params: {} }).dispose()
    for (const node of ctx.created) {
      expect(node.disconnected).toBeGreaterThan(0)
      if (node.kind === 'const') expect(node.stopped).toBe(1)
    }
  })
})
