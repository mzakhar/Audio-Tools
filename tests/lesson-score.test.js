import { describe, it, expect } from 'vitest'
import { WINDOWS, beatsToMs, markOf, targetOccurrences, scoreHits, tapErrors, calibrate, hintsFor } from '../src/renderer/js/pads/lesson-score.js'

const BPM = 60 // 1 beat = 1000 ms
const ms = (x) => x / 1000
const targets = [{ pad: 0, beat: 0 }, { pad: 2, beat: 1 }, { pad: 0, beat: 2 }, { pad: 2, beat: 3 }]
const opts = { loopBeats: 4, bpm: BPM, toBeat: 4 }
const hitsOnLoops = (shiftMs, loops) =>
  Array.from({ length: loops }, (_, k) => targets.map((t) => ({ pad: t.pad, beat: 4 * k + t.beat + ms(shiftMs), velocity: 100 }))).flat()
const hitsAt = (shiftMs) => hitsOnLoops(shiftMs, 1)

describe('basics', () => {
  it('beatsToMs', () => expect(beatsToMs(1, 120)).toBe(500))
  it('markOf windows', () => {
    expect(markOf(-25)).toBe('perfect')
    expect(markOf(26)).toBe('good')
    expect(markOf(-51)).toBe('ok')
    expect(markOf(WINDOWS.ok)).toBe('ok')
    expect(markOf(WINDOWS.ok + 1)).toBe('miss')
  })
  it('occurrences wrap across loops, sorted', () => {
    const occ = targetOccurrences(targets, { loopBeats: 4, toBeat: 6 })
    expect(occ.map((o) => o.beat)).toEqual([0, 1, 2, 3, 4, 5])
    expect(occ[4]).toMatchObject({ idx: 0, k: 1, pad: 0 })
  })
})

describe('scoreHits', () => {
  it('all on time', () => {
    const s = scoreHits(hitsAt(0), targets, opts)
    expect(s.counts).toEqual({ perfect: 4, good: 0, ok: 0, miss: 0 })
    expect(s.biasMs).toBe(0)
    expect(s.goodPct).toBe(1)
    expect(s.hitPct).toBe(1)
  })
  it('constant +40 ms late is good, bias 40, late hint', () => {
    const hits = hitsOnLoops(40, 2)
    const s = scoreHits(hits, targets, { ...opts, toBeat: 8 })
    expect(s.counts.good).toBe(8)
    expect(s.biasMs).toBeCloseTo(40)
    expect(hintsFor({ hits, score: s }).map((h) => h.id)).toContain('late')
  })
  it('offset 40 cancels it', () => {
    const s = scoreHits(hitsAt(40), targets, { ...opts, offsetMs: 40 })
    expect(s.counts.perfect).toBe(4)
    expect(s.biasMs).toBeCloseTo(0)
  })
  it('bias sign: early negative, mixed averages', () => {
    expect(scoreHits(hitsAt(-30), targets, opts).biasMs).toBeCloseTo(-30)
    const mixed = hitsAt(0)
    mixed[1].beat += ms(40)
    mixed[2].beat -= ms(20)
    expect(scoreHits(mixed, targets, opts).biasMs).toBeCloseTo(5)
  })
  it('second loop is scored as k=1', () => {
    const s = scoreHits(hitsOnLoops(0, 2), targets, { ...opts, toBeat: 8 })
    expect(s.marks.filter((m) => m.k === 1)).toHaveLength(4)
    expect(s.counts.perfect).toBe(8)
  })
  it('misses only after the window passes; pending before', () => {
    const early = scoreHits([], targets, { ...opts, toBeat: 2.05 })
    expect(early.counts.miss).toBe(2) // beats 0 and 1 over; beat 2 pending
    expect(early.pending).toBe(1)
    const end = scoreHits([], targets, { ...opts, toBeat: 3.05 })
    expect(end.counts.miss).toBe(3) // beat 3 still inside its 90 ms window
    expect(end.pending).toBe(1)
    expect(end.marks.every((m) => m.errorMs === null)).toBe(true)
    expect(end.biasMs).toBeNull()
  })
  it('extras: wrong pad; hits before 0 ignored', () => {
    const hits = [...hitsAt(0), { pad: 5, beat: 1, velocity: 90 }, { pad: 0, beat: -1, velocity: 90 }]
    expect(scoreHits(hits, targets, opts).extras).toEqual([{ pad: 5, beat: 1, velocity: 90 }])
  })
  it('double hit near one target: closest matches, other is extra', () => {
    const hits = [{ pad: 0, beat: ms(60), velocity: 100 }, { pad: 0, beat: ms(10), velocity: 100 }]
    const s = scoreHits(hits, [{ pad: 0, beat: 0 }], { ...opts, toBeat: 1 })
    expect(s.marks).toHaveLength(1)
    expect(s.marks[0].errorMs).toBeCloseTo(10)
    expect(s.extras).toEqual([{ pad: 0, beat: ms(60), velocity: 100 }])
  })
  it('velocity band', () => {
    const t = [{ pad: 0, beat: 0, vel: 40 }, { pad: 0, beat: 1, vel: 100 }, { pad: 0, beat: 2 }]
    const hits = [{ pad: 0, beat: 0, velocity: 50 }, { pad: 0, beat: 1, velocity: 60 }, { pad: 0, beat: 2, velocity: 99 }]
    const s = scoreHits(hits, t, opts)
    expect(s.marks.map((m) => m.velOk)).toEqual([true, false, null])
    expect(s.velPct).toBe(0.5)
    expect(scoreHits(hitsAt(0), targets, opts).velPct).toBeNull()
  })
  it('total 0 gives 0 pcts', () => {
    expect(scoreHits([], targets, { ...opts, toBeat: 0 })).toMatchObject({ total: 0, goodPct: 0, hitPct: 0 })
  })
})

describe('windowing and full laps', () => {
  const targets = [{ pad: 0, beat: 0 }, { pad: 2, beat: 1, vel: 100 }]
  const o = { loopBeats: 4, bpm: 120 }
  it('fromBeat drops earlier laps', () => {
    const s = scoreHits([], targets, { ...o, toBeat: 20, fromBeat: 12 })
    expect(Math.min(...s.marks.map(m => m.k))).toBe(3)
  })
  it('fullLaps counts only laps with every occurrence resolved', () => {
    const hits = [{ pad: 0, beat: 0, velocity: 100 }, { pad: 2, beat: 1, velocity: 100 }]
    expect(scoreHits(hits.slice(0, 1), targets, { ...o, toBeat: 1.1 }).fullLaps).toBe(0)
    expect(scoreHits(hits, targets, { ...o, toBeat: 3 }).fullLaps).toBe(1)
  })
  it('a missed velocity target counts against velPct', () => {
    const hits = [{ pad: 0, beat: 0, velocity: 100 }]
    expect(scoreHits(hits, targets, { ...o, toBeat: 3 }).velPct).toBe(0)
  })
})

describe('calibration', () => {
  it('tapErrors signed to nearest beat incl. negative', () => {
    const e = tapErrors([1.04, 1.96, 3, 0.9], BPM)
    expect(e[0]).toBeCloseTo(40)
    expect(e[1]).toBeCloseTo(-40)
    expect(e[2]).toBe(0)
    expect(e[3]).toBeCloseTo(-100)
  })
  it('median and MAD', () => {
    expect(calibrate([10, 20, 30, 40, 50, 60, 70, 80, 1000])).toEqual({ ok: true, offsetMs: 50, spreadMs: 20 })
  })
  it('even count median rounds to 0.1', () => {
    expect(calibrate([10, 20, 30, 40, 50.2, 60, 70, 80]).offsetMs).toBe(45.1)
  })
  it('too few', () => expect(calibrate([1, 2, 3])).toEqual({ ok: false, reason: 'too-few' }))
})

describe('hintsFor', () => {
  const ids = (a) => a.map((h) => h.id)
  const flat = (n, v) => Array.from({ length: n }, () => ({ pad: 0, beat: 0, velocity: v }))
  it('all-127', () => expect(ids(hintsFor({ hits: flat(8, 127), score: null }))).toEqual(['all-127']))
  it('soft', () => expect(ids(hintsFor({ hits: flat(8, 60), score: null }))).toEqual(['soft']))
  it('early', () => {
    const hits = hitsOnLoops(-40, 2)
    const s = scoreHits(hits, targets, { ...opts, toBeat: 8 })
    expect(ids(hintsFor({ hits, score: s }))).toContain('early')
  })
  it('no bias hint with < 6 matched', () => {
    const s = scoreHits(hitsAt(40), targets, opts)
    expect(ids(hintsFor({ hits: hitsAt(40), score: s }))).not.toContain('late')
  })
  it('extras', () => {
    const hits = [...hitsAt(0), ...Array.from({ length: 6 }, () => ({ pad: 9, beat: 1, velocity: 100 }))]
    expect(ids(hintsFor({ hits, score: scoreHits(hits, targets, opts) }))).toContain('extras')
  })
  it('clean play gives none', () => {
    expect(hintsFor({ hits: hitsAt(0), score: scoreHits(hitsAt(0), targets, opts) })).toEqual([])
  })
})
