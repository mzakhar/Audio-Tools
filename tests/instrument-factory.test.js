import { describe, expect, it, vi } from 'vitest'
import { instrumentFor, liveInstrumentFor } from '../src/renderer/js/midi/live-instrument.js'

// A fake context in the shape the rack and sample-instrument tests already use.
function fakeCtx() {
  const sources = []
  return {
    sources,
    ctx: {
      currentTime: 1,
      createBufferSource: () => {
        const source = { started: false, stopped: false, connect: vi.fn(), disconnect: vi.fn(), playbackRate: { value: 1 },
          start() { this.started = true }, stop() { this.stopped = true } }
        sources.push(source)
        return source
      },
      createGain: () => ({ connect: vi.fn(), disconnect: vi.fn(), gain: { setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn(), setTargetAtTime: vi.fn(), cancelScheduledValues: vi.fn() } })
    }
  }
}

function paletteDeps() {
  const voices = []
  const palettes = {
    classic: {
      name: 'Classic',
      createVoice: vi.fn(() => {
        const voice = { stopped: false, stop() { this.stopped = true }, setBend: vi.fn(), setMod: vi.fn() }
        voices.push(voice)
        return voice
      })
    },
    drum: { name: 'Drum', createVoice: vi.fn(() => ({ stop: vi.fn() })) } // no setBend/setMod
  }
  const { ctx } = fakeCtx()
  return { voices, palettes, deps: { palettes, ctx, output: {} } }
}

const patch = { id: 'piano', zones: [{ keyLo: 0, keyHi: 127, rootKey: 60, sampleId: 'a' }] }
const pack = { id: 'gm', version: '1', byId: new Map([['piano', patch]]) }

function packDeps() {
  const { ctx, sources } = fakeCtx()
  return {
    sources,
    deps: {
      ctx,
      output: {},
      packFor: (id, version) => (id === 'gm' && version === '1' ? pack : null),
      sampleStoreFor: () => ({ get: () => Promise.resolve({}), preload: () => Promise.resolve() })
    }
  }
}

describe('instrumentFor', () => {
  it('builds a playable instrument from a palette descriptor', () => {
    const { voices, deps } = paletteDeps()
    const inst = instrumentFor({ type: 'palette', paletteKey: 'classic' }, deps)
    inst.noteOn(60, 100)
    expect(voices).toHaveLength(1)
    inst.noteOff(60)
    expect(voices[0].stopped).toBe(true)
  })

  it('builds a playable instrument from a pack descriptor', async () => {
    const { sources, deps } = packDeps()
    const inst = instrumentFor({ type: 'pack', packId: 'gm', packVersion: '1', patchId: 'piano' }, deps)
    inst.noteOn(60, 100)
    await Promise.resolve(); await Promise.resolve()
    expect(sources[0].started).toBe(true)
  })

  it('builds a playable instrument from a rack descriptor', () => {
    const onEvent = vi.fn()
    const handle = { mods: new Map([['m1', { def: { type: 'midi-in' }, inst: { onEvent } }]]), nodes: new Map(), cables: [] }
    const deps = { ctx: { currentTime: 0 }, racks: { r1: { id: 'r1' } }, mountRack: vi.fn(() => handle) }
    const inst = instrumentFor({ type: 'rack', rackId: 'r1' }, deps)
    inst.noteOn(60, 100)
    expect(deps.mountRack).toHaveBeenCalledOnce()
    expect(onEvent).toHaveBeenCalledWith('note', { type: 'note-on', note: 60, velocity: 100, time: 0 })
    inst.noteOff(60)
    expect(onEvent).toHaveBeenLastCalledWith('note', { type: 'note-off', note: 60, time: 0 })
  })

  it('returns null for a rack that is gone and a pack with no sample store', () => {
    expect(instrumentFor({ type: 'rack', rackId: 'nope' }, { racks: {} })).toBeNull()
    expect(instrumentFor({ type: 'pack', packId: 'gm', packVersion: '1', patchId: 'piano' }, { packFor: () => pack, sampleStoreFor: () => null })).toBeNull()
  })

  it('scales pitch bend by the descriptor bend range and defaults to 2', () => {
    const { voices, deps } = paletteDeps()
    const wide = instrumentFor({ type: 'palette', paletteKey: 'classic', bendRange: 12 }, deps)
    wide.noteOn(60, 100)
    wide.send({ type: 'pitch-bend', value: 0.5 })
    expect(voices[0].setBend).toHaveBeenCalledWith(6)

    const plain = instrumentFor({ type: 'palette', paletteKey: 'classic' }, deps)
    plain.noteOn(64, 100)
    plain.send({ type: 'pitch-bend', value: -1 })
    expect(voices[1].setBend).toHaveBeenCalledWith(-2)
  })

  it('applies the standing bend to a note struck after the wheel moved', () => {
    const { voices, deps } = paletteDeps()
    const inst = instrumentFor({ type: 'palette', paletteKey: 'classic' }, deps)
    inst.send({ type: 'pitch-bend', value: 1 })
    inst.noteOn(60, 100)
    expect(voices[0].setBend).toHaveBeenCalledWith(2)
  })

  it('sends mod unless the descriptor turns it off, and never throws on drum voices', () => {
    const { voices, deps } = paletteDeps()
    const inst = instrumentFor({ type: 'palette', paletteKey: 'classic' }, deps)
    inst.noteOn(60, 100)
    inst.send({ type: 'mod', value: 0.5 })
    expect(voices[0].setMod).toHaveBeenCalledWith(0.5)

    const off = instrumentFor({ type: 'palette', paletteKey: 'classic', modDest: 'off' }, deps)
    off.noteOn(62, 100)
    off.send({ type: 'mod', value: 0.5 })
    expect(voices[1].setMod).not.toHaveBeenCalled()

    const drums = instrumentFor({ type: 'palette', paletteKey: 'drum' }, deps)
    drums.noteOn(36, 100)
    expect(() => drums.send({ type: 'pitch-bend', value: 1 })).not.toThrow()
  })

  it('a repeat note-on on a drum pitch with no note-off between produces a second voice', () => {
    const drumVoices = []
    const palettes = {
      drum: {
        type: 'drum',
        createDrumVoice: vi.fn(() => {
          const voice = { stop: vi.fn() }
          drumVoices.push(voice)
          return voice
        })
      }
    }
    const { ctx } = fakeCtx()
    const inst = instrumentFor({ type: 'palette', paletteKey: 'drum' }, { palettes, ctx, output: {} })
    inst.noteOn(36, 100)
    inst.noteOn(36, 100)
    expect(drumVoices).toHaveLength(2)
  })

  it('leaves no source running after dispose', async () => {
    const { sources, deps } = packDeps()
    const inst = instrumentFor({ type: 'pack', packId: 'gm', packVersion: '1', patchId: 'piano' }, deps)
    inst.noteOn(60, 100)
    await Promise.resolve(); await Promise.resolve()
    inst.dispose()
    expect(sources.every(source => source.stopped)).toBe(true)

    const palette = paletteDeps()
    const voiced = instrumentFor({ type: 'palette', paletteKey: 'classic' }, palette.deps)
    voiced.noteOn(60, 100)
    voiced.dispose()
    expect(palette.voices.every(voice => voice.stopped)).toBe(true)
  })

  it('liveInstrumentFor is the same factory, fed from a track', () => {
    const { voices, deps } = paletteDeps()
    liveInstrumentFor({ instrument: { type: 'palette', paletteKey: 'classic' } }, deps).noteOn(60, 100)
    liveInstrumentFor({ paletteKey: 'classic' }, deps).noteOn(60, 100)
    expect(voices).toHaveLength(2)
  })
})
