import { describe, it, expect, vi } from 'vitest'
import { sampleIdOf, createUserSamples, userSampleStoreFor } from '../src/renderer/js/instruments/user-samples.js'
import { sampleSlot, sliceSlots, slotLabel, padColours, kitFor } from '../src/renderer/js/pads/kit.js'
import { kitInstrument } from '../src/renderer/js/pads/kit-voices.js'

// Tiny in-memory IndexedDB: just enough of open/transaction/objectStore/put/get.
function fakeIdb() {
  const data = new Map()
  const req = fn => { const r = {}; queueMicrotask(() => { r.result = fn(); r.onsuccess?.() }); return r }
  const store = tx => ({
    put(value, key) { return req(() => { data.set(key, value); queueMicrotask(() => tx.oncomplete?.()) }) },
    get(key) { return req(() => data.get(key)) }
  })
  const db = {
    objectStoreNames: { contains: () => true },
    createObjectStore() {},
    transaction() { const tx = {}; tx.objectStore = () => store(tx); return tx }
  }
  return { data, open() { const r = { result: db }; queueMicrotask(() => { r.onupgradeneeded?.({ target: r }); r.onsuccess?.() }); return r } }
}

const bytes = (...n) => new Uint8Array(n).buffer

describe('sampleIdOf', () => {
  it('is stable and distinguishes content and length', () => {
    expect(sampleIdOf(bytes(1, 2, 3))).toBe(sampleIdOf(bytes(1, 2, 3)))
    expect(sampleIdOf(bytes(1, 2, 3))).not.toBe(sampleIdOf(bytes(1, 2, 4)))
    expect(sampleIdOf(bytes(0))).not.toBe(sampleIdOf(bytes(0, 0)))
    expect(sampleIdOf(bytes(1, 2, 3))).toMatch(/^smp-[0-9a-f]{16}-3$/)
  })
})

describe('createUserSamples', () => {
  it('put -> has/read round trip, deduped by id', async () => {
    const idb = fakeIdb()
    const us = createUserSamples({ idb })
    const a = await us.put({ name: 'a.wav', type: 'audio/wav', bytes: bytes(5, 6) })
    const b = await us.put({ name: 'b.wav', type: 'audio/wav', bytes: bytes(5, 6) })
    expect(a.id).toBe(b.id)
    expect(idb.data.size).toBe(1)
    expect(await us.has(a.id)).toBe(true)
    expect(await us.has('smp-nope')).toBe(false)
    expect(new Uint8Array(await us.read(a.id))).toEqual(new Uint8Array([5, 6]))
    expect(await us.read('smp-nope')).toBeNull()
  })

  it('without IndexedDB: put rejects no-storage, read resolves null', async () => {
    const us = createUserSamples({ idb: null })
    await expect(us.put({ name: 'x', type: '', bytes: bytes(1) })).rejects.toThrow('no-storage')
    expect(await us.read('x')).toBeNull()
  })
})

describe('kit sample helpers', () => {
  it('sliceSlots: 16 slots on 36..51, seconds, named', () => {
    const regions = Array.from({ length: 16 }, (_, i) => ({ start: i * 1000, end: (i + 1) * 1000 }))
    const slots = sliceSlots(regions, 1000, { sampleId: 'smp-1', name: 'loop' })
    expect(Object.keys(slots).map(Number)).toEqual(Array.from({ length: 16 }, (_, i) => 36 + i))
    expect(slots[37]).toEqual({ voice: 'sample', sampleId: 'smp-1', name: 'loop 2', start: 1, end: 2 })
  })

  it('slotLabel: voice, truncated sample name, dash', () => {
    expect(slotLabel({ voice: 'bd' })).toBe('BD')
    expect(slotLabel(sampleSlot({ sampleId: 's', name: 'amen-break', start: 0, end: 1 }))).toBe('amen-bre')
    expect(slotLabel(undefined)).toBe('—')
  })

  it('sample slots get an LED colour', () => {
    const kit = { slots: { 36: sampleSlot({ sampleId: 's', name: 'n', start: 0, end: 1 }) } }
    expect(padColours(kit)[0]).toEqual([255, 0, 140])
  })
})

function makeCtx() {
  const param = () => ({ value: 0, setValueAtTime: vi.fn(), setTargetAtTime: vi.fn(), linearRampToValueAtTime: vi.fn(), cancelScheduledValues: vi.fn() })
  const node = extra => ({ connect: vi.fn(d => d), disconnect: vi.fn(), ...extra })
  const sources = [], gains = []
  return {
    sources, gains, currentTime: 0, sampleRate: 44100,
    createGain: () => { const g = node({ gain: param() }); gains.push(g); return g },
    createBufferSource: () => { const s = node({ playbackRate: param(), start: vi.fn(), stop: vi.fn() }); sources.push(s); return s },
    createBiquadFilter: () => node({ frequency: param(), Q: param(), gain: param(), detune: param() }),
    createWaveShaper: () => node({}),
    createOscillator: () => node({ frequency: param(), detune: param(), start: vi.fn(), stop: vi.fn() }),
    createBuffer: (ch, len) => ({ getChannelData: () => new Float32Array(len) })
  }
}

describe('kitInstrument sample voice', () => {
  const buffer = { duration: 4, sampleRate: 44100, length: 176400, numberOfChannels: 1 }
  const kit = {
    id: 'k',
    slots: {
      36: sampleSlot({ sampleId: 'smp-a', name: 'a', start: 1, end: 2 }),
      37: { ...sampleSlot({ sampleId: 'smp-gone', name: 'g', start: 0, end: 1 }) },
      38: { ...sampleSlot({ sampleId: 'smp-a', name: 'a', start: 0, end: 1 }), group: 'g' },
      39: { ...sampleSlot({ sampleId: 'smp-a', name: 'a', start: 0, end: 3 }), group: 'g', open: true }
    }
  }
  const store = () => ({
    peek: vi.fn(id => (id === 'smp-a' ? buffer : null)),
    get: vi.fn(id => (id === 'smp-a' ? Promise.resolve(buffer) : Promise.reject(new Error('missing'))))
  })

  it('plays the region as a one-shot at the hit time', () => {
    const ctx = makeCtx()
    const inst = kitInstrument(kit, { ctx, output: ctx.createGain(), sampleStore: store() })
    inst.hit(36, 1, 2)
    expect(ctx.sources[0].start).toHaveBeenCalledWith(2, 1, 1)
    expect(ctx.sources[0].buffer).toBe(buffer)
  })

  it('tune shifts rate; level scales gain; decayMul shortens the tail', () => {
    const ctx = makeCtx()
    const inst = kitInstrument(kit, { ctx, output: ctx.createGain(), sampleStore: store() })
    inst.hit(36, 1, 0, { tuneSt: 12, decayMul: 0.5, level: 0.5 })
    expect(ctx.sources[0].playbackRate.value).toBe(2)
    // region 1 s, rate 2 -> 0.5 s, decay 0.5 -> 0.25 s of ctx time, 0.5 s of buffer
    const [, , dur] = ctx.sources[0].start.mock.calls[0]
    expect(dur).toBeCloseTo(0.5)
    expect(ctx.sources[0].stop.mock.calls[0][0]).toBeCloseTo(0.26)
  })

  it('a miss is silent and kicks a load; a failed load does not throw', async () => {
    const ctx = makeCtx(), s = store()
    const inst = kitInstrument(kit, { ctx, output: ctx.createGain(), sampleStore: s })
    expect(() => inst.hit(37, 1, 0)).not.toThrow()
    expect(ctx.sources.length).toBe(0)
    expect(s.get).toHaveBeenCalledWith('smp-gone')
    await Promise.resolve()
  })

  it('no sampleStore: sample slot is silent', () => {
    const ctx = makeCtx()
    kitInstrument(kit, { ctx, output: ctx.createGain() }).hit(36, 1, 0)
    expect(ctx.sources.length).toBe(0)
  })

  it('choke: a closed sample hit ducks the open sample in its group', () => {
    const ctx = makeCtx()
    const inst = kitInstrument(kit, { ctx, output: ctx.createGain(), sampleStore: store() })
    inst.hit(39, 1, 0)
    const openGain = ctx.gains.at(-2) // the open voice's own group gain (then its envelope gain)
    inst.hit(38, 1, 1)
    expect(openGain.gain.setTargetAtTime).toHaveBeenCalled()
  })

  it('prewarm preloads the distinct sample ids and survives a missing one', async () => {
    const ctx = makeCtx(), s = store()
    await kitInstrument(kit, { ctx, output: ctx.createGain(), sampleStore: s }).prewarm()
    expect(s.get.mock.calls.map(c => c[0]).sort()).toEqual(['smp-a', 'smp-gone'])
  })

  it('default-909 prewarm still resolves', async () => {
    const ctx = makeCtx()
    await expect(kitInstrument(kitFor('default-909'), { ctx, output: ctx.createGain() }).prewarm()).resolves.toBeUndefined()
  })
})

describe('userSampleStoreFor', () => {
  it('one store per ctx; null without decodeAudioData', () => {
    const ctx = { decodeAudioData: vi.fn() }
    expect(userSampleStoreFor(ctx)).toBe(userSampleStoreFor(ctx))
    expect(userSampleStoreFor({})).toBeNull()
  })
})


describe('put dedupe', () => {
  it('put skips the write when the id exists', async () => {
    const idb = fakeIdb()
    const us = createUserSamples({ idb })
    await us.put({ name: 'a', type: 'audio/wav', bytes: bytes(5, 6) })
    const key = sampleIdOf(bytes(5, 6))
    const before = idb.data.get(key)
    await us.put({ name: 'other', type: 'audio/wav', bytes: bytes(5, 6) })
    expect(idb.data.get(key)).toBe(before)
  })
})
