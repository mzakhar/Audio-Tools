/**
 * palette-state.test.js
 * Phase 0+1 of specs/palette-state.md: params live on the instrument, not on
 * the shared palette object.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import Palettes, { paletteDefaults, clampPaletteParam } from '../src/renderer/js/palettes.js'
import ProjectStore, { AddTrack, SetTrackInstrument, SetInstrumentParam, migrate, CURRENT_VERSION } from '../src/renderer/js/store/ProjectStore.js'

// jsdom doesn't provide OfflineAudioContext — supply a minimal stub, same
// shape as tests/timeline-player.test.js.
if (typeof globalThis.OfflineAudioContext === 'undefined') {
  globalThis.OfflineAudioContext = class {
    constructor(channels, length, sampleRate) {
      this.channels = channels; this.length = length; this.sampleRate = sampleRate
      this.destination = {}
    }
    createBufferSource() {
      return { buffer: null, connect: vi.fn(), start: vi.fn() }
    }
    startRendering() {
      return Promise.resolve({ numberOfChannels: 2, length: this.length, sampleRate: this.sampleRate,
        getChannelData: () => new Float32Array(this.length) })
    }
  }
}

import TimelinePlayer from '../src/renderer/js/playback/timeline-player.js'

beforeEach(() => ProjectStore.reset())

describe('paletteDefaults', () => {
  it('returns a fresh copy — mutating it never touches the palette definition', () => {
    const a = paletteDefaults('classic')
    a.cutoff = 1
    const b = paletteDefaults('classic')
    expect(b.cutoff).not.toBe(1)
    expect(Palettes.classic.params.cutoff).not.toBe(1)
  })

  it('falls back to classic for an unknown key', () => {
    expect(paletteDefaults('nope')).toEqual(paletteDefaults('classic'))
  })
})

describe('clampPaletteParam', () => {
  it('rejects a key the palette does not declare', () => {
    expect(clampPaletteParam('classic', 'nope', 1)).toBeUndefined()
  })

  it('clamps a knob value to its min/max', () => {
    expect(clampPaletteParam('classic', 'resonance', 999)).toBe(20)
    expect(clampPaletteParam('classic', 'resonance', -5)).toBe(0.1)
  })

  it('rejects a selector value outside its options', () => {
    expect(clampPaletteParam('classic', 'waveform', 'square')).toBe('square')
    expect(clampPaletteParam('classic', 'waveform', 'nonsense')).toBeUndefined()
  })
})

describe('SetInstrumentParam', () => {
  function armedMidiTrack(paletteKey = 'classic') {
    ProjectStore.dispatch(AddTrack('midi', 'Lead'))
    const trackId = ProjectStore.getState().tracks.at(-1).id
    ProjectStore.dispatch(SetTrackInstrument(trackId, { type: 'palette', paletteKey }))
    return trackId
  }

  it('rejects an undeclared key — state is unchanged', () => {
    const trackId = armedMidiTrack()
    const before = ProjectStore.getState()
    ProjectStore.dispatch(SetInstrumentParam(trackId, 'nope', 1))
    expect(ProjectStore.getState()).toEqual(before)
  })

  it('clamps a knob to its range', () => {
    const trackId = armedMidiTrack()
    ProjectStore.dispatch(SetInstrumentParam(trackId, 'resonance', 999))
    const track = ProjectStore.getState().tracks.find(t => t.id === trackId)
    expect(track.instrument.params.resonance).toBe(20)
  })

  it('rejects a selector value outside options — leaves the old value', () => {
    const trackId = armedMidiTrack()
    ProjectStore.dispatch(SetInstrumentParam(trackId, 'waveform', 'nonsense'))
    const track = ProjectStore.getState().tracks.find(t => t.id === trackId)
    expect(track.instrument.params.waveform).toBe(paletteDefaults('classic').waveform)
  })

  it('two tracks on the same palette hold different params', () => {
    const t1 = armedMidiTrack()
    const t2 = armedMidiTrack()
    ProjectStore.dispatch(SetInstrumentParam(t1, 'resonance', 5))
    ProjectStore.dispatch(SetInstrumentParam(t2, 'resonance', 15))
    const state = ProjectStore.getState()
    expect(state.tracks.find(t => t.id === t1).instrument.params.resonance).toBe(5)
    expect(state.tracks.find(t => t.id === t2).instrument.params.resonance).toBe(15)
  })
})

describe('migrate v5 → v6', () => {
  it('backfills defaults for a palette instrument missing params', () => {
    const v5 = {
      version: 5,
      tracks: [{ id: 't1', type: 'midi', instrument: { type: 'palette', paletteKey: 'fm' } }],
    }
    const next = migrate(v5)
    expect(next.version).toBe(CURRENT_VERSION)
    expect(next.tracks[0].instrument.params).toEqual(paletteDefaults('fm'))
  })

  it('falls back an unknown paletteKey to classic', () => {
    const v5 = {
      version: 5,
      tracks: [{ id: 't1', type: 'midi', instrument: { type: 'palette', paletteKey: 'vaporwave' } }],
    }
    const next = migrate(v5)
    expect(next.tracks[0].instrument.paletteKey).toBe('classic')
    expect(next.tracks[0].instrument.params).toEqual(paletteDefaults('classic'))
  })

  it('prunes undeclared keys and fills missing ones from defaults', () => {
    const v5 = {
      version: 5,
      tracks: [{
        id: 't1', type: 'midi',
        instrument: { type: 'palette', paletteKey: 'classic', params: { cutoff: 999, ghostKey: 'x' } },
      }],
    }
    const next = migrate(v5)
    const params = next.tracks[0].instrument.params
    expect(params.cutoff).toBe(999)
    expect(params).not.toHaveProperty('ghostKey')
    expect(params.resonance).toBe(paletteDefaults('classic').resonance)
  })
})

describe('createVoice without a params argument', () => {
  function makeCtx() {
    const param = () => ({ value: 0, setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn(), cancelScheduledValues: vi.fn() })
    const node = extra => ({ connect: vi.fn(), disconnect: vi.fn(), ...extra })
    const source = extra => node({ start: vi.fn(), stop: vi.fn(), onended: null, ...extra })
    return {
      currentTime: 0,
      createGain: () => node({ gain: param() }),
      createBiquadFilter: () => node({ type: 'lowpass', frequency: param(), Q: param() }),
      createOscillator: () => source({ type: 'sine', frequency: param(), detune: param() }),
    }
  }

  it('falls back to the palette defaults', () => {
    const ctx = makeCtx()
    const output = ctx.createGain()
    const voice = Palettes.classic.createVoice(ctx, output, 440, 1, 0)
    expect(() => voice.stop(0.1)).not.toThrow()
  })
})

describe('offline bounce threads a track\'s params into createVoice', () => {
  it('passes the non-default patch, not the palette default', async () => {
    const createVoice = vi.fn(() => ({ stop: vi.fn() }))
    const fakePalette = { type: 'melodic', createVoice }
    const customParams = { ...paletteDefaults('classic'), cutoff: 42 }

    await TimelinePlayer.bounce({
      bpm: 120,
      tracks: [{
        type: 'midi',
        instrument: { type: 'palette', paletteKey: 'classic', params: customParams },
        clips: [{
          type: 'midi', startBeat: 0, duration: 4,
          notes: [{ startBeat: 0, duration: 1, pitch: 69, velocity: 0.9 }],
        }],
      }],
      audioStore: { getBuffer: vi.fn() },
      durationBeats: 4,
      sampleRate: 44100,
      palettes: { classic: fakePalette },
    })

    expect(createVoice).toHaveBeenCalledOnce()
    expect(createVoice.mock.calls[0][5]).toEqual(customParams)
  })
})
