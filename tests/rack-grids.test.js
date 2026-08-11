import { describe, it, expect, vi } from 'vitest'
import { gridsLevel, gridsHit, NODES, CHANNELS, STEPS, GRID } from '../src/renderer/js/rack/grids.js'
import grids from '../src/renderer/js/rack/modules/grids.js'

function makeCtx() {
  const node = () => ({ connect: vi.fn(), disconnect: vi.fn() })
  return {
    currentTime: 0,
    createGain: node,
    createAnalyser: () => ({ fftSize: 2048, connect: vi.fn(), disconnect: vi.fn() })
  }
}

const defaults = () => Object.fromEntries(grids.params.map(p => [p.key, p.def]))

describe('grids pattern map', () => {
  it('holds nine nodes of three 32-step channels', () => {
    expect(NODES).toHaveLength(GRID * GRID)
    for (const node of NODES) {
      for (const ch of CHANNELS) {
        expect(node[ch]).toBeInstanceOf(Uint8Array)
        expect(node[ch]).toHaveLength(STEPS)
      }
    }
  })

  it('reads a corner node verbatim', () => {
    for (let step = 0; step < STEPS; step++) {
      expect(gridsLevel(0, 0, 'bd', step)).toBe(NODES[0].bd[step])
      expect(gridsLevel(1, 0, 'hh', step)).toBe(NODES[2].hh[step])
      expect(gridsLevel(0, 1, 'sd', step)).toBe(NODES[6].sd[step])
      expect(gridsLevel(1, 1, 'bd', step)).toBe(NODES[8].bd[step])
    }
  })

  it('blends the four surrounding nodes bilinearly at the centre', () => {
    const step = 0
    const mid = gridsLevel(0.5, 0.5, 'bd', step)
    const corners = [NODES[0].bd[step], NODES[1].bd[step], NODES[3].bd[step], NODES[4].bd[step]]
    expect(mid).toBeCloseTo(corners.reduce((a, b) => a + b, 0) / 4, 6)
  })

  it('is monotone along X between two nodes', () => {
    // Halfway along the top edge is the mean of the two nodes it sits between.
    const step = 2
    const half = gridsLevel(0.25, 0, 'hh', step)
    expect(half).toBeCloseTo((NODES[0].hh[step] + NODES[1].hh[step]) / 2, 6)
  })

  it('takes a channel index as well as a name, and wraps the step', () => {
    expect(gridsLevel(0, 0, 0, 0)).toBe(gridsLevel(0, 0, 'bd', 0))
    expect(gridsLevel(0, 0, 'bd', STEPS + 3)).toBe(gridsLevel(0, 0, 'bd', 3))
    expect(gridsLevel(0, 0, 'bd', -1)).toBe(gridsLevel(0, 0, 'bd', STEPS - 1))
  })

  it('clamps out-of-range coordinates instead of reading off the table', () => {
    expect(gridsLevel(2, 2, 'bd', 0)).toBe(gridsLevel(1, 1, 'bd', 0))
    expect(gridsLevel(-1, -1, 'bd', 0)).toBe(gridsLevel(0, 0, 'bd', 0))
    expect(gridsLevel(0, 0, 'nope', 0)).toBe(0)
  })

  it('every corner sounds different at the same step', () => {
    const at = (x, y) => Array.from({ length: STEPS }, (_, s) => gridsLevel(x, y, 'hh', s)).join()
    const corners = new Set([at(0, 0), at(1, 0), at(0, 1), at(1, 1)])
    expect(corners.size).toBe(4)
  })
})

describe('gridsHit', () => {
  it('is a density threshold: full density fires anything non-zero', () => {
    expect(gridsHit(1, 1)).toBe(true)
    expect(gridsHit(0, 1)).toBe(false)
    expect(gridsHit(255, 0)).toBe(false)
    expect(gridsHit(200, 0.5)).toBe(true)
    expect(gridsHit(100, 0.5)).toBe(false)
  })

  it('chaos only ever adds hits', () => {
    expect(gridsHit(100, 0.5, 0, 1)).toBe(false)
    expect(gridsHit(100, 0.5, 1, 1)).toBe(true)
    expect(gridsHit(100, 0.5, 1, 0)).toBe(false)
  })
})

describe('GRIDS module', () => {
  it('exposes every declared port as one mono channel', () => {
    const inst = grids.create(makeCtx(), { params: defaults() })
    for (const port of grids.ports) {
      const bag = port.dir === 'in' ? inst.inputs : inst.outputs
      expect(bag[port.id], port.id).toHaveLength(1)
    }
    inst.dispose()
  })

  it('a clock at full density fires every channel that has a level', () => {
    const emitEvent = vi.fn()
    const params = { ...defaults(), x: 0, y: 0, dBd: 1, dSd: 1, dHh: 1 }
    const inst = grids.create(makeCtx(), { params, emitEvent, random: () => 0 })
    inst.onEvent('clk', { type: 'trig', time: 1 })
    const ports = emitEvent.mock.calls.map(([port]) => port)
    // Step 0 of the x0y0 node is a kick and a hat, no snare.
    expect(ports).toContain('bd')
    expect(ports).toContain('hh')
    expect(ports).not.toContain('sd')
    inst.dispose()
  })

  it('zero density is silent whatever the pattern says', () => {
    const emitEvent = vi.fn()
    const params = { ...defaults(), dBd: 0, dSd: 0, dHh: 0, chaos: 0 }
    const inst = grids.create(makeCtx(), { params, emitEvent, random: () => 0 })
    for (let i = 0; i < STEPS; i++) inst.onEvent('clk', { type: 'trig', time: i })
    expect(emitEvent).not.toHaveBeenCalled()
    inst.dispose()
  })

  it('is deterministic under a scripted random, and moving X changes the beat', () => {
    const run = x => {
      const emitEvent = vi.fn()
      let n = 0
      const inst = grids.create(makeCtx(), {
        params: { ...defaults(), x, y: 0, chaos: 0.5 },
        emitEvent,
        random: () => ((n = (n * 31 + 7) % 97), n / 97)
      })
      for (let i = 0; i < STEPS; i++) inst.onEvent('clk', { type: 'trig', time: i })
      inst.dispose()
      return emitEvent.mock.calls.map(([port, e]) => `${port}@${e.time}`).join(' ')
    }
    expect(run(0)).toBe(run(0))
    expect(run(0)).not.toBe(run(1))
  })

  it('emits the accent jack only when a hit clears the threshold', () => {
    const emitEvent = vi.fn()
    const params = { ...defaults(), x: 0, y: 0, dBd: 1, dSd: 1, dHh: 1, accentThresh: 1 }
    const inst = grids.create(makeCtx(), { params, emitEvent, random: () => 0 })
    inst.onEvent('clk', { type: 'trig', time: 1 })      // step 0: a 255-level kick
    expect(emitEvent.mock.calls.some(([port]) => port === 'acc')).toBe(true)
    emitEvent.mockClear()
    inst.onEvent('clk', { type: 'trig', time: 2 })      // step 1: nothing at all
    expect(emitEvent.mock.calls.some(([port]) => port === 'acc')).toBe(false)
    inst.dispose()
  })

  it('swing pushes odd steps late by half the last interval', () => {
    const emitEvent = vi.fn()
    // The busy top-right node has something on every sixteenth, odd ones included.
    const params = { ...defaults(), x: 1, y: 0, dHh: 1, dBd: 1, dSd: 1, swing: 0.5 }
    const inst = grids.create(makeCtx(), { params, emitEvent, random: () => 0 })
    inst.onEvent('clk', { type: 'trig', time: 1 })
    inst.onEvent('clk', { type: 'trig', time: 2 })
    inst.onEvent('clk', { type: 'trig', time: 3 })
    const times = emitEvent.mock.calls.map(([, e]) => e.time)
    expect(times).toContain(1)          // step 0, on the grid
    expect(times).toContain(2.25)       // step 1, late by .5 × 1s × .5
    inst.dispose()
  })

  it('rst puts the next clock back on step 0', () => {
    const emitEvent = vi.fn()
    const params = { ...defaults(), x: 0, y: 0, dBd: 1 }
    const inst = grids.create(makeCtx(), { params, emitEvent, random: () => 0 })
    for (let i = 0; i < 5; i++) inst.onEvent('clk', { type: 'trig', time: i })
    inst.onEvent('rst', { type: 'trig', time: 5 })
    expect(inst.uiStep()).toBe(-1)
    emitEvent.mockClear()
    inst.onEvent('clk', { type: 'trig', time: 6 })
    expect(inst.uiStep()).toBe(0)
    expect(emitEvent.mock.calls.some(([port]) => port === 'bd')).toBe(true)
    inst.dispose()
  })

  it('unregisters its poll job on dispose', () => {
    const remove = vi.fn()
    const poll = { add: vi.fn(() => remove) }
    const inst = grids.create(makeCtx(), { params: defaults(), poll })
    expect(poll.add).toHaveBeenCalled()
    inst.dispose()
    expect(remove).toHaveBeenCalled()
  })
})
