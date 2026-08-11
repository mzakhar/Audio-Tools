import { describe, it, expect, vi } from 'vitest'
import { burstTimes } from '../src/renderer/js/rack/burst.js'
import burst from '../src/renderer/js/rack/modules/burst.js'

function makeCtx() {
  const node = () => ({ connect: vi.fn(), disconnect: vi.fn() })
  return {
    currentTime: 0,
    createGain: node,
    createAnalyser: () => ({ fftSize: 2048, connect: vi.fn(), disconnect: vi.fn() })
  }
}

const defaults = () => Object.fromEntries(burst.params.map(p => [p.key, p.def]))
const gaps = times => times.slice(1).map((t, i) => t - times[i])

describe('burstTimes', () => {
  it('is even at curve 0', () => {
    for (const gap of gaps(burstTimes(0, 4, 0.1, 0))) expect(gap).toBeCloseTo(0.1, 10)
    for (const gap of gaps(burstTimes(1, 8, 0.05, 0))) expect(gap).toBeCloseTo(0.05, 10)
  })

  it('starts at t0 and spans (count-1)·spacing whatever the curve is', () => {
    for (const curve of [-1, -0.5, 0, 0.5, 1]) {
      const times = burstTimes(2, 6, 0.08, curve)
      expect(times[0]).toBeCloseTo(2, 10)
      expect(times[times.length - 1]).toBeCloseTo(2 + 5 * 0.08, 10)
    }
  })

  it('is monotonically increasing for every curve', () => {
    for (const curve of [-1, -0.3, 0, 0.3, 1]) {
      for (const gap of gaps(burstTimes(0, 12, 0.05, curve))) expect(gap).toBeGreaterThan(0)
    }
  })

  it('curve > 0 compresses: each gap is shorter than the last', () => {
    const g = gaps(burstTimes(0, 8, 0.05, 0.8))
    for (let i = 1; i < g.length; i++) expect(g[i]).toBeLessThan(g[i - 1])
  })

  it('curve < 0 decelerates: each gap is longer than the last', () => {
    const g = gaps(burstTimes(0, 8, 0.05, -0.8))
    for (let i = 1; i < g.length; i++) expect(g[i]).toBeGreaterThan(g[i - 1])
  })

  it('a count of one is just the trigger itself', () => {
    expect(burstTimes(3, 1, 0.1, 0.5)).toEqual([3])
    expect(burstTimes(3, 0, 0.1, 0)).toEqual([3])
  })

  it('clamps the curve rather than exploding past ±1', () => {
    expect(burstTimes(0, 4, 0.1, 9)).toEqual(burstTimes(0, 4, 0.1, 1))
  })
})

describe('BURST module', () => {
  it('exposes every declared port as one mono channel', () => {
    const inst = burst.create(makeCtx(), { params: defaults() })
    for (const port of burst.ports) {
      const bag = port.dir === 'in' ? inst.inputs : inst.outputs
      expect(bag[port.id], port.id).toHaveLength(1)
    }
    inst.dispose()
  })

  it('one trigger in, COUNT triggers out, ending with EOB', () => {
    const emitEvent = vi.fn()
    const inst = burst.create(makeCtx(), { params: { ...defaults(), count: 4, spacing: 100 }, emitEvent, random: () => 0 })
    inst.onEvent('trig', { type: 'trig', time: 1 })
    const outs = emitEvent.mock.calls.filter(([port]) => port === 'out').map(([, e]) => e.time)
    expect(outs).toHaveLength(4)
    outs.forEach((t, i) => expect(t).toBeCloseTo(1 + i * 0.1, 10))
    const eob = emitEvent.mock.calls.find(([port]) => port === 'eob')
    expect(eob[1].time).toBeCloseTo(1.3, 10)
    inst.dispose()
  })

  it('PROB thins the repeats but never swallows the first hit', () => {
    const emitEvent = vi.fn()
    const inst = burst.create(makeCtx(), { params: { ...defaults(), count: 8, prob: 0 }, emitEvent, random: () => 0.99 })
    inst.onEvent('trig', { type: 'trig', time: 1 })
    expect(emitEvent.mock.calls.filter(([port]) => port === 'out')).toHaveLength(1)
    inst.dispose()
  })

  it('ignores gate-off and anything on another port', () => {
    const emitEvent = vi.fn()
    const inst = burst.create(makeCtx(), { params: defaults(), emitEvent, random: () => 0 })
    inst.onEvent('trig', { type: 'gate-off', time: 1 })
    inst.onEvent('cnt', { type: 'trig', time: 1 })
    expect(emitEvent).not.toHaveBeenCalled()
    inst.dispose()
  })

  it('unregisters its poll job on dispose', () => {
    const remove = vi.fn()
    const poll = { add: vi.fn(() => remove) }
    const inst = burst.create(makeCtx(), { params: defaults(), poll })
    inst.dispose()
    expect(remove).toHaveBeenCalled()
  })
})
