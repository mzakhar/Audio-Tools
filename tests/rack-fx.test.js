import { describe, it, expect, vi } from 'vitest'
import fold, { foldCurve } from '../src/renderer/js/rack/modules/fold.js'
import bits, { bitsCurve } from '../src/renderer/js/rack/modules/bits.js'
import follow from '../src/renderer/js/rack/modules/follow.js'
import dyn from '../src/renderer/js/rack/modules/dyn.js'

// ---------------------------------------------------------------------------
// Same BaseAudioContext fake shape as rack-modules.test.js, plus the compressor
// and an analyser whose time-domain read can be scripted.
// ---------------------------------------------------------------------------
function makeCtx() {
  const created = []
  const param = () => ({
    value: 0,
    setValueAtTime: vi.fn(),
    setTargetAtTime: vi.fn(function (v) { this.value = v }),
    linearRampToValueAtTime: vi.fn(),
    exponentialRampToValueAtTime: vi.fn(),
    cancelScheduledValues: vi.fn()
  })
  const node = (kind, extra = {}) => {
    const n = { kind, started: 0, stopped: 0, disconnected: 0, connect: vi.fn(dst => dst), disconnect: vi.fn(function () { n.disconnected++ }), ...extra }
    created.push(n)
    return n
  }
  const source = (kind, extra) => node(kind, { start: vi.fn(function () { this.started++ }), stop: vi.fn(function () { this.stopped++ }), ...extra })
  return {
    currentTime: 0,
    sampleRate: 44100,
    created,
    counts: kind => created.filter(n => n.kind === kind).length,
    createGain: () => node('gain', { gain: param() }),
    createWaveShaper: () => node('shaper', { curve: null, oversample: 'none' }),
    createAnalyser: () => node('analyser', {
      fftSize: 2048,
      signal: 0,
      getFloatTimeDomainData: vi.fn(function (buf) { for (let i = 0; i < buf.length; i++) buf[i] = this.signal } )
    }),
    createConstantSource: () => source('const', { offset: param() }),
    createDynamicsCompressor: () => node('comp', {
      threshold: param(), knee: param(), ratio: param(), attack: param(), release: param(), reduction: 0
    })
  }
}

// Stand-in for RackPoll: run() fires every registered job once.
function makePoll() {
  const jobs = new Set()
  return { add: job => { jobs.add(job); return () => jobs.delete(job) }, run: () => jobs.forEach(j => j()), size: () => jobs.size }
}

// Defaults come off the definition — these three are not in the registry yet
// (the main thread wires index.js), and the module is the source of truth anyway.
const defaults = def => Object.fromEntries(def.params.map(p => [p.key, p.def]))
const inst = (def, ctx, opts = {}) => def.create(ctx, { ...opts, params: { ...defaults(def), ...opts.params } })
const distinct = curve => new Set(Array.from(curve, v => v.toFixed(6))).size

describe('FOLD', () => {
  it('is a native module and keeps the placeholder patch schema', () => {
    expect(fold.tier).toBe('native')
    expect(fold.poly).toBe(true)
    expect(fold.processorUrl).toBeUndefined()
    expect(fold.ports.map(p => [p.id, p.dir, p.kind])).toEqual([['in', 'in', 'audio'], ['amt', 'in', 'cv'], ['out', 'out', 'audio']])
    expect(fold.params.map(p => [p.key, p.min, p.max, p.def])).toEqual([['fold', 1, 8, 2], ['symmetry', -1, 1, 0], ['gain', 0, 2, 1]])
  })

  it('folds: unity is a pass-through, higher amounts turn back on themselves', () => {
    const flat = foldCurve(1, 0, 5)
    expect(Array.from(flat)).toEqual([-1, -0.5, 0, 0.5, 1].map(v => expect.closeTo(v, 5)))

    const folded = foldCurve(4, 0, 2049)
    expect(Math.max(...folded)).toBeLessThanOrEqual(1)
    expect(Math.min(...folded)).toBeGreaterThanOrEqual(-1)
    expect(folded[folded.length - 1]).toBeCloseTo(0, 3)     // tri(4) is back at zero
    let turns = 0
    for (let i = 1; i < folded.length - 1; i++) {
      if (Math.sign(folded[i] - folded[i - 1]) !== Math.sign(folded[i + 1] - folded[i])) turns++
    }
    expect(turns).toBeGreaterThanOrEqual(3)                 // four folds, three reversals
  })

  it('SYM offsets the curve so the folds land asymmetrically', () => {
    const sym = foldCurve(2, 0.5, 2049)
    expect(sym[(sym.length - 1) / 2]).toBeCloseTo(0.5, 3)   // zero input is no longer zero out
  })

  it('builds one 4x-oversampled voice per channel with AMT on the pre-gain', () => {
    const ctx = makeCtx()
    const node = inst(fold, ctx, { channels: 3 })
    expect(node.outputs.out).toHaveLength(3)
    expect(ctx.counts('shaper')).toBe(3)
    expect(ctx.created.filter(n => n.kind === 'shaper').every(s => s.oversample === '4x')).toBe(true)
    // AMT is an AudioParam (audio rate), not an AnalyserNode tap.
    expect(node.inputs.amt).toHaveLength(3)
    expect(typeof node.inputs.amt[0].setTargetAtTime).toBe('function')
    expect(node.inputs.amt[0].value).toBe(1)               // = GAIN default
  })

  it('rebuilds the curve for FOLD/SYM only, and rides GAIN as a param ramp', () => {
    const ctx = makeCtx()
    const node = inst(fold, ctx)
    const shaper = ctx.created.find(n => n.kind === 'shaper')
    const before = shaper.curve

    node.setParam('gain', 1.5)
    expect(shaper.curve).toBe(before)
    expect(node.inputs.amt[0].setTargetAtTime).toHaveBeenCalled()

    node.setParam('fold', 6)
    expect(shaper.curve).not.toBe(before)
    const afterFold = shaper.curve
    node.setParam('symmetry', 0.3)
    expect(shaper.curve).not.toBe(afterFold)
  })

  it('disconnects every node it made', () => {
    const ctx = makeCtx()
    inst(fold, ctx, { channels: 2 }).dispose()
    expect(ctx.created.every(n => n.disconnected > 0)).toBe(true)
  })
})

describe('BITS', () => {
  it('quantizes to 2^bits steps and stays inside [-1, 1]', () => {
    expect(distinct(bitsCurve(2, 4097))).toBeLessThanOrEqual(5)   // 4 steps, midtread endpoints
    expect(distinct(bitsCurve(4, 4097))).toBeLessThanOrEqual(17)
    expect(distinct(bitsCurve(2, 4097))).toBeGreaterThan(1)
    const c = bitsCurve(3, 1025)
    expect(Math.max(...c)).toBeLessThanOrEqual(1)
    expect(Math.min(...c)).toBeGreaterThanOrEqual(-1)
    // A staircase: fewer bits, coarser steps.
    expect(distinct(bitsCurve(3, 4097))).toBeLessThan(distinct(bitsCurve(6, 4097)))
  })

  it('is poly, with AMT on the wet gain param', () => {
    const ctx = makeCtx()
    const node = inst(bits, ctx, { channels: 2 })
    expect(node.outputs.out).toHaveLength(2)
    expect(node.inputs.amt).toHaveLength(2)
    expect(typeof node.inputs.amt[0].setTargetAtTime).toBe('function')
    expect(node.inputs.amt[0].value).toBe(1)               // = MIX default
  })

  it('rebuilds the curve on BITS and crossfades on MIX', () => {
    const ctx = makeCtx()
    const node = inst(bits, ctx)
    const shaper = ctx.created.find(n => n.kind === 'shaper')
    const before = shaper.curve
    node.setParam('bits', 4)
    expect(shaper.curve).not.toBe(before)

    node.setParam('mix', 0.25)
    expect(node.inputs.amt[0].value).toBeCloseTo(0.25, 6)
    const dryGain = ctx.created.filter(n => n.kind === 'gain').map(n => n.gain).find(g => g.setTargetAtTime.mock.calls.some(c => c[0] === 0.75))
    expect(dryGain).toBeTruthy()
  })

  it('disconnects every node it made', () => {
    const ctx = makeCtx()
    inst(bits, ctx, { channels: 2 }).dispose()
    expect(ctx.created.every(n => n.disconnected > 0)).toBe(true)
  })
})

describe('FOLLOW', () => {
  const build = (params = {}) => {
    const ctx = makeCtx(), poll = makePoll(), emitEvent = vi.fn()
    const node = inst(follow, ctx, { poll, emitEvent, params })
    return { ctx, poll, emitEvent, node, analyser: ctx.created.find(n => n.kind === 'analyser'), env: ctx.created.find(n => n.kind === 'const') }
  }

  it('tracks RMS on the poll and writes it to the ENV source', () => {
    const { poll, node, analyser, env } = build()
    expect(node.uiEnv()).toBe(0)
    analyser.signal = 0.5
    poll.run()
    expect(node.uiEnv()).toBeCloseTo(0.5 * Math.SQRT2, 3)
    expect(env.offset.setTargetAtTime).toHaveBeenCalled()
    expect(env.started).toBe(1)
  })

  it('scales by GAIN and clamps at 1', () => {
    const { poll, node, analyser } = build({ gain: 4 })
    analyser.signal = 0.5
    poll.run()
    expect(node.uiEnv()).toBe(1)
  })

  it('opens and closes GATE around the threshold, with hysteresis', () => {
    const { poll, emitEvent, analyser } = build({ threshold: 0.5, gain: 1 })
    analyser.signal = 0.6
    poll.run()
    expect(emitEvent).toHaveBeenCalledWith('gate', expect.objectContaining({ type: 'gate-on' }))
    emitEvent.mockClear()

    poll.run()                                    // still loud: no repeat gate
    expect(emitEvent).not.toHaveBeenCalled()

    analyser.signal = 0.33                        // 0.467 rms — under 0.5 but inside hysteresis
    poll.run()
    expect(emitEvent).not.toHaveBeenCalled()

    analyser.signal = 0
    poll.run()
    expect(emitEvent).toHaveBeenCalledWith('gate', expect.objectContaining({ type: 'gate-off' }))
  })

  it('is mono, stops its source and leaves no poll job behind', () => {
    const { ctx, poll, node, env } = build()
    expect(node.outputs.env).toHaveLength(1)
    expect(node.outputs.gate).toHaveLength(1)
    expect(poll.size()).toBe(1)
    node.dispose()
    expect(poll.size()).toBe(0)
    expect(env.stopped).toBe(1)
    expect(ctx.created.every(n => n.disconnected > 0)).toBe(true)
  })
})

describe('DYN', () => {
  const build = () => {
    const ctx = makeCtx(), poll = makePoll()
    const node = inst(dyn, ctx, { poll })
    return { ctx, poll, node, comp: ctx.created.find(n => n.kind === 'comp') }
  }

  it('seeds the compressor from the defaults, converting ms to seconds', () => {
    const { comp } = build()
    expect(comp.threshold.value).toBe(-24)
    expect(comp.ratio.value).toBe(4)
    expect(comp.attack.value).toBeCloseTo(0.003, 6)
    expect(comp.release.value).toBeCloseTo(0.25, 6)
  })

  it('routes setParam to the matching AudioParam', () => {
    const { comp, node } = build()
    node.setParam('ratio', 12)
    expect(comp.ratio.setTargetAtTime).toHaveBeenCalledWith(12, 0, 0.01)
    node.setParam('attack', 20)
    expect(comp.attack.setTargetAtTime).toHaveBeenCalledWith(0.02, 0, 0.01)
  })

  it('reads gain reduction on the poll', () => {
    const { comp, poll, node } = build()
    expect(node.uiReduction()).toBe(0)
    comp.reduction = -6.5
    poll.run()
    expect(node.uiReduction()).toBe(-6.5)
  })

  it('is mono and disposes clean', () => {
    const { ctx, poll, node } = build()
    expect(node.inputs.in).toHaveLength(1)
    node.dispose()
    expect(poll.size()).toBe(0)
    expect(ctx.created.every(n => n.disconnected > 0)).toBe(true)
  })
})
