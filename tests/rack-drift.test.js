import { describe, it, expect, vi } from 'vitest'
import { walkStep, lorenzStep, LORENZ_SEED } from '../src/renderer/js/rack/drift.js'
import drift from '../src/renderer/js/rack/modules/drift.js'

function makeCtx(currentTime = 0) {
  const created = []
  const param = () => ({
    value: 0,
    setValueAtTime: vi.fn(),
    setTargetAtTime: vi.fn(),
    linearRampToValueAtTime: vi.fn(),
    cancelScheduledValues: vi.fn()
  })
  const node = (kind, extra = {}) => {
    const n = { kind, connect: vi.fn(), disconnect: vi.fn(function () { n.disconnected++ }), disconnected: 0, ...extra }
    created.push(n)
    return n
  }
  return {
    currentTime,
    created,
    createGain: () => node('gain', { gain: param() }),
    createAnalyser: () => node('analyser', { fftSize: 32, getFloatTimeDomainData: vi.fn() }),
    createConstantSource: () => node('const', {
      offset: param(), started: 0, stopped: 0,
      start: vi.fn(function () { this.started++ }), stop: vi.fn(function () { this.stopped++ })
    })
  }
}

function fakePoll() {
  const jobs = new Set()
  return { jobs, add: job => { jobs.add(job); return () => jobs.delete(job) }, run: () => jobs.forEach(j => j()) }
}

describe('walkStep', () => {
  it('reflects off the rails instead of parking on them', () => {
    expect(walkStep(0.9, 1, () => 1)).toBeCloseTo(0.1, 6)     // 1.9 folds back to 0.1
    expect(walkStep(-0.9, 1, () => 0)).toBeCloseTo(-0.1, 6)   // -1.9 folds back to -0.1
  })

  it('stays inside [-1, 1] over a long walk', () => {
    let value = 0
    let seed = 12345
    const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
    let worst = 0
    for (let i = 0; i < 10000; i++) {
      value = walkStep(value, 0.3, random)
      worst = Math.max(worst, Math.abs(value))
    }
    expect(worst).toBeLessThanOrEqual(1)
    expect(worst).toBeGreaterThan(0.5)   // and it does actually roam
  })

  it('a zero-depth walk does not move', () => {
    expect(walkStep(0.42, 0, Math.random)).toBe(0.42)
  })

  it('treats a non-finite value as zero rather than propagating NaN', () => {
    expect(walkStep(NaN, 0.3, () => 0.5)).toBe(0)
  })
})

describe('lorenzStep', () => {
  it('stays bounded and NaN-free over 10 000 steps', () => {
    let state = { ...LORENZ_SEED }
    const worst = { x: 0, y: 0, z: 0 }
    let finite = true
    for (let i = 0; i < 10000; i++) {
      state = lorenzStep(state, 0.01)
      for (const axis of ['x', 'y', 'z']) {
        if (!Number.isFinite(state[axis])) finite = false
        worst[axis] = Math.max(worst[axis], Math.abs(state[axis]))
      }
    }
    expect(finite).toBe(true)
    expect(worst.x).toBeLessThan(50)
    expect(worst.y).toBeLessThan(70)
    expect(worst.z).toBeLessThan(90)
    expect(worst.x).toBeGreaterThan(5)   // on the attractor, not collapsed to a point
  })

  it('is deterministic and actually moves', () => {
    const a = lorenzStep(LORENZ_SEED, 0.01)
    const b = lorenzStep(LORENZ_SEED, 0.01)
    expect(a).toEqual(b)
    expect(a.x).not.toBe(LORENZ_SEED.x)
  })
})

describe('DRIFT module', () => {
  it('fills ~200 ms of stepped segments up front in walk mode', () => {
    const ctx = makeCtx(0)
    const inst = drift.create(ctx, { params: { rate: 10, depth: 1, mode: 'walk', bipolar: 'off' }, ctxTime: 0, random: () => 0.5 })
    const sources = ctx.created.filter(n => n.kind === 'const')
    expect(sources).toHaveLength(3)
    // 10 Hz over a 0.2 s lookahead = two segments per axis, stepped not ramped.
    for (const src of sources) {
      expect(src.offset.setValueAtTime).toHaveBeenCalledTimes(2)
      expect(src.offset.linearRampToValueAtTime).not.toHaveBeenCalled()
    }
    inst.dispose()
  })

  it('smooth and lorenz modes ramp instead of stepping', () => {
    for (const mode of ['smooth', 'lorenz']) {
      const ctx = makeCtx(0)
      const inst = drift.create(ctx, { params: { rate: 10, depth: 1, mode, bipolar: 'on' }, ctxTime: 0, random: () => 0.5 })
      for (const src of ctx.created.filter(n => n.kind === 'const')) {
        expect(src.offset.linearRampToValueAtTime).toHaveBeenCalledTimes(2)
        expect(src.offset.setValueAtTime).not.toHaveBeenCalled()
      }
      inst.dispose()
    }
  })

  it('tops the schedule up from the shared poll, never faster than the lookahead', () => {
    const ctx = makeCtx(0)
    const poll = fakePoll()
    const inst = drift.create(ctx, { params: { rate: 10, depth: 1, mode: 'walk', bipolar: 'off' }, ctxTime: 0, poll, random: () => 0.5 })
    const src = ctx.created.find(n => n.kind === 'const')
    expect(src.offset.setValueAtTime).toHaveBeenCalledTimes(2)

    poll.run()                      // no time has passed — nothing new to schedule
    expect(src.offset.setValueAtTime).toHaveBeenCalledTimes(2)

    ctx.currentTime = 0.5
    poll.run()                      // 0.5 → 0.7 s of lookahead, at 10 Hz
    expect(src.offset.setValueAtTime.mock.calls.length).toBeGreaterThan(2)
    inst.dispose()
  })

  it('never schedules more than the segment cap in one fill', () => {
    const ctx = makeCtx(0)
    // 10 Hz would want 2 segments; the cap only bites when rate is absurd, so
    // check the loop terminates and stays under the cap for the fastest rate.
    const inst = drift.create(ctx, { params: { rate: 10, depth: 1, mode: 'walk', bipolar: 'off' }, ctxTime: 0, random: () => 0.5 })
    for (const src of ctx.created.filter(n => n.kind === 'const')) {
      expect(src.offset.setValueAtTime.mock.calls.length).toBeLessThanOrEqual(64)
    }
    inst.dispose()
  })

  it('RST cancels the schedule and restarts from the seed at the event time', () => {
    const ctx = makeCtx(0)
    const inst = drift.create(ctx, { params: { rate: 10, depth: 1, mode: 'walk', bipolar: 'off' }, ctxTime: 0, random: () => 0.9 })
    const src = ctx.created.find(n => n.kind === 'const')
    inst.onEvent('rst', { type: 'trig', time: 3 })
    expect(src.offset.cancelScheduledValues).toHaveBeenCalledWith(3)
    expect(src.offset.setValueAtTime).toHaveBeenCalledWith(0.5, 3)   // unipolar rest is half scale
    inst.dispose()
  })

  it('unipolar output rests at half scale, bipolar at zero', () => {
    const uni = makeCtx(0)
    drift.create(uni, { params: { rate: 1, depth: 1, mode: 'walk', bipolar: 'off' }, ctxTime: 0, random: () => 0.5 })
      .dispose()
    expect(uni.created.find(n => n.kind === 'const').offset.value).toBe(0.5)

    const bi = makeCtx(0)
    drift.create(bi, { params: { rate: 1, depth: 1, mode: 'walk', bipolar: 'on' }, ctxTime: 0, random: () => 0.5 })
      .dispose()
    expect(bi.created.find(n => n.kind === 'const').offset.value).toBe(0)
  })

  it('dispose stops all three sources, drops the poll job and disconnects', () => {
    const ctx = makeCtx(0)
    const poll = fakePoll()
    const inst = drift.create(ctx, { params: { rate: 1, depth: 1, mode: 'walk', bipolar: 'off' }, ctxTime: 0, poll, random: () => 0.5 })
    expect(poll.jobs.size).toBe(1)
    inst.dispose()
    expect(poll.jobs.size).toBe(0)
    for (const node of ctx.created) {
      expect(node.disconnected).toBeGreaterThan(0)
      if (node.kind === 'const') expect(node.stopped).toBe(1)
    }
  })

  // At 0.01 Hz one segment is a 100-second ramp. Without cancelling, a rate or
  // mode change rode the old trajectory to its end — and because the engine
  // reuses a module across a preset swap when the id matches, Chaos Drone came
  // up behind a filter parked by the ramp the previous patch had scheduled.
  describe('reshaping cancels what is already scheduled', () => {
    const build = (params = {}) => {
      const ctx = makeCtx(5)
      const poll = fakePoll()
      const inst = drift.create(ctx, { params: { rate: 0.01, depth: 1, mode: 'smooth', bipolar: 'off', ...params }, poll, ctxTime: 5 })
      const sources = ctx.created.filter(n => n.kind === 'const')
      for (const s of sources) { s.offset.cancelScheduledValues.mockClear(); s.offset.linearRampToValueAtTime.mockClear(); s.offset.setValueAtTime.mockClear() }
      return { ctx, inst, sources }
    }

    for (const key of ['rate', 'mode', 'depth', 'bipolar']) {
      it(`cancels and refills when ${key} changes`, () => {
        const { inst, sources } = build()
        const next = { rate: 5, mode: 'walk', depth: 0.2, bipolar: 'on' }[key]
        inst.setParam(key, next)
        for (const s of sources) {
          expect(s.offset.cancelScheduledValues).toHaveBeenCalled()
          const scheduled = s.offset.linearRampToValueAtTime.mock.calls.length + s.offset.setValueAtTime.mock.calls.length
          expect(scheduled).toBeGreaterThan(0)
        }
        inst.dispose()
      })
    }

    it('leaves the schedule alone when the value does not actually change', () => {
      const { inst, sources } = build()
      inst.setParam('rate', 0.01)
      for (const s of sources) expect(s.offset.cancelScheduledValues).not.toHaveBeenCalled()
      inst.dispose()
    })
  })
})
