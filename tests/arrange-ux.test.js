/**
 * QA tests for the arrange-ux feature branch.
 * Covers: new store actions, MIDI scheduling in TimelinePlayer,
 * and arrangement-view behaviour (scrolling, dblclick, context menu).
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'

// ─── Store action tests ───────────────────────────────────────────────────────

import ProjectStore, {
  AddTrack,
  AddClip,
  DuplicateClip,
  RemoveClip,
  TileClip,
  SetBpm,
  RemoveTrack,
} from '../src/renderer/js/store/ProjectStore.js'

describe('SetBpm', () => {
  beforeEach(() => ProjectStore.reset())

  it('sets BPM within valid range', () => {
    ProjectStore.dispatch(SetBpm(140))
    expect(ProjectStore.getState().bpm).toBe(140)
  })

  it('clamps BPM below 40 to 40', () => {
    ProjectStore.dispatch(SetBpm(10))
    expect(ProjectStore.getState().bpm).toBe(40)
  })

  it('clamps BPM above 240 to 240', () => {
    ProjectStore.dispatch(SetBpm(999))
    expect(ProjectStore.getState().bpm).toBe(240)
  })

  it('accepts boundary values 40 and 240', () => {
    ProjectStore.dispatch(SetBpm(40))
    expect(ProjectStore.getState().bpm).toBe(40)
    ProjectStore.dispatch(SetBpm(240))
    expect(ProjectStore.getState().bpm).toBe(240)
  })
})

describe('DuplicateClip', () => {
  let trackId, clipId

  beforeEach(() => {
    ProjectStore.reset()
    ProjectStore.dispatch(AddTrack('audio', 'Track A'))
    trackId = ProjectStore.getState().tracks[0].id
    ProjectStore.dispatch(AddClip(trackId, {
      id: 'clip-orig',
      type: 'audio',
      file: 'audio/a.wav',
      startBeat: 0,
      duration: 4,
      offset: 0,
    }))
    clipId = ProjectStore.getState().tracks[0].clips[0].id
  })

  it('adds a second clip to the track', () => {
    ProjectStore.dispatch(DuplicateClip(trackId, clipId))
    expect(ProjectStore.getState().tracks[0].clips.length).toBe(2)
  })

  it('duplicate starts immediately after the original', () => {
    ProjectStore.dispatch(DuplicateClip(trackId, clipId))
    const clips = ProjectStore.getState().tracks[0].clips
    const orig = clips.find(c => c.id === clipId)
    const copy = clips.find(c => c.id !== clipId)
    expect(copy.startBeat).toBe(orig.startBeat + orig.duration)
  })

  it('duplicate gets a new unique id', () => {
    ProjectStore.dispatch(DuplicateClip(trackId, clipId))
    const ids = ProjectStore.getState().tracks[0].clips.map(c => c.id)
    expect(new Set(ids).size).toBe(2)
  })

  it('duplicate preserves duration and file', () => {
    ProjectStore.dispatch(DuplicateClip(trackId, clipId))
    const clips = ProjectStore.getState().tracks[0].clips
    const copy = clips.find(c => c.id !== clipId)
    expect(copy.duration).toBe(4)
    expect(copy.file).toBe('audio/a.wav')
  })

  it('no-ops for unknown trackId', () => {
    ProjectStore.dispatch(DuplicateClip('bad-track', clipId))
    expect(ProjectStore.getState().tracks[0].clips.length).toBe(1)
  })

  it('no-ops for unknown clipId', () => {
    ProjectStore.dispatch(DuplicateClip(trackId, 'bad-clip'))
    expect(ProjectStore.getState().tracks[0].clips.length).toBe(1)
  })
})

describe('RemoveClip', () => {
  let trackId, clipId

  beforeEach(() => {
    ProjectStore.reset()
    ProjectStore.dispatch(AddTrack('audio', 'Track A'))
    trackId = ProjectStore.getState().tracks[0].id
    ProjectStore.dispatch(AddClip(trackId, {
      id: 'clip-x',
      type: 'audio',
      file: 'audio/x.wav',
      startBeat: 0,
      duration: 4,
      offset: 0,
    }))
    clipId = ProjectStore.getState().tracks[0].clips[0].id
  })

  it('removes the clip from the track', () => {
    ProjectStore.dispatch(RemoveClip(trackId, clipId))
    expect(ProjectStore.getState().tracks[0].clips.length).toBe(0)
  })

  it('track itself still exists after removing its only clip', () => {
    ProjectStore.dispatch(RemoveClip(trackId, clipId))
    expect(ProjectStore.getState().tracks.length).toBe(1)
  })

  it('no-ops for unknown clipId', () => {
    ProjectStore.dispatch(RemoveClip(trackId, 'nope'))
    expect(ProjectStore.getState().tracks[0].clips.length).toBe(1)
  })

  it('only removes the targeted clip when multiple clips exist', () => {
    ProjectStore.dispatch(AddClip(trackId, {
      id: 'clip-y', type: 'audio', file: 'audio/y.wav',
      startBeat: 4, duration: 4, offset: 0,
    }))
    expect(ProjectStore.getState().tracks[0].clips.length).toBe(2)
    ProjectStore.dispatch(RemoveClip(trackId, clipId))
    const remaining = ProjectStore.getState().tracks[0].clips
    expect(remaining.length).toBe(1)
    expect(remaining[0].id).not.toBe(clipId)
  })
})

describe('TileClip', () => {
  let trackId, clipId

  beforeEach(() => {
    ProjectStore.reset()
    ProjectStore.dispatch(AddTrack('audio', 'Track A'))
    trackId = ProjectStore.getState().tracks[0].id
    ProjectStore.dispatch(AddClip(trackId, {
      id: 'clip-tile',
      type: 'audio',
      file: 'audio/loop.wav',
      startBeat: 0,
      duration: 4,
      offset: 0,
    }))
    clipId = ProjectStore.getState().tracks[0].clips[0].id
  })

  it('fills to endBeat with repeated copies', () => {
    ProjectStore.dispatch(TileClip(trackId, clipId, 16))
    // Starts at 0, dur=4 → copies at 4, 8, 12 → total 4 clips
    expect(ProjectStore.getState().tracks[0].clips.length).toBe(4)
  })

  it('each copy starts exactly after the previous', () => {
    ProjectStore.dispatch(TileClip(trackId, clipId, 16))
    const beats = ProjectStore.getState().tracks[0].clips
      .map(c => c.startBeat)
      .sort((a, b) => a - b)
    expect(beats).toEqual([0, 4, 8, 12])
  })

  it('does not place a copy that would exceed endBeat', () => {
    // endBeat=10 with dur=4: copies at 4 and 8 fit, 12 > 10 so stops
    ProjectStore.dispatch(TileClip(trackId, clipId, 10))
    const clips = ProjectStore.getState().tracks[0].clips
    const maxEnd = Math.max(...clips.map(c => c.startBeat + c.duration))
    expect(maxEnd).toBeLessThanOrEqual(10)
  })

  it('no-ops when clip duration is 0', () => {
    ProjectStore.dispatch(AddClip(trackId, {
      id: 'clip-zero', type: 'audio', file: 'audio/z.wav',
      startBeat: 0, duration: 0, offset: 0,
    }))
    const zeroId = ProjectStore.getState().tracks[0].clips.at(-1).id
    const before = ProjectStore.getState().tracks[0].clips.length
    ProjectStore.dispatch(TileClip(trackId, zeroId, 64))
    expect(ProjectStore.getState().tracks[0].clips.length).toBe(before)
  })

  it('all copies share the same file and duration', () => {
    ProjectStore.dispatch(TileClip(trackId, clipId, 16))
    const clips = ProjectStore.getState().tracks[0].clips
    expect(clips.every(c => c.file === 'audio/loop.wav' && c.duration === 4)).toBe(true)
  })

  it('all copies have unique ids', () => {
    ProjectStore.dispatch(TileClip(trackId, clipId, 16))
    const ids = ProjectStore.getState().tracks[0].clips.map(c => c.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('RemoveTrack removes associated mixer channel', () => {
  beforeEach(() => ProjectStore.reset())

  it('mixer channel is removed alongside its track', () => {
    ProjectStore.dispatch(AddTrack('audio', 'Track B'))
    const state = ProjectStore.getState()
    const trackId = state.tracks[0].id
    const channelId = state.tracks[0].mixerChannelId
    expect(state.mixer.channels.find(c => c.id === channelId)).toBeTruthy()
    ProjectStore.dispatch(RemoveTrack(trackId))
    expect(ProjectStore.getState().mixer.channels.find(c => c.id === channelId)).toBeUndefined()
  })
})

// ─── TimelinePlayer MIDI scheduling ──────────────────────────────────────────

vi.mock('../src/renderer/js/audio-engine.js', () => {
  const mockCtx = { currentTime: 0 }
  return {
    default: {
      getContext: vi.fn(() => mockCtx),
      getMasterInput: vi.fn(() => ({ connect: vi.fn() })),
      init: vi.fn(),
    },
    _mockCtx: mockCtx,
  }
})
vi.mock('../src/renderer/js/utils/timeline-math.js', async () => {
  const actual = await vi.importActual('../src/renderer/js/utils/timeline-math.js')
  return actual
})
vi.mock('../src/renderer/js/utils/wav-encoder.js', () => ({
  audioBufferToWAV: vi.fn(() => new ArrayBuffer(44))
}))

if (typeof globalThis.OfflineAudioContext === 'undefined') {
  globalThis.OfflineAudioContext = class {
    constructor(ch, len, sr) { this.destination = {} }
    createBufferSource() { return { buffer: null, connect: vi.fn(), start: vi.fn() } }
    startRendering() {
      return Promise.resolve({
        numberOfChannels: 2, length: 1024, sampleRate: 44100,
        getChannelData: () => new Float32Array(1024),
      })
    }
  }
}

import TimelinePlayer from '../src/renderer/js/playback/timeline-player.js'

function makePalette() {
  const voice = { stop: vi.fn() }
  return {
    createVoice: vi.fn(() => voice),
    _voice: voice,
  }
}

function makeMixerEngine() {
  return { getOutput: vi.fn(() => ({ connect: vi.fn() })) }
}

describe('TimelinePlayer MIDI scheduling', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    TimelinePlayer.stop()
    TimelinePlayer._midiTimeouts = []
    TimelinePlayer._isPlaying = false
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('does not throw with an empty midi track', () => {
    const palette = makePalette()
    const tracks = [{ type: 'midi', paletteKey: 'classic', mixerChannelId: 'ch-1', clips: [] }]
    expect(() =>
      TimelinePlayer.play({
        beat: 0, bpm: 120, tracks,
        audioStore: { getBuffer: vi.fn() },
        mixerEngine: makeMixerEngine(),
        palettes: { classic: palette },
      })
    ).not.toThrow()
  })

  it('schedules a setTimeout for each note in a midi clip', () => {
    const palette = makePalette()
    const tracks = [{
      type: 'midi', paletteKey: 'classic', mixerChannelId: 'ch-1',
      clips: [{
        type: 'midi', startBeat: 0, duration: 4,
        notes: [
          { startBeat: 0, duration: 1, pitch: 60, velocity: 0.8 },
          { startBeat: 1, duration: 1, pitch: 62, velocity: 0.8 },
        ],
      }],
    }]
    TimelinePlayer.play({
      beat: 0, bpm: 120, tracks,
      audioStore: { getBuffer: vi.fn() },
      mixerEngine: makeMixerEngine(),
      palettes: { classic: palette },
    })
    expect(TimelinePlayer._midiTimeouts.length).toBe(2)
  })

  it('fires createVoice when the setTimeout callback runs', () => {
    const palette = makePalette()
    const tracks = [{
      type: 'midi', paletteKey: 'classic', mixerChannelId: 'ch-1',
      clips: [{
        type: 'midi', startBeat: 0, duration: 4,
        notes: [{ startBeat: 0, duration: 1, pitch: 69, velocity: 0.9 }],
      }],
    }]
    TimelinePlayer.play({
      beat: 0, bpm: 120, tracks,
      audioStore: { getBuffer: vi.fn() },
      mixerEngine: makeMixerEngine(),
      palettes: { classic: palette },
    })
    vi.runAllTimers()
    expect(palette.createVoice).toHaveBeenCalledOnce()
  })

  it('passes correct frequency for MIDI pitch 69 (A4 = 440 Hz)', () => {
    const palette = makePalette()
    const tracks = [{
      type: 'midi', paletteKey: 'classic', mixerChannelId: 'ch-1',
      clips: [{
        type: 'midi', startBeat: 0, duration: 4,
        notes: [{ startBeat: 0, duration: 1, pitch: 69, velocity: 0.8 }],
      }],
    }]
    TimelinePlayer.play({
      beat: 0, bpm: 120, tracks,
      audioStore: { getBuffer: vi.fn() },
      mixerEngine: makeMixerEngine(),
      palettes: { classic: palette },
    })
    vi.runAllTimers()
    const freq = palette.createVoice.mock.calls[0][2]
    expect(freq).toBeCloseTo(440, 1)
  })

  it('skips notes that have already passed the playhead', () => {
    const palette = makePalette()
    const tracks = [{
      type: 'midi', paletteKey: 'classic', mixerChannelId: 'ch-1',
      clips: [{
        type: 'midi', startBeat: 0, duration: 4,
        notes: [{ startBeat: 0, duration: 1, pitch: 60, velocity: 0.8 }],
      }],
    }]
    // Playhead at beat 8; note ends at beat 1 — already past
    TimelinePlayer.play({
      beat: 8, bpm: 120, tracks,
      audioStore: { getBuffer: vi.fn() },
      mixerEngine: makeMixerEngine(),
      palettes: { classic: palette },
    })
    vi.runAllTimers()
    expect(palette.createVoice).not.toHaveBeenCalled()
  })

  it('stop() clears all pending midi timeouts', () => {
    const palette = makePalette()
    const tracks = [{
      type: 'midi', paletteKey: 'classic', mixerChannelId: 'ch-1',
      clips: [{
        type: 'midi', startBeat: 0, duration: 4,
        notes: [
          { startBeat: 0, duration: 1, pitch: 60, velocity: 0.8 },
          { startBeat: 2, duration: 1, pitch: 62, velocity: 0.8 },
        ],
      }],
    }]
    TimelinePlayer.play({
      beat: 0, bpm: 120, tracks,
      audioStore: { getBuffer: vi.fn() },
      mixerEngine: makeMixerEngine(),
      palettes: { classic: palette },
    })
    expect(TimelinePlayer._midiTimeouts.length).toBe(2)
    TimelinePlayer.stop()
    expect(TimelinePlayer._midiTimeouts.length).toBe(0)
    vi.runAllTimers()
    expect(palette.createVoice).not.toHaveBeenCalled()
  })

  it('does not fire voices after stop() even if timers run', () => {
    const palette = makePalette()
    const tracks = [{
      type: 'midi', paletteKey: 'classic', mixerChannelId: 'ch-1',
      clips: [{
        type: 'midi', startBeat: 0, duration: 4,
        notes: [{ startBeat: 0, duration: 1, pitch: 60, velocity: 0.8 }],
      }],
    }]
    TimelinePlayer.play({
      beat: 0, bpm: 120, tracks,
      audioStore: { getBuffer: vi.fn() },
      mixerEngine: makeMixerEngine(),
      palettes: { classic: palette },
    })
    TimelinePlayer.stop()
    vi.runAllTimers()
    // _isPlaying guard in the callback should prevent voice creation
    expect(palette.createVoice).not.toHaveBeenCalled()
  })

  it('uses getMasterInput when no mixerEngine is provided', () => {
    const palette = makePalette()
    const tracks = [{
      type: 'midi', paletteKey: 'classic', mixerChannelId: 'ch-1',
      clips: [{
        type: 'midi', startBeat: 0, duration: 4,
        notes: [{ startBeat: 0, duration: 1, pitch: 60, velocity: 0.8 }],
      }],
    }]
    expect(() =>
      TimelinePlayer.play({
        beat: 0, bpm: 120, tracks,
        audioStore: { getBuffer: vi.fn() },
        palettes: { classic: palette },
      })
    ).not.toThrow()
  })

  it('skips midi track when palette key is unknown', () => {
    const tracks = [{
      type: 'midi', paletteKey: 'ghost', mixerChannelId: 'ch-1',
      clips: [{
        type: 'midi', startBeat: 0, duration: 4,
        notes: [{ startBeat: 0, duration: 1, pitch: 60, velocity: 0.8 }],
      }],
    }]
    expect(() =>
      TimelinePlayer.play({
        beat: 0, bpm: 120, tracks,
        audioStore: { getBuffer: vi.fn() },
        mixerEngine: makeMixerEngine(),
        palettes: { classic: makePalette() },
      })
    ).not.toThrow()
    expect(TimelinePlayer._midiTimeouts.length).toBe(0)
  })
})
