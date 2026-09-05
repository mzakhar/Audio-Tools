import { describe, expect, it, vi } from 'vitest'
import { sampleInstrumentFor } from '../src/renderer/js/instruments/sample-instrument.js'

function setup() {
  const sources = []
  const gains = []
  const ctx = {
    currentTime: 3,
    createBufferSource: () => {
      const source = { connect: vi.fn(), disconnect: vi.fn(), start: vi.fn(), stop: vi.fn(), playbackRate: { value: 0 } }
      sources.push(source)
      return source
    },
    createGain: () => {
      const gain = { connect: vi.fn(), disconnect: vi.fn(), gain: { setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn(), setTargetAtTime: vi.fn(), cancelScheduledValues: vi.fn() } }
      gains.push(gain)
      return gain
    }
  }
  return { ctx, sources, gains, output: {} }
}

const patch = { zones: [
  { keyLo: 0, keyHi: 60, rootKey: 60, sampleId: 'low', velocityHi: 100 },
  { keyLo: 61, keyHi: 127, rootKey: 72, sampleId: 'high' }
] }

describe('sample instrument', () => {
  it('scales velocity linearly unless a caller injects a curve', async () => {
    // Timeline playback passes nothing, so a saved project keeps the dynamics
    // it was mixed with. Live playing injects the pad curve instead.
    const plain = setup()
    const curved = setup()
    const buffer = { duration: 1, sampleRate: 44100 }
    const store = { get: async () => buffer, peek: () => buffer }
    sampleInstrumentFor(patch, { ...plain, sampleStore: store }).noteOn(50, 64)
    sampleInstrumentFor(patch, { ...curved, sampleStore: store, velocityToGain: () => 0.9 }).noteOn(50, 64)
    expect(plain.gains[0].gain.setValueAtTime).toHaveBeenCalledWith(64 / 127, 3)
    expect(curved.gains[0].gain.setValueAtTime).toHaveBeenCalledWith(0.9, 3)
  })

  it('chooses a matching zone and applies pitch and velocity', async () => {
    const { ctx, sources, output } = setup()
    const store = { get: vi.fn(() => Promise.resolve({})) }
    const inst = sampleInstrumentFor(patch, { ctx, output, sampleStore: store })
    inst.noteOn(72, 64)
    await Promise.resolve(); await Promise.resolve()
    expect(store.get).toHaveBeenCalledWith('high')
    expect(sources[0].playbackRate.value).toBe(1)
    expect(sources[0].start).toHaveBeenCalledWith(3)
  })

  it('plays a brief release when a first note resolves after key-up', async () => {
    const { ctx, sources, output } = setup()
    let done
    const inst = sampleInstrumentFor(patch, { ctx, output, sampleStore: { get: () => new Promise(resolve => { done = resolve }) } })
    inst.noteOn(60, 80)
    inst.noteOff(60)
    done({})
    await Promise.resolve(); await Promise.resolve()
    expect(sources).toHaveLength(1)
    expect(sources[0].start).toHaveBeenCalledWith(3)
    expect(sources[0].stop).toHaveBeenCalledWith(3.08)
  })

  it('stops and disconnects a started voice', async () => {
    const { ctx, sources, output } = setup()
    const inst = sampleInstrumentFor(patch, { ctx, output, sampleStore: { get: () => Promise.resolve({}) } })
    inst.noteOn(60, 80)
    await Promise.resolve(); await Promise.resolve()
    inst.noteOff(60)
    expect(sources[0].stop).toHaveBeenCalledWith(3)
    expect(sources[0].disconnect).toHaveBeenCalled()
  })

  it('preloads only the requested note zone', async () => {
    const { ctx, output } = setup()
    const preload = vi.fn(() => Promise.resolve())
    const inst = sampleInstrumentFor(patch, { ctx, output, sampleStore: { get: vi.fn(), preload } })
    await inst.preload(72, 64)
    expect(preload).toHaveBeenCalledWith(['high'])
  })

  it('keeps legacy zero-gain imported zones audible', async () => {
    const { ctx, sources, gains } = setup()
    const inst = sampleInstrumentFor({ zones: [{ keyLo: 0, keyHi: 127, rootKey: 60, sampleId: 'sample', gain: 0 }] }, {
      ctx, output: {}, sampleStore: { get: vi.fn(() => Promise.resolve({})) }
    })
    inst.noteOn(60, 127)
    await Promise.resolve()
    expect(gains[0].gain.setValueAtTime).toHaveBeenCalledWith(1, 3)
    expect(sources[0].start).toHaveBeenCalled()
  })

  it('reports a started sample with its effective gain', async () => {
    const { ctx, output } = setup()
    const onStatus = vi.fn()
    const inst = sampleInstrumentFor({ zones: [{ keyLo: 0, keyHi: 127, rootKey: 60, sampleId: 'sample', gain: 0.5 }] }, {
      ctx, output, sampleStore: { get: vi.fn(() => Promise.resolve({ duration: 1 })) }, onStatus
    })
    inst.noteOn(60, 127)
    await Promise.resolve()
    expect(onStatus).toHaveBeenLastCalledWith({ state: 'started', sampleId: 'sample', pitch: 60, gain: 0.5, duration: 1 })
  })

  it('converts legacy SoundFont loop frames to Web Audio seconds', async () => {
    const { ctx, sources, output } = setup()
    const inst = sampleInstrumentFor({ zones: [{ keyLo: 0, keyHi: 127, rootKey: 60, sampleId: 'sample', loopStart: 44100, loopEnd: 88200 }] }, {
      ctx, output, sampleStore: { get: vi.fn(() => Promise.resolve({ duration: 3, sampleRate: 44100 })) }
    })
    inst.noteOn(60)
    await Promise.resolve()
    expect(sources[0].loop).toBe(true)
    expect(sources[0].loopStart).toBe(1)
    expect(sources[0].loopEnd).toBe(2)
  })

  it('does not repeat tiny SoundFont loops without an SF2 envelope', async () => {
    const { ctx, sources, output } = setup()
    const inst = sampleInstrumentFor({ zones: [{ keyLo: 0, keyHi: 127, rootKey: 60, sampleId: 'sample', loopStart: 0.6, loopEnd: 0.606 }] }, {
      ctx, output, sampleStore: { get: vi.fn(() => Promise.resolve({ duration: 3, sampleRate: 44100 })) }
    })
    inst.noteOn(60)
    await Promise.resolve()
    expect(sources[0].loop).toBeUndefined()
  })

  it('loops a tiny SoundFont sustain under its volume envelope', async () => {
    const { ctx, sources, gains, output } = setup()
    const inst = sampleInstrumentFor({ zones: [{ keyLo: 0, keyHi: 127, rootKey: 60, sampleId: 'sample', loopStart: 0.6, loopEnd: 0.606, volumeEnvelope: { attack: 0.1, sustain: 0.1, release: 0.2 } }] }, {
      ctx, output, sampleStore: { get: vi.fn(() => Promise.resolve({ duration: 3, sampleRate: 44100 })) }
    })
    inst.noteOn(60)
    await Promise.resolve()
    expect(sources[0].loop).toBe(true)
    expect(gains[0].gain.linearRampToValueAtTime).toHaveBeenCalled()
    inst.noteOff(60)
    expect(sources[0].stop).toHaveBeenCalledWith(4.2)
  })

  it('keeps a released voice connected until its source ends', async () => {
    const { ctx, sources, gains, output } = setup()
    const inst = sampleInstrumentFor({ zones: [{ keyLo: 0, keyHi: 127, rootKey: 60, sampleId: 'sample', volumeEnvelope: { attack: 0.01, sustain: 1, release: 0.5 } }] }, {
      ctx, output, sampleStore: { get: vi.fn(() => Promise.resolve({ duration: 3, sampleRate: 44100 })) }
    })
    inst.noteOn(60, 100)
    await Promise.resolve(); await Promise.resolve()
    inst.noteOff(60)
    expect(gains[0].gain.setTargetAtTime).toHaveBeenCalled()
    expect(sources[0].stop).toHaveBeenCalledWith(6)
    expect(sources[0].disconnect).not.toHaveBeenCalled()
    expect(gains[0].disconnect).not.toHaveBeenCalled()
    sources[0].onended()
    expect(sources[0].disconnect).toHaveBeenCalled()
    expect(gains[0].disconnect).toHaveBeenCalled()
  })

  it('dispose cuts a released voice immediately instead of leaving it ringing', async () => {
    const { ctx, sources, output } = setup()
    const inst = sampleInstrumentFor({ zones: [{ keyLo: 0, keyHi: 127, rootKey: 60, sampleId: 'sample', volumeEnvelope: { release: 0.5 } }] }, {
      ctx, output, sampleStore: { get: vi.fn(() => Promise.resolve({ duration: 3, sampleRate: 44100 })) }
    })
    inst.noteOn(60, 100)
    await Promise.resolve(); await Promise.resolve()
    inst.dispose()
    expect(sources[0].stop).toHaveBeenCalledWith(3)
    expect(sources[0].disconnect).toHaveBeenCalled()
  })

  it('exposes setBend/setMod that are safe to call before any note', async () => {
    const { ctx, output } = setup()
    const inst = sampleInstrumentFor(patch, { ctx, output, sampleStore: { get: vi.fn(() => Promise.resolve({})) } })
    expect(typeof inst.setBend).toBe('function')
    expect(typeof inst.setMod).toBe('function')
    expect(() => inst.setBend(2)).not.toThrow()
    expect(() => inst.setMod(0.5)).not.toThrow()
  })

  it('connects the shared bend/vibrato sources into a started voice detune', async () => {
    const { ctx, sources, output } = setup()
    const bend = { offset: { value: 0, setValueAtTime: vi.fn() }, connect: vi.fn(), disconnect: vi.fn(), start: vi.fn(), stop: vi.fn() }
    const vibrato = { gain: { value: 0, setValueAtTime: vi.fn() }, connect: vi.fn(), disconnect: vi.fn() }
    ctx.createConstantSource = () => bend
    ctx.createOscillator = () => ({ frequency: { value: 0 }, connect: vi.fn(), disconnect: vi.fn(), start: vi.fn(), stop: vi.fn() })
    const realCreateGain = ctx.createGain
    let gainCalls = 0
    ctx.createGain = () => (gainCalls++ === 0 ? vibrato : realCreateGain())
    const realCreateBufferSource = ctx.createBufferSource
    ctx.createBufferSource = () => {
      const source = realCreateBufferSource()
      source.detune = { value: 0 }
      return source
    }
    const inst = sampleInstrumentFor(patch, { ctx, output, sampleStore: { get: vi.fn(() => Promise.resolve({})) } })
    inst.noteOn(72, 64)
    await Promise.resolve(); await Promise.resolve()
    expect(bend.connect).toHaveBeenCalledWith(sources[0].detune)
    expect(vibrato.connect).toHaveBeenCalledWith(sources[0].detune)
  })

  it('dispose leaves the shared bend/vibrato sources stopped and disconnected', async () => {
    const { ctx, output } = setup()
    const bend = { offset: { value: 0, setValueAtTime: vi.fn() }, connect: vi.fn(), disconnect: vi.fn(), start: vi.fn(), stop: vi.fn() }
    const osc = { frequency: { value: 0 }, connect: vi.fn(), disconnect: vi.fn(), start: vi.fn(), stop: vi.fn() }
    const vibrato = { gain: { value: 0, setValueAtTime: vi.fn() }, connect: vi.fn(), disconnect: vi.fn() }
    ctx.createConstantSource = () => bend
    ctx.createOscillator = () => osc
    const realCreateGain = ctx.createGain
    let gainCalls = 0
    ctx.createGain = () => (gainCalls++ === 0 ? vibrato : realCreateGain())
    const inst = sampleInstrumentFor(patch, { ctx, output, sampleStore: { get: vi.fn(() => Promise.resolve({})) } })
    inst.dispose()
    expect(bend.stop).toHaveBeenCalled()
    expect(bend.disconnect).toHaveBeenCalled()
    expect(osc.stop).toHaveBeenCalled()
    expect(osc.disconnect).toHaveBeenCalled()
    expect(vibrato.disconnect).toHaveBeenCalled()
  })
})
