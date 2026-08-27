import { describe, expect, it, vi } from 'vitest'
import { createSampleStore } from '../src/renderer/js/instruments/sample-store.js'

const buffer = (length, channels = 1) => ({ length, numberOfChannels: channels })

describe('sample store', () => {
  it('deduplicates decoding and evicts least recently used decoded buffers', async () => {
    const load = vi.fn(id => Promise.resolve(id))
    const ctx = { decodeAudioData: vi.fn(id => Promise.resolve(buffer(id === 'a' ? 4 : 8))) }
    const store = createSampleStore({ load, ctx, maxBytes: 32 })
    await store.get('a')
    await store.get('a')
    await store.get('b')
    expect(load).toHaveBeenCalledTimes(2)
    expect(store.size).toBe(1)
    expect(store.bytes).toBe(32)
    await store.get('a')
    expect(load).toHaveBeenCalledTimes(3)
  })

  it('shares an in-flight load', async () => {
    let finish
    const load = vi.fn(() => new Promise(resolve => { finish = resolve }))
    const ctx = { decodeAudioData: vi.fn(() => Promise.resolve(buffer(1))) }
    const store = createSampleStore({ load, ctx })
    const first = store.get('kick'), second = store.get('kick')
    expect(first).toBe(second)
    finish(new ArrayBuffer(1))
    await expect(first).resolves.toEqual(buffer(1))
    expect(load).toHaveBeenCalledTimes(1)
  })
})
