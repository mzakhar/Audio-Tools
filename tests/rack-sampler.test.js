import { describe, it, expect, beforeEach, vi } from 'vitest'
import sampler from '../src/renderer/js/rack/modules/sampler.js'

// Same fake-context shape as tests/rack-modules.test.js, plus the buffer bits a
// sample player touches.
function makeCtx() {
  const created = []
  const param = () => ({
    value: 0,
    setValueAtTime: vi.fn(),
    setTargetAtTime: vi.fn(),
    setValueCurveAtTime: vi.fn(),
    linearRampToValueAtTime: vi.fn(),
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
    createAnalyser: () => node('analyser', { fftSize: 2048, getFloatTimeDomainData: vi.fn() }),
    createBufferSource: () => node('bufsrc', {
      buffer: null, loop: false, loopStart: 0, loopEnd: 0, playbackRate: param(),
      start: vi.fn(function () { this.started++ }),
      stop: vi.fn(function () { this.stopped++ })
    }),
    createBuffer: (channels, length, sampleRate) => {
      const buf = {
        kind: 'buffer', numberOfChannels: channels, length, sampleRate,
        duration: length / sampleRate,
        getChannelData: () => new Float32Array(length)
      }
      created.push(buf)
      return buf
    }
  }
}

const defaults = () => Object.fromEntries(sampler.params.map(p => [p.key, p.def]))
const fakeBuffer = (duration = 2) => ({
  numberOfChannels: 1,
  length: duration * 44100,
  sampleRate: 44100,
  duration,
  getChannelData: () => new Float32Array(4)
})

describe('SAMPLR', () => {
  let ctx
  beforeEach(() => { ctx = makeCtx() })

  const build = (params = {}, getBuffer = () => null) =>
    sampler.create(ctx, { params: { ...defaults(), fileKey: 'a.wav', ...params }, getBuffer })

  it('is a mono native source with the spec ports', () => {
    expect([sampler.group, sampler.tier, sampler.poly, sampler.hp]).toEqual(['source', 'native', false, 12])
    const inst = build()
    for (const port of sampler.ports) {
      const bag = port.dir === 'in' ? inst.inputs : inst.outputs
      expect(bag[port.id], `${port.id} missing`).toHaveLength(1)
    }
    inst.dispose()
  })

  it('is silent, not fatal, while the buffer is still decoding', () => {
    const inst = build({}, () => null)
    expect(() => inst.onEvent('trig', { type: 'trig', time: 1 })).not.toThrow()
    // No half-built voice either: nothing was created at all.
    expect(ctx.sources()).toHaveLength(0)
    expect(inst.uiState()).toEqual({ file: 'a.wav', ready: false })
    inst.dispose()
  })

  it('plays the start..end window and schedules its own stop', () => {
    const inst = build({ start: 0.25, end: 0.75, decay: 4 }, () => fakeBuffer(2))
    inst.onEvent('trig', { type: 'trig', time: 5 })
    const [src] = ctx.sources()
    // offset 0.5 s into a 2 s file, one second of buffer time.
    expect(src.start).toHaveBeenCalledWith(5, 0.5, 1)
    expect(src.stop.mock.calls[0][0]).toBeCloseTo(6.005, 6)
    inst.dispose()
  })

  it('shortens the slice to DECAY and pitches by semitones plus 1V/oct CV', () => {
    const inst = build({ decay: 0.1, pitch: 12 }, () => fakeBuffer(2))
    inst.onEvent('trig', { type: 'trig', time: 0 })
    const [src] = ctx.sources()
    expect(src.playbackRate.value).toBeCloseTo(2, 6)
    expect(src.stop.mock.calls[0][0]).toBeCloseTo(0.105, 6)
    inst.dispose()
  })

  it('loops between the window bounds when LOOP is on', () => {
    const inst = build({ start: 0.5, end: 1, loop: true, decay: 2 }, () => fakeBuffer(4))
    inst.onEvent('trig', { type: 'trig', time: 0 })
    const [src] = ctx.sources()
    expect([src.loop, src.loopStart, src.loopEnd]).toEqual([true, 2, 4])
    expect(src.start).toHaveBeenCalledWith(0, 2)
    inst.dispose()
  })

  it('ignores a window of zero length instead of starting a silent voice', () => {
    const inst = build({ start: 0.7, end: 0.7 }, () => fakeBuffer(2))
    inst.onEvent('trig', { type: 'trig', time: 1 })
    expect(ctx.sources()).toHaveLength(0)
    inst.dispose()
  })

  it('chokes a live voice in the same group at the new voice start', () => {
    const inst = build({ choke: 1, decay: 4 }, () => fakeBuffer(2))
    inst.onEvent('trig', { type: 'trig', time: 1 })
    const [first] = ctx.sources()
    inst.onEvent('trig', { type: 'trig', time: 1.5 })
    // Stopped a hair after the new voice starts — the fade is a click guard.
    const choked = first.stop.mock.calls.at(-1)[0]
    expect(choked).toBeGreaterThanOrEqual(1.5)
    expect(choked).toBeLessThan(1.52)
    expect(ctx.sources()).toHaveLength(2)
    inst.dispose()
  })

  it('leaves other voices alone, and group 0 chokes nothing', () => {
    const inst = build({ choke: 0, decay: 4 }, () => fakeBuffer(2))
    inst.onEvent('trig', { type: 'trig', time: 1 })
    const [first] = ctx.sources()
    const before = first.stop.mock.calls.length
    inst.onEvent('trig', { type: 'trig', time: 1.5 })
    expect(first.stop.mock.calls.length).toBe(before)
    inst.dispose()
  })

  it('reverses once per fileKey, not once per trigger', () => {
    const buffer = fakeBuffer(2)
    const inst = build({ reverse: true, start: 0.25, end: 0.75 }, () => buffer)
    inst.onEvent('trig', { type: 'trig', time: 0 })
    inst.onEvent('trig', { type: 'trig', time: 1 })
    expect(ctx.created.filter(n => n.kind === 'buffer')).toHaveLength(1)
    // The window mirrors with the audio: 0.25..0.75 from the end is 0.5 s in.
    expect(ctx.sources()[0].start).toHaveBeenCalledWith(0, 0.5, 1)

    inst.setParam('fileKey', 'b.wav')
    inst.onEvent('trig', { type: 'trig', time: 2 })
    expect(ctx.created.filter(n => n.kind === 'buffer')).toHaveLength(2)
    inst.dispose()
  })

  it('reads START and PITCH CV off the shared poll', () => {
    const jobs = []
    const poll = { add: job => { jobs.push(job); return () => {} } }
    const inst = sampler.create(ctx, {
      params: { ...defaults(), fileKey: 'a.wav', start: 0, end: 1 },
      poll,
      getBuffer: () => fakeBuffer(2)
    })
    // 0.5 CV on START is half the knob's 0..1 range; 0.1 pitch CV is an octave.
    for (const node of ctx.created.filter(n => n.kind === 'analyser')) {
      node.getFloatTimeDomainData = frame => { frame[0] = node === inst.inputs.start[0] ? 0.5 : 0.1 }
    }
    jobs.forEach(job => job())
    inst.onEvent('trig', { type: 'trig', time: 0 })
    const [src] = ctx.sources()
    expect(src.start.mock.calls[0][1]).toBeCloseTo(1, 6)
    expect(src.playbackRate.value).toBeCloseTo(2, 6)
    inst.dispose()
  })

  it('leaves no source running after dispose', () => {
    const inst = build({ decay: 4, loop: true }, () => fakeBuffer(2))
    for (let i = 0; i < 8; i++) inst.onEvent('trig', { type: 'trig', time: i * 0.1 })
    inst.dispose()
    expect(ctx.sources().filter(n => n.started > 0 && n.stopped === 0)).toEqual([])
    expect(ctx.created.filter(n => n.kind === 'gain' && n.disconnect.mock.calls.length === 0)).toEqual([])
  })

  it('takes every param at both ends of its range without throwing', () => {
    const inst = build({}, () => fakeBuffer(2))
    for (const p of sampler.params) {
      for (const value of p.options ? p.options : [p.min, p.max]) {
        expect(() => inst.setParam(p.key, value, 0), `${p.key}=${value}`).not.toThrow()
      }
    }
    inst.dispose()
  })
})
