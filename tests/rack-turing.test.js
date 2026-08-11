import { describe, it, expect, vi } from 'vitest'
import { turingStep, bitsToCv, REGISTER_BITS } from '../src/renderer/js/rack/turing.js'
import turing from '../src/renderer/js/rack/modules/turing.js'

function makeCtx() {
  const created = []
  const param = () => ({ value: 0, setValueAtTime: vi.fn(), setTargetAtTime: vi.fn(), cancelScheduledValues: vi.fn() })
  const node = (kind, extra = {}) => {
    const n = { kind, connect: vi.fn(), disconnect: vi.fn(function () { n.disconnected++ }), disconnected: 0, ...extra }
    created.push(n)
    return n
  }
  return {
    currentTime: 0,
    created,
    createGain: () => node('gain', { gain: param() }),
    createAnalyser: () => node('analyser', { fftSize: 32, getFloatTimeDomainData: vi.fn() }),
    createConstantSource: () => node('const', {
      offset: param(), started: 0, stopped: 0,
      start: vi.fn(function () { this.started++ }), stop: vi.fn(function () { this.stopped++ })
    })
  }
}

// A random() that walks a scripted list and then repeats the last value.
const scripted = values => { let i = 0; return () => values[Math.min(i++, values.length - 1)] }

const bits = (...head) => Array.from({ length: REGISTER_BITS }, (_, i) => head[i] ?? 0)

describe('turingStep', () => {
  it('lock 1 locks the loop — the bit at `length` wraps back unchanged', () => {
    // length 4, so bits[3] is the one that wraps. random() is irrelevant here.
    let register = bits(1, 0, 1, 1)
    const random = vi.fn(() => 0)
    register = turingStep(register, 4, 1, random)
    expect(register.slice(0, 4)).toEqual([1, 1, 0, 1])
    // Four clocks return the loop to where it started.
    for (let i = 0; i < 3; i++) register = turingStep(register, 4, 1, random)
    expect(register.slice(0, 4)).toEqual([1, 0, 1, 1])
  })

  it('lock 0 locks but inverts the wrapped bit each pass', () => {
    let register = bits(1, 0, 1, 1)
    register = turingStep(register, 4, 0, scripted([0.99]))   // flip prob is 1, any roll flips
    expect(register.slice(0, 4)).toEqual([0, 1, 0, 1])
    // After two full passes of 4 the loop is back — the classic two-length behaviour.
    for (let i = 0; i < 7; i++) register = turingStep(register, 4, 0, scripted([0.99]))
    expect(register.slice(0, 4)).toEqual([1, 0, 1, 1])
  })

  it('lock .5 writes a fresh bit — the roll decides, not the register', () => {
    const register = bits(1, 0, 1, 1)
    // wrapped bit is 1; a roll below .5 flips it to 0, a roll above keeps it.
    expect(turingStep(register, 4, 0.5, scripted([0.2]))[0]).toBe(0)
    expect(turingStep(register, 4, 0.5, scripted([0.8]))[0]).toBe(1)
  })

  it('carries bits beyond `length` untouched so shortening the loop is reversible', () => {
    const register = bits(1, 1, 0, 0, 1, 0, 1, 1)
    const next = turingStep(register, 2, 1, () => 0.9)
    expect(next.slice(2, 8)).toEqual([1, 0, 0, 1, 0, 1])
    expect(next).toHaveLength(REGISTER_BITS)
  })
})

describe('bitsToCv', () => {
  it('weights the top eight bits as a DAC', () => {
    expect(bitsToCv(bits(), 1, false)).toBe(0)
    expect(bitsToCv(bits(1, 1, 1, 1, 1, 1, 1, 1), 1, false)).toBe(1)
    expect(bitsToCv(bits(1), 1, false)).toBeCloseTo(128 / 255, 6)
    expect(bitsToCv(bits(0, 0, 0, 0, 0, 0, 0, 1), 1, false)).toBeCloseTo(1 / 255, 6)
  })

  it('range scales and bipolar centres', () => {
    expect(bitsToCv(bits(1, 1, 1, 1, 1, 1, 1, 1), 0.5, false)).toBeCloseTo(0.5, 6)
    expect(bitsToCv(bits(), 1, true)).toBe(-1)
    expect(bitsToCv(bits(1, 1, 1, 1, 1, 1, 1, 1), 1, true)).toBe(1)
  })

  it('the second tap reads only two bits', () => {
    expect(bitsToCv(bits(1, 1), 1, false, 2)).toBe(1)
    expect(bitsToCv(bits(0, 1), 1, false, 2)).toBeCloseTo(1 / 3, 6)
  })
})

describe('TURING module', () => {
  it('clocks the register and schedules both CV taps at the event time', () => {
    const ctx = makeCtx()
    const inst = turing.create(ctx, { params: { length: 4, lock: 1, range: 1, bipolar: 'off' }, random: () => 0.9 })
    const before = inst.uiBits()

    inst.onEvent('clk', { type: 'trig', time: 2 })

    expect(inst.uiBits()[0]).toBe(before[3])
    const sources = ctx.created.filter(n => n.kind === 'const')
    expect(sources).toHaveLength(2)
    for (const src of sources) expect(src.offset.setValueAtTime).toHaveBeenCalledWith(expect.any(Number), 2)
    inst.dispose()
  })

  it('emits PULSE only when the new head bit is 1, carrying the CV for QUANT', () => {
    const ctx = makeCtx()
    const emitEvent = vi.fn()
    // random seeds the register with all 1s, then lock 1 keeps them.
    const inst = turing.create(ctx, { params: { length: 4, lock: 1, range: 1, bipolar: 'off' }, emitEvent, random: () => 0.1 })
    inst.onEvent('clk', { type: 'trig', time: 1 })
    expect(emitEvent).toHaveBeenCalledWith('pulse', expect.objectContaining({ type: 'trig', time: 1, cv: 1 }))

    // A locked register of all zeros never pulses.
    const quiet = turing.create(makeCtx(), { params: { length: 4, lock: 1, range: 1, bipolar: 'off' }, emitEvent: emitEvent.mockClear(), random: () => 0.9 })
    quiet.onEvent('clk', { type: 'trig', time: 1 })
    expect(emitEvent).not.toHaveBeenCalled()
    inst.dispose()
    quiet.dispose()
  })

  it('WRITE punches one coin-flip bit through a locked knob', () => {
    // Seed: bits[3] is the only 1, so a locked clock must wrap a 1 to the head.
    const seed = [0.9, 0.9, 0.9, 0.1, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9]
    const params = { length: 4, lock: 1, range: 1, bipolar: 'off' }

    const locked = turing.create(makeCtx(), { params: { ...params }, random: scripted([...seed, 0.2]) })
    locked.onEvent('clk', { type: 'trig', time: 2 })
    expect(locked.uiBits()[0]).toBe(1)

    const written = turing.create(makeCtx(), { params: { ...params }, random: scripted([...seed, 0.2]) })
    written.onEvent('write', { type: 'trig', time: 1 })
    written.onEvent('clk', { type: 'trig', time: 2 })
    expect(written.uiBits()[0]).toBe(0)   // the same roll now flips, because WRITE forced lock to centre

    locked.dispose()
    written.dispose()
  })

  it('ignores gate-off and unknown ports', () => {
    const ctx = makeCtx()
    const inst = turing.create(ctx, { params: { length: 8, lock: 1, range: 1, bipolar: 'off' }, random: () => 0.5 })
    const before = inst.uiBits()
    inst.onEvent('clk', { type: 'gate-off', time: 1 })
    inst.onEvent('lock', { type: 'trig', time: 1 })
    expect(inst.uiBits()).toEqual(before)
    inst.dispose()
  })

  it('dispose stops every source, drops the poll job and disconnects', () => {
    const ctx = makeCtx()
    const jobs = new Set()
    const poll = { add: job => { jobs.add(job); return () => jobs.delete(job) } }
    const inst = turing.create(ctx, { params: { length: 8, lock: 0.5, range: 1, bipolar: 'off' }, poll, random: () => 0.5 })
    expect(jobs.size).toBe(1)
    inst.dispose()
    expect(jobs.size).toBe(0)
    for (const node of ctx.created) {
      expect(node.disconnected).toBeGreaterThan(0)
      if (node.kind === 'const') expect(node.stopped).toBe(1)
    }
  })
})
