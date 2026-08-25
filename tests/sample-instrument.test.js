import { describe, expect, it, vi } from 'vitest'
import { sampleInstrumentFor } from '../src/renderer/js/instruments/sample-instrument.js'

function setup() {
  const sources = []
  const ctx = {
    currentTime: 3,
    createBufferSource: () => {
      const source = { connect: vi.fn(), disconnect: vi.fn(), start: vi.fn(), stop: vi.fn(), playbackRate: { value: 0 } }
      sources.push(source)
      return source
    },
    createGain: () => ({ connect: vi.fn(), disconnect: vi.fn(), gain: { setValueAtTime: vi.fn() } })
  }
  return { ctx, sources, output: {} }
}

const patch = { zones: [
  { keyLo: 0, keyHi: 60, rootKey: 60, sampleId: 'low', velocityHi: 100 },
  { keyLo: 61, keyHi: 127, rootKey: 72, sampleId: 'high' }
] }

describe('sample instrument', () => {
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

  it('cancels a note released before its sample resolves', async () => {
    const { ctx, sources, output } = setup()
    let done
    const inst = sampleInstrumentFor(patch, { ctx, output, sampleStore: { get: () => new Promise(resolve => { done = resolve }) } })
    inst.noteOn(60, 80)
    inst.noteOff(60)
    done({})
    await Promise.resolve(); await Promise.resolve()
    expect(sources).toHaveLength(0)
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
})
