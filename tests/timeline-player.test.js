import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock AudioEngine
vi.mock('../src/renderer/js/audio-engine.js', () => {
  const sources = []
  const mockCtx = {
    currentTime: 0,
    createBufferSource() {
      const src = {
        buffer: null,
        _startArgs: null,
        start: vi.fn(function(when, offset, duration) { this._startArgs = { when, offset, duration } }),
        stop: vi.fn(),
        connect: vi.fn(),
      }
      sources.push(src)
      return src
    }
  }
  return {
    default: {
      getContext: vi.fn(() => mockCtx),
      getMasterInput: vi.fn(() => ({ connect: vi.fn() })),
      init: vi.fn()
    },
    _mockCtx: mockCtx,
    _mockSources: sources
  }
})

vi.mock('../src/renderer/js/utils/timeline-math.js', async () => {
  const actual = await vi.importActual('../src/renderer/js/utils/timeline-math.js')
  return actual
})

vi.mock('../src/renderer/js/utils/wav-encoder.js', () => ({
  audioBufferToWAV: vi.fn(() => new ArrayBuffer(44))
}))

import TimelinePlayer from '../src/renderer/js/playback/timeline-player.js'

function makeAudioStore(buffers = {}) {
  return {
    getBuffer: vi.fn(key => buffers[key] ?? null)
  }
}

function makeMixerEngine() {
  return {
    getOutput: vi.fn(() => ({ connect: vi.fn() }))
  }
}

function makeAudioBuf(length = 1024, sampleRate = 44100) {
  return { duration: length / sampleRate, length, sampleRate, numberOfChannels: 2 }
}

beforeEach(() => {
  TimelinePlayer.stop()
  TimelinePlayer._sources = []
  TimelinePlayer._startBeat = 0
  TimelinePlayer._isPlaying = false
})

describe('TimelinePlayer.play', () => {
  it('does not throw with empty tracks', () => {
    expect(() => TimelinePlayer.play({ beat: 0, bpm: 120, tracks: [], audioStore: makeAudioStore(), mixerEngine: makeMixerEngine() })).not.toThrow()
  })

  it('does not schedule clip with no loaded buffer', () => {
    const tracks = [{ type: 'audio', mixerChannelId: 'ch-1', clips: [
      { type: 'audio', file: 'audio/missing.wav', startBeat: 0, duration: 4, offset: 0 }
    ]}]
    TimelinePlayer.play({ beat: 0, bpm: 120, tracks, audioStore: makeAudioStore({}), mixerEngine: makeMixerEngine() })
    expect(TimelinePlayer._sources.length).toBe(0)
  })

  it('schedules a clip that starts at beat 0', () => {
    const buf = makeAudioBuf(44100 * 2)  // 2 second buffer
    const tracks = [{ type: 'audio', mixerChannelId: 'ch-1', clips: [
      { type: 'audio', file: 'audio/a.wav', startBeat: 0, duration: 4, offset: 0 }
    ]}]
    TimelinePlayer.play({ beat: 0, bpm: 120, tracks, audioStore: makeAudioStore({ 'audio/a.wav': buf }), mixerEngine: makeMixerEngine() })
    expect(TimelinePlayer._sources.length).toBe(1)
  })

  it('does not schedule a clip that ends before the playhead', () => {
    const buf = makeAudioBuf(44100 * 2)
    const tracks = [{ type: 'audio', mixerChannelId: 'ch-1', clips: [
      { type: 'audio', file: 'audio/a.wav', startBeat: 0, duration: 4, offset: 0 }
    ]}]
    // Playhead at beat 8 — clip ends at beat 4
    TimelinePlayer.play({ beat: 8, bpm: 120, tracks, audioStore: makeAudioStore({ 'audio/a.wav': buf }), mixerEngine: makeMixerEngine() })
    expect(TimelinePlayer._sources.length).toBe(0)
  })

  it('skips non-audio tracks', () => {
    const tracks = [{ type: 'pattern', mixerChannelId: 'ch-1', clips: [] }]
    expect(() => TimelinePlayer.play({ beat: 0, bpm: 120, tracks, audioStore: makeAudioStore(), mixerEngine: makeMixerEngine() })).not.toThrow()
    expect(TimelinePlayer._sources.length).toBe(0)
  })
})

describe('TimelinePlayer.stop', () => {
  it('clears sources array', () => {
    TimelinePlayer._sources = [{ stop: vi.fn() }, { stop: vi.fn() }]
    TimelinePlayer.stop()
    expect(TimelinePlayer._sources.length).toBe(0)
  })

  it('sets isPlaying to false', () => {
    TimelinePlayer._isPlaying = true
    TimelinePlayer.stop()
    expect(TimelinePlayer._isPlaying).toBe(false)
  })
})

describe('TimelinePlayer.getCurrentBeat', () => {
  it('returns startBeat when not playing', () => {
    TimelinePlayer._isPlaying = false
    TimelinePlayer._startBeat = 4
    expect(TimelinePlayer.getCurrentBeat(120)).toBe(4)
  })
})

describe('TimelinePlayer.bounce', () => {
  it('returns an ArrayBuffer', async () => {
    const result = await TimelinePlayer.bounce({
      bpm: 120,
      tracks: [],
      audioStore: makeAudioStore(),
      durationBeats: 4,
      sampleRate: 44100
    })
    expect(result).toBeInstanceOf(ArrayBuffer)
  })
})
