import { describe, it, expect, vi } from 'vitest'
import grid16, { cellIndex, readCell, nextStep, makeCell, LANES, STEPS, CELLS } from '../src/renderer/js/rack/modules/grid16.js'

function makeCtx(clock = { now: 0 }) {
  const node = () => ({ connect: vi.fn(), disconnect: vi.fn() })
  return { get currentTime() { return clock.now }, createGain: node }
}

const defaults = () => Object.fromEntries(grid16.params.map(p => [p.key, structuredClone(p.def)]))
const blank = () => Array.from({ length: CELLS }, () => makeCell())
const outsOf = emitEvent => emitEvent.mock.calls.filter(([port]) => /^out\d$/.test(port))

describe('cellIndex', () => {
  it('flattens lane/step lane-major', () => {
    expect(cellIndex(0, 0)).toBe(0)
    expect(cellIndex(1, 3)).toBe(19)
    expect(cellIndex(LANES - 1, STEPS - 1)).toBe(CELLS - 1)
  })

  it('returns -1 out of range rather than wrapping into another lane', () => {
    expect(cellIndex(LANES, 0)).toBe(-1)
    expect(cellIndex(0, STEPS)).toBe(-1)
    expect(cellIndex(-1, 0)).toBe(-1)
  })
})

describe('readCell', () => {
  it('fills in missing attributes so the sequencer never sees undefined', () => {
    expect(readCell([], 0, 0)).toEqual({ on: false, vel: 1, prob: 1, ratchet: 1 })
    expect(readCell([{ on: true }], 0, 0)).toEqual({ on: true, vel: 1, prob: 1, ratchet: 1 })
    expect(readCell(null, 0, 0).on).toBe(false)
  })

  it('accepts a bare boolean from a hand-written preset', () => {
    const pattern = blank()
    pattern[cellIndex(0, 2)] = true
    expect(readCell(pattern, 0, 2)).toEqual({ on: true, vel: 1, prob: 1, ratchet: 1 })
  })
})

describe('nextStep', () => {
  const random = () => 0
  it('fwd wraps at LENGTH, not at 16', () => {
    expect(nextStep(2, 4, 'fwd', true, random)).toEqual({ step: 3, forward: true, wrapped: false })
    expect(nextStep(3, 4, 'fwd', true, random)).toEqual({ step: 0, forward: true, wrapped: true })
  })

  it('rev counts down and wraps at the top', () => {
    expect(nextStep(2, 4, 'rev', true, random).step).toBe(1)
    expect(nextStep(0, 4, 'rev', true, random)).toEqual({ step: 3, forward: true, wrapped: true })
  })

  it('pend turns around at both ends without repeating them', () => {
    const walk = []
    let state = { step: 0, forward: true }
    for (let i = 0; i < 6; i++) { state = nextStep(state.step, 4, 'pend', state.forward, random); walk.push(state.step) }
    expect(walk).toEqual([1, 2, 3, 2, 1, 0])
  })

  it('rand stays inside LENGTH', () => {
    expect(nextStep(0, 4, 'rand', true, () => 0.99).step).toBe(3)
    expect(nextStep(0, 4, 'rand', true, () => 0).step).toBe(0)
  })
})

describe('GRID16 module', () => {
  it('exposes every declared port as one mono channel', () => {
    const inst = grid16.create(makeCtx(), { params: defaults() })
    for (const port of grid16.ports) {
      const bag = port.dir === 'in' ? inst.inputs : inst.outputs
      expect(bag[port.id], port.id).toHaveLength(1)
    }
    inst.dispose()
  })

  it('fires only the lanes whose cell is on', () => {
    const emitEvent = vi.fn()
    const pattern = blank()
    pattern[cellIndex(0, 0)].on = true
    pattern[cellIndex(2, 0)].on = true
    const inst = grid16.create(makeCtx(), { params: { ...defaults(), pattern }, emitEvent, random: () => 0 })
    inst.onEvent('clk', { type: 'trig', time: 1 })
    expect(outsOf(emitEvent).map(([port]) => port)).toEqual(['out1', 'out3'])
    inst.dispose()
  })

  it('probability gates a cell, deterministically under a scripted random', () => {
    const pattern = blank()
    pattern[cellIndex(0, 0)] = { on: true, vel: 1, prob: 0.5, ratchet: 1 }
    const run = roll => {
      const emitEvent = vi.fn()
      const inst = grid16.create(makeCtx(), { params: { ...defaults(), pattern }, emitEvent, random: () => roll })
      inst.onEvent('clk', { type: 'trig', time: 1 })
      inst.dispose()
      return outsOf(emitEvent).length
    }
    expect(run(0.2)).toBe(1)
    expect(run(0.9)).toBe(0)
  })

  it('a ratchet spreads its repeats across the clock interval', () => {
    const emitEvent = vi.fn()
    const pattern = blank()
    pattern[cellIndex(0, 2)] = { on: true, vel: 1, prob: 1, ratchet: 4 }
    const inst = grid16.create(makeCtx(), { params: { ...defaults(), pattern }, emitEvent, random: () => 0 })
    inst.onEvent('clk', { type: 'trig', time: 1 })     // step 0
    inst.onEvent('clk', { type: 'trig', time: 2 })     // step 1, interval now 1s
    emitEvent.mockClear()
    inst.onEvent('clk', { type: 'trig', time: 3 })     // step 2 — the ratchet
    expect(outsOf(emitEvent).map(([, e]) => e.time)).toEqual([3, 3.25, 3.5, 3.75])
    inst.dispose()
  })

  it('velocity rides the event, and ACC fires past the threshold', () => {
    const emitEvent = vi.fn()
    const pattern = blank()
    pattern[cellIndex(0, 0)] = { on: true, vel: 0.9, prob: 1, ratchet: 1 }
    const inst = grid16.create(makeCtx(), { params: { ...defaults(), pattern, accentThresh: 0.8 }, emitEvent, random: () => 0 })
    inst.onEvent('clk', { type: 'trig', time: 1 })
    expect(outsOf(emitEvent)[0][1].velocity).toBe(0.9)
    expect(emitEvent.mock.calls.some(([port]) => port === 'acc')).toBe(true)
    inst.dispose()
  })

  it('swing pushes odd steps late by half the last interval', () => {
    const emitEvent = vi.fn()
    const pattern = Array.from({ length: CELLS }, () => makeCell(true))
    const inst = grid16.create(makeCtx(), { params: { ...defaults(), pattern, swing: 0.5 }, emitEvent, random: () => 0 })
    inst.onEvent('clk', { type: 'trig', time: 1 })
    inst.onEvent('clk', { type: 'trig', time: 2 })
    inst.onEvent('clk', { type: 'trig', time: 3 })
    const times = outsOf(emitEvent).map(([, e]) => e.time)
    expect(times).toContain(1)          // step 0, on the grid
    expect(times).toContain(2.25)       // step 1, late by .5 × 1s × .5
    expect(times).toContain(3)          // step 2, back on the grid
    inst.dispose()
  })

  it('LENGTH shortens the loop and EOC marks the wrap', () => {
    const emitEvent = vi.fn()
    const pattern = blank()
    pattern[cellIndex(0, 0)].on = true
    const inst = grid16.create(makeCtx(), { params: { ...defaults(), pattern, length: 4 }, emitEvent, random: () => 0 })
    for (let i = 0; i < 5; i++) inst.onEvent('clk', { type: 'trig', time: i })
    expect(outsOf(emitEvent)).toHaveLength(2)     // step 0 played twice in five clocks
    expect(emitEvent.mock.calls.filter(([port]) => port === 'eoc')).toHaveLength(1)
    inst.dispose()
  })

  it('rst returns to the top of the pattern', () => {
    const emitEvent = vi.fn()
    const pattern = blank()
    pattern[cellIndex(3, 0)].on = true
    const inst = grid16.create(makeCtx(), { params: { ...defaults(), pattern }, emitEvent, random: () => 0 })
    for (let i = 0; i < 5; i++) inst.onEvent('clk', { type: 'trig', time: i })
    inst.onEvent('rst', { type: 'trig', time: 5 })
    emitEvent.mockClear()
    inst.onEvent('clk', { type: 'trig', time: 6 })
    expect(outsOf(emitEvent).map(([port]) => port)).toEqual(['out4'])
    inst.dispose()
  })

  it('the playhead reports the slot the context has reached, not the one scheduled', () => {
    const clock = { now: 0 }
    const inst = grid16.create(makeCtx(clock), { params: defaults(), random: () => 0 })
    expect(inst.uiStep()).toBe(-1)
    inst.onEvent('clk', { type: 'trig', time: 1 })
    inst.onEvent('clk', { type: 'trig', time: 2 })
    expect(inst.uiStep()).toBe(-1)      // both still in the future
    clock.now = 1.5
    expect(inst.uiStep()).toBe(0)
    clock.now = 2.5
    expect(inst.uiStep()).toBe(1)
    inst.dispose()
  })
})
