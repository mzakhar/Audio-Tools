import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import grain, { MAX_GRAINS } from '../src/renderer/js/rack/modules/grain.js'

function makeCtx() {
  const created = []
  const param = () => ({
    value: 0,
    setValueAtTime: vi.fn(),
    setTargetAtTime: vi.fn(),
    setValueCurveAtTime: vi.fn(),
    cancelScheduledValues: vi.fn()
  })
  const node = (kind, extra = {}) => {
    const n = { kind, started: 0, stopped: 0, connect: vi.fn(), disconnect: vi.fn(), ...extra }
    created.push(n)
    return n
  }
  return {
    currentTime: 0,
    sampleRate: 44100,
    created,
    sources: () => created.filter(n => n.kind === 'bufsrc'),
    createGain: () => node('gain', { gain: param() }),
    createStereoPanner: () => node('panner', { pan: param() }),
    createAnalyser: () => node('analyser', { fftSize: 2048, getFloatTimeDomainData: vi.fn() }),
    createBufferSource: () => node('bufsrc', {
      buffer: null, playbackRate: param(),
      start: vi.fn(function () { this.started++ }),
      stop: vi.fn(function () { this.stopped++ })
    })
  }
}

const defaults = () => Object.fromEntries(grain.params.map(p => [p.key, p.def]))
const fakeBuffer = (duration = 4) => ({
  numberOfChannels: 1, length: duration * 44100, sampleRate: 44100, duration,
  getChannelData: () => new Float32Array(4)
})

describe('GRAIN', () => {
  let ctx
  beforeEach(() => { ctx = makeCtx(); vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  const build = (params = {}, getBuffer = () => null, extra = {}) =>
    grain.create(ctx, {
      params: { ...defaults(), fileKey: 'a.wav', ...params },
      getBuffer,
      random: () => 0.5,
      ...extra
    })

  it('is a mono native source with the spec ports', () => {
    expect([grain.group, grain.tier, grain.poly, grain.hp]).toEqual(['source', 'native', false, 16])
    const inst = build()
    for (const port of grain.ports) {
      const bag = port.dir === 'in' ? inst.inputs : inst.outputs
      expect(bag[port.id], `${port.id} missing`).toHaveLength(1)
    }
    inst.dispose()
  })

  it('emits nothing while the buffer is still decoding, and never throws', () => {
    const inst = build({}, () => null)
    expect(() => vi.advanceTimersByTime(200)).not.toThrow()
    expect(ctx.sources()).toHaveLength(0)
    expect(inst.uiState()).toMatchObject({ file: 'a.wav', ready: false, grains: 0 })
    inst.dispose()
  })

  it('schedules a lookahead of grains as soon as it mounts', () => {
    // 20 Hz over the scheduler's 100 ms lookahead is two grains up front.
    const inst = build({ density: 20 }, () => fakeBuffer(4))
    expect(ctx.sources().length).toBeGreaterThanOrEqual(2)
    const [first] = ctx.sources()
    expect(first.start.mock.calls[0][0]).toBe(0)
    inst.dispose()
  })

  it('windows every grain with a Hann curve over the grain length', () => {
    const inst = build({ size: 80 }, () => fakeBuffer(4))
    const win = ctx.created.find(n => n.kind === 'gain' && n.gain.setValueCurveAtTime.mock.calls.length)
    const [curve, time, duration] = win.gain.setValueCurveAtTime.mock.calls[0]
    expect(duration).toBeCloseTo(0.08, 6)
    expect(time).toBe(0)
    expect(curve[0]).toBeCloseTo(0, 6)
    expect(curve.at(-1)).toBeCloseTo(0, 6)
    expect(Math.max(...curve)).toBeCloseTo(1, 2)   // peak falls between two of the 64 points
    inst.dispose()
  })

  it('reads POS and PITCH off the shared 30 Hz poll', () => {
    const jobs = []
    const inst = build({ position: 0, spray: 0, pitch: 0 }, () => fakeBuffer(4), {
      poll: { add: job => { jobs.push(job); return () => {} } }
    })
    for (const node of ctx.created.filter(n => n.kind === 'analyser')) {
      node.getFloatTimeDomainData = frame => {
        frame[0] = node === inst.inputs.pos[0] ? 0.5 : node === inst.inputs.pitch[0] ? 0.1 : 0
      }
    }
    jobs.forEach(job => job())
    const before = ctx.sources().length
    inst.onEvent('trig', { type: 'trig', time: 0 })   // re-seed so new grains read the CV
    const src = ctx.sources()[before]
    // POS scans the range of valid grain *starts*, not the whole buffer: a grain
    // has to fit after its offset or it plays for zero seconds. Halfway through
    // a 4 s file with an 80 ms grain at double speed is 0.5 * (4 - 0.16).
    expect(src.start.mock.calls[0][1]).toBeCloseTo(1.92, 6)
    expect(src.playbackRate.value).toBeCloseTo(2, 6)       // 0.1 CV = one octave
    inst.dispose()
  })

  it('re-seeds the grain clock on TRIG', () => {
    const inst = build({ density: 20 }, () => fakeBuffer(4))
    const before = ctx.sources().length
    inst.onEvent('trig', { type: 'trig', time: 1 })
    // Nothing yet — the clock now starts a second out, past the lookahead.
    expect(ctx.sources().length).toBe(before)
    ctx.currentTime = 0.95
    vi.advanceTimersByTime(25)
    const fresh = ctx.sources().slice(before)
    expect(fresh.length).toBeGreaterThan(0)
    expect(fresh[0].start.mock.calls[0][0]).toBe(1)   // restarted at the event time
    inst.dispose()
  })

  it('caps concurrent grains at 64 rather than starving the graph', () => {
    // Every re-seed lays down another lookahead of grains and the context clock
    // never moves, so nothing retires — the only thing holding the count is the cap.
    const inst = build({ density: 100, size: 500 }, () => fakeBuffer(4))
    for (let i = 0; i < 12; i++) inst.onEvent('trig', { type: 'trig', time: 0 })
    expect(inst.uiState().grains).toBe(MAX_GRAINS)
    expect(ctx.sources().length).toBe(MAX_GRAINS)
    inst.dispose()
  })

  it('retires grains once the context clock passes their end', () => {
    const inst = build({ density: 100, size: 10 }, () => fakeBuffer(4))
    expect(inst.uiState().grains).toBeGreaterThan(0)
    ctx.currentTime = 10
    inst.onEvent('trig', { type: 'trig', time: 10 })
    expect(inst.uiState().grains).toBeLessThan(MAX_GRAINS)
    inst.dispose()
  })

  it('stops the grain clock and every source on dispose', () => {
    const inst = build({ density: 50 }, () => fakeBuffer(4))
    vi.advanceTimersByTime(100)
    expect(ctx.sources().length).toBeGreaterThan(0)
    inst.dispose()
    expect(vi.getTimerCount()).toBe(0)
    expect(ctx.sources().filter(n => n.started > 0 && n.stopped === 0)).toEqual([])
    // And a stopped clock stays stopped.
    const count = ctx.sources().length
    vi.advanceTimersByTime(500)
    expect(ctx.sources().length).toBe(count)
  })

  // A bounce renders faster than wall clock, so the setTimeout-driven grain
  // clock never fires and the cloud would come out silent.
  it('lays the whole cloud down at mount in an offline context', () => {
    const offline = makeCtx()
    offline.length = 44100 * 2          // two seconds of render
    offline.startRendering = vi.fn()
    const inst = grain.create(offline, {
      params: { ...defaults(), fileKey: 'a.wav', density: 20, jitter: 0 },
      getBuffer: () => fakeBuffer(4),
      random: () => 0.5
    })
    // 20 Hz over two seconds, and no timer left running to produce them.
    expect(offline.sources().length).toBeGreaterThan(30)
    expect(vi.getTimerCount()).toBe(0)
    // Every grain is stamped inside the render window, in order.
    const starts = offline.sources().map(n => n.start.mock.calls[0][0])
    expect(starts[0]).toBeGreaterThanOrEqual(0)
    expect(starts.at(-1)).toBeLessThan(2)
    expect(starts).toEqual([...starts].sort((a, b) => a - b))
    inst.dispose()
  })

  // POS fully clockwise used to start every grain at the very end of the file,
  // so each one had zero length and the top of the knob was silence.
  it('still plays a full grain with POS at maximum', () => {
    const inst = build({ position: 1, spray: 0, pitch: 0, size: 100 }, () => fakeBuffer(4))
    const src = ctx.sources().at(-1)
    const [, offset, length] = src.start.mock.calls[0]
    expect(offset).toBeLessThan(4)
    expect(length).toBeCloseTo(0.1, 6)
    inst.dispose()
  })

  it('takes every param at both ends of its range without throwing', () => {
    const inst = build({}, () => fakeBuffer(4))
    for (const p of grain.params) {
      for (const value of p.options ? p.options : [p.min, p.max]) {
        expect(() => inst.setParam(p.key, value, 0), `${p.key}=${value}`).not.toThrow()
      }
    }
    inst.dispose()
  })
})
