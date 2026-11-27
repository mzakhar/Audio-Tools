import { describe, it, expect } from 'vitest'
import { REPEAT_RATES } from '../src/renderer/js/pads/repeat.js'
import { LESSONS, lessonById, nextLesson, evaluate, emptyProgress, parseProgress, markDone, setCalibration } from '../src/renderer/js/pads/lessons.js'

const ev = (id, ctx) => evaluate(lessonById(id), ctx)

describe('LESSONS data', () => {
  it('is 0..11 with unique ids and n == index', () => {
    expect(LESSONS).toHaveLength(12)
    LESSONS.forEach((l, i) => expect(l.n).toBe(i))
    expect(new Set(LESSONS.map(l => l.id)).size).toBe(12)
  })
  it.each(LESSONS.map(l => [l.id, l]))('%s is valid', (_, l) => {
    expect(l.title && l.concept).toBeTruthy()
    expect(l.steps.length).toBeGreaterThan(0)
    expect(l.groove).toBeGreaterThanOrEqual(0.5)
    expect(l.groove).toBeLessThanOrEqual(0.75)
    expect(l.bpm).toBeGreaterThanOrEqual(80)
    expect(l.kitId).toBe('default-909')
    for (const t of l.targets) {
      expect(t.pad).toBeGreaterThanOrEqual(0)
      expect(t.pad).toBeLessThanOrEqual(15)
      expect(t.beat).toBeGreaterThanOrEqual(0)
      expect(t.beat).toBeLessThan(l.bars * 4)
    }
    if (l.setup?.repeatRate) expect(REPEAT_RATES).toHaveProperty(l.setup.repeatRate)
  })
  it('scored lessons have targets', () => {
    for (const l of LESSONS) if (['score', 'phrase', 'velocity'].includes(l.pass.type)) expect(l.targets.length).toBeGreaterThan(0)
  })
})

describe('evaluate', () => {
  it('calibration', () => {
    expect(ev('l0', { calibration: { ok: true } }).done).toBe(true)
    expect(ev('l0', { calibration: { ok: false } }).done).toBe(false)
    expect(ev('l0', {}).done).toBe(false)
  })
  it('velocity', () => {
    expect(ev('l1', { score: { velPct: 0.85, fullLaps: 1 } }).done).toBe(true)
    expect(ev('l1', { score: { velPct: 1, fullLaps: 0, total: 1 } }).done).toBe(false)   // one good hit is not a lap
    const r = ev('l1', { score: { velPct: 0.4, fullLaps: 1 } })
    expect(r.done).toBe(false)
    expect(r.progress).toBeCloseTo(0.5)
    expect(ev('l1', { score: null }).progress).toBe(0)
  })
  it('score + loops', () => {
    expect(ev('l2', { score: { goodPct: 0.8, total: 4, fullLaps: 1 }, loops: 1 }).done).toBe(true)
    expect(ev('l2', { score: { goodPct: 0.7, total: 4, fullLaps: 1 }, loops: 3 }).done).toBe(false)
    expect(ev('l3', { score: { goodPct: 0.9, total: 12, fullLaps: 1 }, loops: 1 }).done).toBe(false)
    const r = ev('l3', { score: { goodPct: 0.9, total: 12, fullLaps: 1 }, loops: 2 })
    expect(r.done).toBe(true)
    expect(r.label).toContain('2/2 loops')
  })
  it('repeat', () => {
    expect(ev('l4', { repeatBeats: 8 }).done).toBe(true)
    const r = ev('l4', { repeatBeats: 4 })
    expect(r.done).toBe(false)
    expect(r.progress).toBe(0.5)
  })
  it('pads-in-loop', () => {
    expect(ev('l5', { clipPads: new Set([0, 2, 6]) }).done).toBe(true)
    expect(ev('l5', { clipPads: new Set([0, 2]) })).toMatchObject({ done: false, label: '2/3 pads' })
  })
  it('score/phrase need one full resolved lap', () => {
    expect(ev('l2', { score: { goodPct: 1, total: 1, fullLaps: 0 }, loops: 1 }).done).toBe(false)
    expect(ev('l9', { score: { goodPct: 1, total: 1, fullLaps: 0 }, pads: { ladder: 'tune' } }).done).toBe(false)
  })
  it('pads-in-loop ignores pads already in the clip at start', () => {
    expect(ev('l5', { startPads: new Set([0, 2, 6]), clipPads: new Set([0, 2, 6]) }).done).toBe(false)
    expect(ev('l5', { startPads: new Set([0]), clipPads: new Set([0, 2, 6, 7]) }).done).toBe(true)
  })
  it('pad-empty counts a pad seen after start', () => {
    expect(ev('l6', { startPads: new Set(), seenPads: new Set([0]), clipPads: new Set() }).done).toBe(true)
    expect(ev('l6', { startPads: new Set(), seenPads: new Set(), clipPads: new Set() }).done).toBe(false)
  })
  it('pad-empty needs start presence and absence now', () => {
    expect(ev('l6', { startPads: new Set([0, 1]), clipPads: new Set([1]) }).done).toBe(true)
    expect(ev('l6', { startPads: new Set([0, 1]), clipPads: new Set([0, 1]) }).done).toBe(false)
    expect(ev('l6', { startPads: new Set([1]), clipPads: new Set([1]) }).done).toBe(false)
  })
  it('groove-ab and snap-compare', () => {
    expect(ev('l7', { grooveHeard: [0.5, 0.54, 0.62, 0.66] }).done).toBe(true)
    expect(ev('l7', { grooveHeard: [0.5, 0.54, 0.62] })).toMatchObject({ done: false, progress: 0.75 })
    expect(ev('l8', { snapHeard: [0.5, 1] }).done).toBe(true)
    expect(ev('l8', { snapHeard: [1] }).done).toBe(false)
  })
  it('phrase needs ladder on', () => {
    const score = { goodPct: 0.8, total: 8, fullLaps: 1 }
    expect(ev('l9', { score, pads: { ladder: 'tune' } }).done).toBe(true)
    expect(ev('l9', { score, pads: { ladder: null } }).done).toBe(false)
    expect(ev('l9', { score: { goodPct: 0.5, total: 8, fullLaps: 1 }, pads: { ladder: 'tune' } }).done).toBe(false)
  })
  it('mutes', () => {
    expect(ev('l10', { mutesInTime: 4 }).done).toBe(true)
    expect(ev('l10', { mutesInTime: 3 }).done).toBe(false)
  })
  it('sample-pads counts new clip pads that hold samples', () => {
    const samplePads = new Set([0, 1, 2, 3, 4])
    const base = { samplePads, startPads: new Set([4]) }
    expect(ev('l11', { ...base, clipPads: new Set([0, 1, 2, 3]) })).toMatchObject({ done: true, progress: 1 })
    expect(ev('l11', { ...base, clipPads: new Set([0, 1, 2, 4]) }).done).toBe(false)   // 4 was in the clip at start
    expect(ev('l11', { ...base, clipPads: new Set([0, 1, 2, 9]) }).done).toBe(false)   // 9 is not a sample pad
    expect(ev('l11', { clipPads: new Set([0, 1, 2, 3]) }).done).toBe(false)             // no sample pads at all
  })
})

describe('progress', () => {
  it('nextLesson skips done and wraps', () => {
    expect(nextLesson('l0', emptyProgress()).id).toBe('l1')
    expect(nextLesson('l11', emptyProgress()).id).toBe('l0')
    let p = emptyProgress()
    p = markDone(p, 'l1', 'x')
    expect(nextLesson('l0', p).id).toBe('l2')
    for (const l of LESSONS) p = markDone(p, l.id, 'x')
    expect(nextLesson('l3', p)).toBeNull()
    const q = LESSONS.reduce((a, l) => (l.id === 'l1' ? a : markDone(a, l.id, 'x')), emptyProgress())
    expect(nextLesson('l5', q).id).toBe('l1')
  })
  it('parseProgress tolerates garbage', () => {
    for (const t of [undefined, null, '', 'nope', '[]', '{"v":2}', '{"v":1}', '{"v":1,"done":5}']) expect(parseProgress(t)).toEqual(emptyProgress())
  })
  it('parseProgress round-trips', () => {
    const p = setCalibration(markDone(emptyProgress(), 'l2', 't'), { offsetMs: 12, spreadMs: 4 }, 'u')
    expect(parseProgress(JSON.stringify(p))).toEqual(p)
    expect(parseProgress('{"v":1,"done":{},"calibration":{"offsetMs":"x"}}').calibration).toBeNull()
  })
  it('markDone and setCalibration do not mutate', () => {
    const p = emptyProgress()
    const q = markDone(p, 'l1', 't')
    const r = setCalibration(p, { offsetMs: 1, spreadMs: 2, ok: true }, 't')
    expect(p).toEqual(emptyProgress())
    expect(q.done).toEqual({ l1: 't' })
    expect(r.calibration).toEqual({ offsetMs: 1, spreadMs: 2, at: 't' })
  })
})
