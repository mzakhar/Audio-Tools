import { describe, expect, it, vi } from 'vitest'
import { createLessonSession, nextTarget, inBarWindow, PROGRESS_KEY } from '../src/renderer/js/pads/lesson-session.js'
import { lessonById } from '../src/renderer/js/pads/lessons.js'

const memory = () => { const m = new Map(); return { getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), m } }

function make(extra = {}) {
  const storage = memory()
  const state = { pads: { groove: 0.5, snapStrength: 1, muted: [] }, clip: new Set(), bpm: 120 }
  const updates = []
  const session = createLessonSession({
    storage, getPads: () => state.pads, getBpm: () => state.bpm, getLoopBeats: () => 8,
    getClipPads: () => state.clip, applySetup: vi.fn(), onUpdate: m => updates.push(m),
    now: () => (clock += 200), iso: () => '2026-01-01T00:00:00Z', ...extra
  })
  return { session, storage, state, updates }
}
let clock = 0
const last = u => u[u.length - 1]

describe('pure helpers', () => {
  const targets = [{ pad: 0, beat: 0 }, { pad: 2, beat: 2.5 }]
  it('nextTarget finds next and wraps', () => {
    expect(nextTarget(targets, 4, 0)).toBe(0)
    expect(nextTarget(targets, 4, 0.1)).toBe(2)
    expect(nextTarget(targets, 4, 3)).toBe(0)
    expect(nextTarget(targets, 4, 6.9)).toBe(0)
    expect(nextTarget([], 4, 0)).toBe(null)
  })
  it('inBarWindow', () => {
    expect(inBarWindow(4.02, 120, 4)).toBe(true)
    expect(inBarWindow(3.95, 120, 4)).toBe(true)
    expect(inBarWindow(2, 120, 4)).toBe(false)
    expect(inBarWindow(-1, 120, 4)).toBe(false)
  })
})

describe('session', () => {
  it('start applies setup and emits', () => {
    const applySetup = vi.fn()
    const { session, updates } = make({ applySetup })
    expect(session.start('l3')).toBe(true)
    expect(applySetup).toHaveBeenCalled()
    expect(last(updates).lesson.id).toBe('l3')
    expect(session.start('nope')).toBe(false)
  })

  it('perfect hits finish a scored lesson and save progress', () => {
    const { session, storage, updates } = make()
    session.start('l2')
    const l = lessonById('l2')
    const loopBeats = l.bars * 4
    for (let k = 0; k < 2; k++) {
      for (const t of l.targets) session.hit({ pad: t.pad, beat: k * loopBeats + t.beat, velocity: 100 })
      session.wrap(k)
    }
    session.tick(2 * loopBeats + 1)
    expect(last(updates).done).toBe(true)
    expect(JSON.parse(storage.m.get(PROGRESS_KEY)).done.l2).toBeTruthy()
  })

  it('calibration: 16 taps save an offset', () => {
    const { session, storage, updates } = make()
    session.start('l0')
    for (let i = 0; i < 16; i++) session.hit({ pad: 0, beat: i + 0.08, velocity: 100 })
    expect(last(updates).result.done).toBe(true)
    expect(JSON.parse(storage.m.get(PROGRESS_KEY)).calibration.offsetMs).toBe(40)
  })

  it('repeat run extends over consecutive repeat hits', () => {
    const { session, updates } = make()
    session.start('l4')
    for (let i = 0; i <= 36; i++) session.hit({ pad: 6, beat: 1 + i * 0.25, velocity: 90, source: 'repeat' })
    session.tick(12)
    expect(last(updates).done).toBe(true)
  })

  it('a gap over a beat breaks the repeat run', () => {
    const { session, updates } = make()
    session.start('l4')
    for (let i = 0; i < 20; i++) session.hit({ pad: 6, beat: 1 + i * 0.25, velocity: 90, source: 'repeat' })
    for (let i = 0; i < 20; i++) session.hit({ pad: 6, beat: 20 + i * 0.25, velocity: 90, source: 'repeat' })
    session.tick(40)
    expect(last(updates).done).toBe(false)
  })

  it('padsChanged counts only in-time mute changes', () => {
    const { session, updates } = make()
    session.start('l10')
    for (let i = 0; i < 4; i++) session.padsChanged({ muted: [] }, { muted: [36] }, 4 * (i + 1) + 0.01)
    session.padsChanged({ muted: [] }, { muted: [37] }, 2)
    session.tick(20)
    expect(last(updates).done).toBe(true)
  })

  it('negative beats are ignored; stop emits null', () => {
    const { session, updates } = make()
    session.start('l2')
    session.hit({ pad: 0, beat: -1, velocity: 100 })
    session.stop()
    expect(last(updates)).toBe(null)
    expect(session.active()).toBe(null)
  })
})
