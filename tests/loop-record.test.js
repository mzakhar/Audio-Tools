import { describe, it, expect } from 'vitest'
import {
  loopPosition, newPass, passIsEmpty, passAddHit, passWipe, applyPass, notesInWindow, clicksInWindow,
} from '../src/renderer/js/pads/loop-record.js'

const L = 8
const opts = { loopBeats: L, grid: 0.25, strength: 1, swing: 0.5, id: 'n1' }
const n = (id, pitch, startBeat) => ({ id, pitch, startBeat, velocity: 1, duration: 0.25 })

describe('loopPosition', () => {
  it('wraps positive and negative', () => {
    expect(loopPosition(9, L)).toBe(1)
    expect(loopPosition(-1, L)).toBe(7)
    expect(loopPosition(8, L)).toBe(0)
  })
})

describe('passAddHit', () => {
  it('lap is the snapped lap: 7.95 snapping to the next lap is lap 1', () => {
    expect(passAddHit(newPass(), { pitch: 36, velocity: 100, beat: 7.95 }, opts).added[0]).toMatchObject({ startBeat: 0, lap: 1 })
    expect(passAddHit(newPass(), { pitch: 36, velocity: 100, beat: 1.02 }, opts).added[0]).toMatchObject({ startBeat: 1, lap: 0 })
  })
  it('snaps, scales velocity, uses id and grid duration', () => {
    const p = passAddHit(newPass(), { pitch: 36, velocity: 127, beat: 1.3 }, opts)
    expect(p.added).toEqual([{ id: 'n1', pitch: 36, velocity: 1, startBeat: 1.25, duration: 0.25, lap: 0 }])
    expect(passIsEmpty(p)).toBe(false)
    expect(applyPass([], p)).toEqual([{ id: 'n1', pitch: 36, velocity: 1, startBeat: 1.25, duration: 0.25 }])   // lap stripped for commit
    expect(applyPass([], p, true)[0].lap).toBe(0)
  })
  it('snap at loop end wraps to 0', () => {
    const p = passAddHit(newPass(), { pitch: 36, velocity: 64, beat: 7.95 }, opts)
    expect(p.added[0].startBeat).toBe(0)
  })
  it('swing and strength 0', () => {
    const s = passAddHit(newPass(), { pitch: 1, velocity: 1, beat: 0.3 }, { ...opts, swing: 0.66 })
    expect(s.added[0].startBeat).toBe(0.33)
    const raw = passAddHit(newPass(), { pitch: 1, velocity: 1, beat: 0.3 }, { ...opts, strength: 0 })
    expect(raw.added[0].startBeat).toBe(0.3)
  })
  it('does not mutate input pass', () => {
    const p0 = newPass()
    passAddHit(p0, { pitch: 1, velocity: 1, beat: 0 }, opts)
    expect(passIsEmpty(p0)).toBe(true)
  })
})

describe('passWipe', () => {
  const clip = [n('a', 36, 1), n('b', 38, 1), n('c', 36, 7.5), n('d', 36, 4)]
  it('pitch filter and window', () => {
    const p = passWipe(newPass(), clip, { pitch: 36, fromBeat: 0, toBeat: 2, loopBeats: L })
    expect(p.wiped).toEqual(['a'])
  })
  it('null pitch wipes all pitches', () => {
    const p = passWipe(newPass(), clip, { pitch: null, fromBeat: 0, toBeat: 2, loopBeats: L })
    expect(p.wiped.sort()).toEqual(['a', 'b'])
  })
  it('window end is exclusive', () => {
    const p = passWipe(newPass(), clip, { pitch: 36, fromBeat: 0, toBeat: 1, loopBeats: L })
    expect(p.wiped).toEqual([])
  })
  it('window spanning loop wrap', () => {
    const p = passWipe(newPass(), clip, { pitch: null, fromBeat: 7, toBeat: 9.5, loopBeats: L })
    expect(p.wiped.sort()).toEqual(['a', 'b', 'c'])
  })
  it('transport beat past first loop', () => {
    const p = passWipe(newPass(), clip, { pitch: 36, fromBeat: 12, toBeat: 12.5, loopBeats: L })
    expect(p.wiped).toEqual(['d'])
  })
  it('window longer than loop is capped to whole loop', () => {
    const p = passWipe(newPass(), clip, { pitch: null, fromBeat: 0, toBeat: 100, loopBeats: L })
    expect(p.wiped.sort()).toEqual(['a', 'b', 'c', 'd'])
  })
  it('drops matching added hits', () => {
    let p = passAddHit(newPass(), { pitch: 36, velocity: 100, beat: 1 }, opts)
    p = passAddHit(p, { pitch: 36, velocity: 100, beat: 5 }, { ...opts, id: 'n2' })
    p = passWipe(p, [], { pitch: 36, fromBeat: 0, toBeat: 2, loopBeats: L })
    expect(p.added.map((x) => x.id)).toEqual(['n2'])
  })
})

describe('applyPass', () => {
  it('removes wiped, adds, sorts by startBeat then pitch', () => {
    const clip = [n('a', 40, 2), n('b', 36, 0), n('c', 36, 2)]
    const pass = { added: [n('x', 38, 2), n('y', 50, 1)], wiped: ['b'] }
    expect(applyPass(clip, pass).map((x) => x.id)).toEqual(['y', 'c', 'x', 'a'])
  })
  it('empty pass is identity', () => {
    const clip = [n('a', 40, 2)]
    expect(applyPass(clip, newPass())).toEqual(clip)
  })
})

describe('notesInWindow', () => {
  const notes = [n('a', 36, 1), n('b', 38, 7.5)]
  it('single repetition', () => {
    expect(notesInWindow(notes, L, 0, 4).map((x) => x.beat)).toEqual([1])
  })
  it('multiple loop repetitions, sorted', () => {
    const r = notesInWindow(notes, L, 6, 18)
    expect(r.map((x) => [x.note.id, x.beat])).toEqual([['b', 7.5], ['a', 9], ['b', 15.5], ['a', 17]])
  })
  it('negative fromBeat ignores count-in region', () => {
    expect(notesInWindow(notes, L, -4, 2).map((x) => x.beat)).toEqual([1])
  })
  it('reports the lap index k', () => {
    expect(notesInWindow(notes, L, 6, 18).map((x) => x.k)).toEqual([0, 1, 1, 2])
  })
  it('notes beyond a shrunk loop wrap', () => {
    expect(notesInWindow([n('z', 36, 9)], 4, 0, 10).map((x) => x.beat)).toEqual([1, 5, 9])
  })
  it('from inclusive, to exclusive', () => {
    expect(notesInWindow(notes, L, 1, 9).map((x) => x.beat)).toEqual([1, 7.5])
    expect(notesInWindow(notes, L, 0, 1)).toEqual([])
  })
})

describe('clicksInWindow', () => {
  it('integer beats with bar accent', () => {
    expect(clicksInWindow(0, 5, 4)).toEqual([
      { beat: 0, accent: true }, { beat: 1, accent: false }, { beat: 2, accent: false },
      { beat: 3, accent: false }, { beat: 4, accent: true },
    ])
  })
  it('fractional window start rounds up', () => {
    expect(clicksInWindow(0.5, 2.5, 4).map((c) => c.beat)).toEqual([1, 2])
  })
  it('negative beats (count-in) accent on bar boundary', () => {
    expect(clicksInWindow(-4, 0, 4)).toEqual([
      { beat: -4, accent: true }, { beat: -3, accent: false }, { beat: -2, accent: false }, { beat: -1, accent: false },
    ])
  })
  it('empty window', () => {
    expect(clicksInWindow(0.2, 0.8, 4)).toEqual([])
  })
})
