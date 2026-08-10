import { describe, it, expect, vi } from 'vitest'
import { INSTRUMENTS, makeKitParams, createTr909Voice, metalBuffer, ROM_RATE } from '../src/renderer/js/drums/tr909-kit.js'

// Fake BaseAudioContext whose buffers actually retain what gets written.
function makeCtx(sampleRate = 44100) {
  const created = []
  const param = () => ({
    value: 0,
    setValueAtTime: vi.fn(),
    setTargetAtTime: vi.fn(),
    linearRampToValueAtTime: vi.fn(),
    exponentialRampToValueAtTime: vi.fn(),
    cancelScheduledValues: vi.fn()
  })
  const node = (kind, extra = {}) => {
    const n = { kind, connect: vi.fn(d => d), disconnect: vi.fn(), ...extra }
    created.push(n)
    return n
  }
  const source = (kind, extra) => node(kind, {
    starts: 0, stops: 0,
    start: vi.fn(function () { this.starts++ }),
    stop: vi.fn(function () { this.stops++ }),
    ...extra
  })
  return {
    currentTime: 0,
    sampleRate,
    created,
    createGain: () => node('gain', { gain: param() }),
    createBiquadFilter: () => node('biquad', { type: 'lowpass', frequency: param(), Q: param(), gain: param(), detune: param() }),
    createWaveShaper: () => node('shaper', { curve: null }),
    createOscillator: () => source('osc', { type: 'sine', frequency: param(), detune: param() }),
    createBufferSource: () => source('bufsrc', { buffer: null, loop: false, playbackRate: param() }),
    createBuffer: (ch, len) => {
      const data = new Float32Array(len)
      return { numberOfChannels: ch, length: len, getChannelData: () => data }
    }
  }
}

describe('909 cymbal ROM', () => {
  const ctx = makeCtx()
  const data = metalBuffer(ctx, 'hat').getChannelData(0)

  it('is quantized to 6 bits', () => {
    const levels = new Set(data)
    expect(levels.size).toBeLessThanOrEqual(64)
    expect(levels.size).toBeGreaterThan(8) // not silence / not a couple of values
  })

  it('is sample-and-held at the ROM clock, not the context rate', () => {
    let changes = 0
    for (let i = 1; i < data.length; i++) if (data[i] !== data[i - 1]) changes++
    const seconds = data.length / ctx.sampleRate
    // Every held step is a ROM tick, but consecutive ticks can land on the same
    // quantized level, so the change count is an under-count of the clock rate.
    expect(changes / seconds).toBeLessThanOrEqual(ROM_RATE * 1.05)
    expect(changes / seconds).toBeGreaterThan(ROM_RATE * 0.5)
  })

  it('caches per context', () => {
    expect(metalBuffer(ctx, 'hat')).toBe(metalBuffer(ctx, 'hat'))
    expect(metalBuffer(makeCtx(), 'hat')).not.toBe(metalBuffer(ctx, 'hat'))
  })
})

describe('909 voices', () => {
  it('start and schedule a stop for every source they create', () => {
    const params = makeKitParams()
    for (const inst of INSTRUMENTS) {
      const ctx = makeCtx()
      const out = ctx.createGain()
      createTr909Voice(ctx, out, inst.id, params, { velocity: 1 }, 0)
      const sources = ctx.created.filter(n => typeof n.start === 'function')
      expect(sources.length, inst.id).toBeGreaterThan(0)
      for (const src of sources) {
        expect(src.starts, `${inst.id} ${src.kind} start`).toBe(1)
        expect(src.stops, `${inst.id} ${src.kind} stop`).toBe(1)
      }
    }
  })

  it('chokes the open hat when a closed hat fires', () => {
    const ctx = makeCtx()
    const out = ctx.createGain()
    const params = makeKitParams()
    const oh = createTr909Voice(ctx, out, 'oh', params, {}, 0)
    const spy = vi.spyOn(oh, 'stop')
    createTr909Voice(ctx, out, 'ch', params, {}, 1)
    expect(spy).toHaveBeenCalledWith(1)
  })
})
