import { describe, it, expect, vi } from 'vitest'
import {
  dejaVuValue, resizeLoop, gateWeights, gateDistribution, gatePattern,
  xVoltage, xValue, MAX_LOOP, X_RANGE
} from '../src/renderer/js/rack/marble.js'
import marble from '../src/renderer/js/rack/modules/marble.js'

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

// Clock a loop `n` times through dejaVuValue, collecting the values it hands out.
function runLoop(length, amount, random, n) {
  let history = resizeLoop([], length)
  const seen = []
  for (let i = 0; i < n; i++) {
    const out = dejaVuValue(history, i, amount, random)
    history = out.history
    seen.push(out.value)
  }
  return { seen, history }
}

describe('dejaVuValue', () => {
  it('amount 0 always draws a new value, whatever the decision roll says', () => {
    // Two draws per call: decision, then candidate. Decision is pinned at 0 —
    // the roll that would reuse anything — so only `amount` can be the reason
    // a fresh value comes back.
    const random = scripted([0, 0.1, 0, 0.2, 0, 0.3, 0, 0.4, 0, 0.5, 0, 0.6, 0, 0.7, 0, 0.8])
    const { seen } = runLoop(4, 0, random, 8)
    expect(seen).toEqual([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8])
    // Nothing repeated, so a loop of 4 did not repeat on its second pass.
    expect(seen.slice(0, 4)).not.toEqual(seen.slice(4))
  })

  it('amount 1 locks the loop — the second pass repeats the first verbatim', () => {
    // Fresh candidates keep changing; only the stored values may come back.
    const random = scripted([0.9, 0.1, 0.9, 0.2, 0.9, 0.3, 0.9, 0.4, 0.9, 0.55, 0.9, 0.65, 0.9, 0.75, 0.9, 0.85])
    const { seen, history } = runLoop(4, 1, random, 8)
    expect(seen.slice(0, 4)).toEqual([0.1, 0.2, 0.3, 0.4])
    expect(seen.slice(4)).toEqual([0.1, 0.2, 0.3, 0.4])
    expect(history).toEqual([0.1, 0.2, 0.3, 0.4])
  })

  it('amount .5 loops but substitutes — the roll decides slot by slot', () => {
    // Pass one fills the loop. Pass two: rolls .2 (< .5, keep) on slots 0 and 2,
    // rolls .8 (>= .5, replace) on slots 1 and 3.
    const fill = [0.9, 0.1, 0.9, 0.2, 0.9, 0.3, 0.9, 0.4]
    const again = [0.2, 0.11, 0.8, 0.22, 0.2, 0.33, 0.8, 0.44]
    const { seen, history } = runLoop(4, 0.5, scripted([...fill, ...again]), 8)
    expect(seen.slice(0, 4)).toEqual([0.1, 0.2, 0.3, 0.4])
    expect(seen.slice(4)).toEqual([0.1, 0.22, 0.3, 0.44])
    // The substitutions were written back, so the loop carries them forward.
    expect(history).toEqual([0.1, 0.22, 0.3, 0.44])
  })

  it('consumes two draws per call whatever the amount, so a seed stays aligned', () => {
    const count = amount => { const random = vi.fn(() => 0.5); runLoop(4, amount, random, 6); return random.mock.calls.length }
    expect(count(0)).toBe(12)
    expect(count(0.5)).toBe(12)
    expect(count(1)).toBe(12)
  })

  it('does not mutate the history it was handed, and wraps the index', () => {
    const history = [0.1, 0.2, 0.3, 0.4]
    const out = dejaVuValue(history, 5, 1, () => 0.9)
    expect(history).toEqual([0.1, 0.2, 0.3, 0.4])
    expect(out.value).toBe(0.2)          // index 5 wraps to slot 1
    expect(out.history).not.toBe(history)
  })
})

describe('resizeLoop', () => {
  it('clamps to 1..MAX_LOOP and keeps the values that survive', () => {
    expect(resizeLoop([0.1, 0.2, 0.3], 2)).toEqual([0.1, 0.2])
    expect(resizeLoop([0.1], 0).length).toBe(1)
    expect(resizeLoop([], 99).length).toBe(MAX_LOOP)
  })

  it('grown slots are holes, so they draw fresh on their first pass', () => {
    const grown = resizeLoop([0.1], 3)
    expect(grown.length).toBe(3)
    expect(dejaVuValue(grown, 2, 1, scripted([0.9, 0.42])).value).toBe(0.42)
  })
})

describe('gates', () => {
  it('bias slides the weight from T1 to T3', () => {
    const [lo1, , lo3] = gateWeights(0, 0)
    expect(lo1).toBeGreaterThan(lo3)
    const [hi1, , hi3] = gateWeights(1, 0)
    expect(hi3).toBeGreaterThan(hi1)
    const even = gateWeights(0.5, 1)
    expect(even[0]).toBeCloseTo(even[2], 6)
  })

  it('jitter widens the tents until all three are equally likely', () => {
    const sharp = gateWeights(0.5, 0)
    const wide = gateWeights(0.5, 1)
    expect(wide[0]).toBeGreaterThan(sharp[0])
    expect(wide[1]).toBe(1)
  })

  it('gateDistribution draws once per output, hit or not', () => {
    const random = vi.fn(() => 0.99)
    expect(gateDistribution(0.5, 0, random)).toEqual([false, true, false])
    expect(random).toHaveBeenCalledTimes(3)
  })

  it('divmult clocks T2 straight through, divides T1 and ratchets T3', () => {
    const at = step => gatePattern('divmult', step, 0, 0, () => 0.5)
    expect(at(0)).toMatchObject({ t1: true, t2: true, t3: true, ratchet: true })
    expect(at(1).t1).toBe(false)
    expect(at(2).t1).toBe(true)          // bias 0 → divide by 2
    expect(gatePattern('divmult', 2, 1, 0, () => 0.5).t1).toBe(false)  // bias 1 → divide by 4
  })

  it('drums puts T1 on the beat and T2 on the backbeat', () => {
    const steps = Array.from({ length: 16 }, (_, s) => gatePattern('drums', s, 0.5, 0, () => 0.99))
    expect(steps.map(p => p.t1)).toEqual([true, ...Array(7).fill(false), true, ...Array(7).fill(false)])
    expect(steps.filter((p, s) => p.t2).length).toBe(2)
    expect(steps[4].t2).toBe(true)
    expect(steps[12].t2).toBe(true)
  })
})

describe('X voltages', () => {
  it('bias centres and spread widens, in pitch CV', () => {
    expect(xVoltage(0.5, 1, 0.5)).toBeCloseTo(0, 6)
    expect(xVoltage(1, 1, 0.5)).toBeCloseTo(X_RANGE, 6)
    expect(xVoltage(0, 1, 0.5)).toBeCloseTo(-X_RANGE, 6)
    expect(xVoltage(0, 0, 0.5)).toBeCloseTo(0, 6)   // spread 0 collapses to the centre
    expect(xVoltage(0.5, 1, 1)).toBeCloseTo(X_RANGE, 6)
  })

  it('steps crossfades to the quantized neighbour instead of switching', () => {
    const quantize = () => 0.1
    const raw = xVoltage(1, 1, 0.5)
    expect(xValue(1, 1, 0.5, 0, quantize)).toBeCloseTo(raw, 6)
    expect(xValue(1, 1, 0.5, 1, quantize)).toBeCloseTo(0.1, 6)
    expect(xValue(1, 1, 0.5, 0.5, quantize)).toBeCloseTo((raw + 0.1) / 2, 6)
  })
})

describe('MARBLE module', () => {
  const clock = (inst, n, t0 = 1, dt = 0.5) => {
    for (let i = 0; i < n; i++) inst.onEvent('clk', { type: 'trig', time: t0 + i * dt })
  }

  it('emits a T gate carrying its X value, and schedules that value on the jack', () => {
    const ctx = makeCtx()
    const emitEvent = vi.fn()
    const inst = marble.create(ctx, {
      params: { tBias: 0.5, tJitter: 0, tMode: 'divmult', dejaVu: 0, loopLen: 4, xSteps: 0 },
      emitEvent, random: () => 0.75
    })
    inst.onEvent('clk', { type: 'trig', time: 2 })
    const t2 = emitEvent.mock.calls.find(([port]) => port === 't2')
    expect(t2[1]).toMatchObject({ type: 'trig', time: 2, channel: 0 })
    expect(t2[1].cv).toBeCloseTo(xVoltage(0.75, 0.5, 0.5), 6)
    const sources = ctx.created.filter(n => n.kind === 'const')
    expect(sources[1].offset.setValueAtTime).toHaveBeenCalledWith(t2[1].cv, 2)
    inst.dispose()
  })

  it('a locked loop repeats its X values after loopLen clocks', () => {
    const emitEvent = vi.fn()
    // divmult keeps T2 firing on every clock, so every step of the loop is heard.
    const inst = marble.create(makeCtx(), {
      params: { tMode: 'divmult', dejaVu: 1, loopLen: 4, xSteps: 0 },
      emitEvent, random: scripted([0.9, 0.1, 0.9, 0.2, 0.9, 0.3, 0.9, 0.42, 0.9, 0.55, 0.9, 0.66])
    })
    clock(inst, 8)
    const heard = emitEvent.mock.calls.filter(([port]) => port === 't2').map(([, e]) => e.cv)
    expect(heard).toHaveLength(8)
    expect(heard.slice(4)).toEqual(heard.slice(0, 4))
    inst.dispose()
  })

  it('deja vu at 0 never repeats', () => {
    const emitEvent = vi.fn()
    const inst = marble.create(makeCtx(), {
      params: { tMode: 'divmult', dejaVu: 0, loopLen: 2, xSteps: 0 },
      emitEvent, random: scripted(Array.from({ length: 200 }, (_, i) => (i % 2 ? i / 400 : 0)))
    })
    clock(inst, 6)
    const heard = emitEvent.mock.calls.filter(([port]) => port === 't2').map(([, e]) => e.cv)
    expect(new Set(heard).size).toBe(heard.length)
    inst.dispose()
  })

  it('divmult ratchets T3 half a clock later', () => {
    const emitEvent = vi.fn()
    const inst = marble.create(makeCtx(), { params: { tMode: 'divmult' }, emitEvent, random: () => 0.5 })
    clock(inst, 2, 1, 0.5)
    const times = emitEvent.mock.calls.filter(([port]) => port === 't3').map(([, e]) => e.time)
    expect(times).toEqual([1, 1.5, 1.75])   // no interval known on the first clock
    inst.dispose()
  })

  it('the RATE jack divides the incoming clock', () => {
    const ctx = makeCtx()
    const emitEvent = vi.fn()
    const jobs = new Set()
    const poll = { add: job => { jobs.add(job); return () => jobs.delete(job) } }
    const inst = marble.create(ctx, { params: { tMode: 'divmult' }, emitEvent, poll, random: () => 0.5 })
    // 1.0 CV on RATE → divide by MAX_DIV (8).
    for (const n of ctx.created) if (n.kind === 'analyser') n.getFloatTimeDomainData = f => { f[0] = 1 }
    for (const job of jobs) job()
    clock(inst, 16)
    expect(emitEvent.mock.calls.filter(([port]) => port === 't2')).toHaveLength(2)
    inst.dispose()
  })

  it('ignores gate-off and unknown ports', () => {
    const emitEvent = vi.fn()
    const inst = marble.create(makeCtx(), { params: { tMode: 'divmult' }, emitEvent, random: () => 0.5 })
    inst.onEvent('clk', { type: 'gate-off', time: 1 })
    inst.onEvent('deja', { type: 'trig', time: 1 })
    expect(emitEvent).not.toHaveBeenCalled()
    inst.dispose()
  })

  it('dispose stops every source, drops the poll job and disconnects', () => {
    const ctx = makeCtx()
    const jobs = new Set()
    const poll = { add: job => { jobs.add(job); return () => jobs.delete(job) } }
    const inst = marble.create(ctx, { params: {}, poll, random: () => 0.5 })
    expect(jobs.size).toBe(1)
    inst.dispose()
    expect(jobs.size).toBe(0)
    for (const node of ctx.created) {
      expect(node.disconnected).toBeGreaterThan(0)
      if (node.kind === 'const') expect(node.stopped).toBe(1)
    }
  })
})
