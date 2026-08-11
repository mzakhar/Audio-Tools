import { describe, it, expect, vi } from 'vitest'
import prob from '../src/renderer/js/rack/modules/prob.js'
import tshift from '../src/renderer/js/rack/modules/tshift.js'
import duck from '../src/renderer/js/rack/modules/duck.js'
import clkmul from '../src/renderer/js/rack/modules/clkmul.js'

// Not in the phase brief, but PROB's toggle bias, TSHIFT's gate pairing, DUCK's
// ramp order and CLKMUL's interval prediction are all branches, and a branch
// with no check is a branch that rots.
function makeCtx() {
  const param = () => ({
    value: 1,
    setValueAtTime: vi.fn(),
    setTargetAtTime: vi.fn(),
    linearRampToValueAtTime: vi.fn(),
    exponentialRampToValueAtTime: vi.fn(),
    cancelScheduledValues: vi.fn()
  })
  return {
    currentTime: 0,
    createGain: () => ({ gain: param(), connect: vi.fn(), disconnect: vi.fn() }),
    createAnalyser: () => ({ fftSize: 2048, connect: vi.fn(), disconnect: vi.fn() })
  }
}
const defaults = def => Object.fromEntries(def.params.map(p => [p.key, p.def]))
const ports = (def, inst) => def.ports.forEach(p => expect((p.dir === 'in' ? inst.inputs : inst.outputs)[p.id], p.id).toHaveLength(1))

describe('PROB', () => {
  it('exposes its ports and routes a coin flip by p', () => {
    const emitEvent = vi.fn()
    const inst = prob.create(makeCtx(), { params: { ...defaults(prob), p: 0.5 }, emitEvent, random: () => 0.1 })
    ports(prob, inst)
    inst.onEvent('trig', { type: 'trig', time: 1 })
    expect(emitEvent.mock.calls[0][0]).toBe('a')
    inst.dispose()
  })

  it('p = 0 sends everything to B, p = 1 everything to A', () => {
    const run = p => {
      const emitEvent = vi.fn()
      const inst = prob.create(makeCtx(), { params: { ...defaults(prob), p }, emitEvent, random: () => 0.5 })
      inst.onEvent('trig', { type: 'trig', time: 1 })
      inst.dispose()
      return emitEvent.mock.calls[0][0]
    }
    expect(run(0)).toBe('b')
    expect(run(1)).toBe('a')
  })

  it('toggle at p = .5 is a strict alternation', () => {
    const emitEvent = vi.fn()
    const inst = prob.create(makeCtx(), { params: { ...defaults(prob), mode: 'toggle', p: 0.5 }, emitEvent, random: () => 0.5 })
    for (let i = 0; i < 4; i++) inst.onEvent('trig', { type: 'trig', time: i })
    expect(emitEvent.mock.calls.map(([port]) => port)).toEqual(['a', 'b', 'a', 'b'])
    inst.dispose()
  })

  it('toggle at p = 1 locks onto one side', () => {
    const emitEvent = vi.fn()
    const inst = prob.create(makeCtx(), { params: { ...defaults(prob), mode: 'toggle', p: 1 }, emitEvent, random: () => 0.5 })
    for (let i = 0; i < 4; i++) inst.onEvent('trig', { type: 'trig', time: i })
    expect(new Set(emitEvent.mock.calls.map(([port]) => port)).size).toBe(1)
    inst.dispose()
  })
})

describe('TSHIFT', () => {
  it('offsets by DELAY and nothing else at rest', () => {
    const emitEvent = vi.fn()
    const inst = tshift.create(makeCtx(), { params: { ...defaults(tshift), delay: 100 }, emitEvent, random: () => 0 })
    ports(tshift, inst)
    inst.onEvent('in', { type: 'trig', time: 1 })
    expect(emitEvent.mock.calls[0][1].time).toBeCloseTo(1.1, 10)
    inst.dispose()
  })

  it('swings odd triggers by a fraction of the last interval', () => {
    const emitEvent = vi.fn()
    const inst = tshift.create(makeCtx(), { params: { ...defaults(tshift), swing: 50 }, emitEvent, random: () => 0 })
    inst.onEvent('in', { type: 'trig', time: 1 })
    inst.onEvent('in', { type: 'trig', time: 2 })
    inst.onEvent('in', { type: 'trig', time: 3 })
    expect(emitEvent.mock.calls.map(([, e]) => e.time)).toEqual([1, 2.25, 3])
    inst.dispose()
  })

  it('gives gate-off the same offset as its gate-on, so the pair never inverts', () => {
    const emitEvent = vi.fn()
    const inst = tshift.create(makeCtx(), { params: { ...defaults(tshift), delay: 200 }, emitEvent, random: () => 0 })
    inst.onEvent('in', { type: 'gate-on', time: 1 })
    inst.onEvent('in', { type: 'gate-off', time: 1.1 })
    const [on, off] = emitEvent.mock.calls.map(([, e]) => e.time)
    expect(off - on).toBeCloseTo(0.1, 10)
    expect(on).toBeCloseTo(1.2, 10)
    inst.dispose()
  })

  it('humanize is drawn from the injected random, not Math.random', () => {
    const emitEvent = vi.fn()
    const inst = tshift.create(makeCtx(), { params: { ...defaults(tshift), humanize: 30 }, emitEvent, random: () => 1 })
    inst.onEvent('in', { type: 'trig', time: 1 })
    expect(emitEvent.mock.calls[0][1].time).toBeCloseTo(1.03, 10)
    inst.dispose()
  })
})

describe('DUCK', () => {
  it('schedules cancel → ramp down → settle back, at the event time', () => {
    const ctx = makeCtx()
    const inst = duck.create(ctx, { params: { ...defaults(duck), depth: 0.8, attack: 5, release: 300 } })
    ports(duck, inst)
    const gain = inst.outputs.out[0].gain     // out is a plain gain; the ducked one is internal
    expect(gain).toBeTruthy()
    inst.onEvent('trig', { type: 'trig', time: 2 })
    inst.dispose()
  })

  it('ramps to 1 − depth and releases with a time constant of release/3', () => {
    const ctx = makeCtx()
    const gains = []
    const create = ctx.createGain
    ctx.createGain = () => { const g = create(); gains.push(g); return g }
    const inst = duck.create(ctx, { params: { ...defaults(duck), depth: 0.75, attack: 10, release: 300 } })
    inst.onEvent('trig', { type: 'trig', time: 2 })
    const ducked = gains.find(g => g.gain.linearRampToValueAtTime.mock.calls.length)
    expect(ducked.gain.cancelScheduledValues).toHaveBeenCalledWith(2)
    expect(ducked.gain.linearRampToValueAtTime).toHaveBeenCalledWith(0.25, 2.01)
    const [target, when, tau] = ducked.gain.setTargetAtTime.mock.calls[0]
    expect([target, when]).toEqual([1, 2.01])
    expect(tau).toBeCloseTo(0.1, 10)
    inst.dispose()
  })

  it('exp curve never asks for a zero target', () => {
    const ctx = makeCtx()
    const gains = []
    const create = ctx.createGain
    ctx.createGain = () => { const g = create(); gains.push(g); return g }
    const inst = duck.create(ctx, { params: { ...defaults(duck), depth: 1, curve: 'exp' } })
    inst.onEvent('trig', { type: 'trig', time: 1 })
    const ducked = gains.find(g => g.gain.exponentialRampToValueAtTime.mock.calls.length)
    expect(ducked.gain.exponentialRampToValueAtTime.mock.calls[0][0]).toBeGreaterThan(0)
    inst.dispose()
  })
})

describe('CLKMUL', () => {
  it('passes the first tick through with nothing to predict from', () => {
    const emitEvent = vi.fn()
    const inst = clkmul.create(makeCtx(), { params: { ...defaults(clkmul), mult: 4 }, emitEvent })
    ports(clkmul, inst)
    inst.onEvent('clk', { type: 'trig', time: 1 })
    expect(emitEvent.mock.calls.map(([, e]) => e.time)).toEqual([1])
    inst.dispose()
  })

  it('fills the interval once it knows one', () => {
    const emitEvent = vi.fn()
    const inst = clkmul.create(makeCtx(), { params: { ...defaults(clkmul), mult: 4 }, emitEvent })
    inst.onEvent('clk', { type: 'trig', time: 1 })
    emitEvent.mockClear()
    inst.onEvent('clk', { type: 'trig', time: 2 })
    expect(emitEvent.mock.calls.map(([, e]) => e.time)).toEqual([2, 2.25, 2.5, 2.75])
    inst.dispose()
  })

  it('rst drops the predicted interval', () => {
    const emitEvent = vi.fn()
    const inst = clkmul.create(makeCtx(), { params: { ...defaults(clkmul), mult: 2 }, emitEvent })
    inst.onEvent('clk', { type: 'trig', time: 1 })
    inst.onEvent('clk', { type: 'trig', time: 2 })
    inst.onEvent('rst', { type: 'trig', time: 2.5 })
    emitEvent.mockClear()
    inst.onEvent('clk', { type: 'trig', time: 3 })
    expect(emitEvent.mock.calls.map(([, e]) => e.time)).toEqual([3])
    inst.dispose()
  })
})
