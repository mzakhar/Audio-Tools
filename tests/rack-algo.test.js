import { describe, it, expect, vi } from 'vitest'
import algo, { cellIndex, CELLS, LANES, STEPS } from '../src/renderer/js/rack/modules/algo.js'
import { paramDefaults } from '../src/renderer/js/rack/modules/index.js'

function makeCtx() {
  const node = () => ({ connect: vi.fn(), disconnect: vi.fn() })
  return { currentTime: 0, createGain: node }
}

describe('cellIndex', () => {
  it('flattens lane/step into the 64-cell buffer, lane-major', () => {
    expect(cellIndex(0, 0)).toBe(0)
    expect(cellIndex(3, 5)).toBe(29)
    expect(cellIndex(LANES - 1, STEPS - 1)).toBe(CELLS - 1)
  })

  it('returns -1 out of range rather than wrapping into another lane', () => {
    expect(cellIndex(LANES, 0)).toBe(-1)
    expect(cellIndex(0, STEPS)).toBe(-1)
    expect(cellIndex(-1, 0)).toBe(-1)
    expect(cellIndex(0, -1)).toBe(-1)
  })
})

describe('ALGO module', () => {
  it('emits on the lanes whose cells are set and no others', () => {
    const ctx = makeCtx()
    const emitEvent = vi.fn()
    const pattern = Array.from({ length: CELLS }, () => false)
    pattern[cellIndex(0, 0)] = true
    pattern[cellIndex(2, 0)] = true
    const inst = algo.create(ctx, { params: { ...paramDefaults('algo'), pattern }, emitEvent })

    inst.onEvent('clk', { type: 'gate-on', time: 1 })

    expect(emitEvent).toHaveBeenCalledWith('out1', { type: 'trig', time: 1 })
    expect(emitEvent).toHaveBeenCalledWith('out3', { type: 'trig', time: 1 })
    expect(emitEvent.mock.calls.filter(([port]) => port === 'out2')).toHaveLength(0)
    inst.dispose()
  })

  it('every lane drives its own output jack', () => {
    const ctx = makeCtx()
    const emitEvent = vi.fn()
    // one cell per lane, all on step 0 — one clock should hit all eight jacks
    const pattern = Array.from({ length: CELLS }, () => false)
    for (let lane = 0; lane < LANES; lane++) pattern[cellIndex(lane, 0)] = true
    const inst = algo.create(ctx, { params: { ...paramDefaults('algo'), pattern }, emitEvent })

    inst.onEvent('clk', { type: 'gate-on', time: 1 })

    const ports = emitEvent.mock.calls.map(([port]) => port).filter(p => p.startsWith('out'))
    expect(ports).toEqual(Array.from({ length: LANES }, (_, i) => `out${i + 1}`))
    inst.dispose()
  })

  it('gate mode emits a gate pair, trig mode a single pulse', () => {
    const ctx = makeCtx()
    const emitEvent = vi.fn()
    const pattern = Array.from({ length: CELLS }, () => false)
    pattern[cellIndex(0, 0)] = true
    const inst = algo.create(ctx, { params: { ...paramDefaults('algo'), pattern, gate: 'gate' }, emitEvent })

    inst.onEvent('clk', { type: 'gate-on', time: 1, pulseWidth: 0.25 })

    expect(emitEvent).toHaveBeenCalledWith('out1', { type: 'gate-on', time: 1 })
    expect(emitEvent).toHaveBeenCalledWith('out1', { type: 'gate-off', time: 1.25 })
    inst.dispose()
  })

  it('one-shot stops after the final step; rst restarts it', () => {
    const ctx = makeCtx()
    const emitEvent = vi.fn()
    const params = { ...paramDefaults('algo'), mode: 'one-shot', pattern: Array.from({ length: CELLS }, () => true) }
    const inst = algo.create(ctx, { params, emitEvent })

    for (let i = 0; i < STEPS; i++) inst.onEvent('clk', { type: 'gate-on', time: i })
    expect(emitEvent).toHaveBeenCalledWith('eoc', { type: 'trig', time: STEPS - 1 })
    emitEvent.mockClear()
    inst.onEvent('clk', { type: 'gate-on', time: 100 })
    expect(emitEvent).not.toHaveBeenCalled()

    inst.onEvent('rst', { type: 'gate-on', time: 101 })
    inst.onEvent('clk', { type: 'gate-on', time: 102 })
    expect(emitEvent).toHaveBeenCalledWith('out1', { type: 'trig', time: 102 })
    inst.dispose()
  })
})
