/**
 * timeline-player.js
 * AudioClip playback scheduler + OfflineAudioContext bounce.
 */
import AudioEngine from '../audio-engine.js'
import RackEngine from '../rack/rack-engine.js'
import { RackClock } from '../rack/rack-clock.js'
import { beatsToSeconds } from '../utils/timeline-math.js'
import { audioBufferToWAV } from '../utils/wav-encoder.js'
import { sampleInstrumentFor } from '../instruments/sample-instrument.js'

// One note contract for both instrument kinds. Keep scheduling here; only
// delivery differs, so palette and rack timing cannot drift apart.
export function paletteInstrument(palette, ctx, output) {
  return (note, time, stopTime) => {
    const freq = 440 * Math.pow(2, (note.pitch - 69) / 12)
    const voice = palette.createVoice(ctx, output, freq, note.velocity ?? 0.8, time)
    voice.stop(stopTime)
  }
}

export function rackInstrument(handle, moduleId) {
  return (note, time, stopTime) => {
    RackEngine.sendEvent(handle, moduleId, 'note', { type: 'note-on', note: note.pitch, velocity: note.velocity ?? 0.8, time })
    RackEngine.sendEvent(handle, moduleId, 'note', { type: 'note-off', note: note.pitch, time: stopTime })
  }
}

/** Shared by the timeline and the step sequencer: one scheduled note contract. */
export function instrumentFor(track, { palettes, ctx, output, rackHandles, packFor, sampleStoreFor, packInstruments }) {
  const instrument = track.instrument || { type: 'palette', paletteKey: track.paletteKey || 'classic' }
  if (instrument.type === 'pack') {
    const pack = packFor?.(instrument.packId, instrument.packVersion)
    const patch = pack?.byId?.get(instrument.patchId)
    const sampleStore = patch && sampleStoreFor?.(pack, ctx)
    if (!sampleStore) return null
    const instance = sampleInstrumentFor(patch, { ctx, output, sampleStore })
    packInstruments?.push(instance)
    return (note, time, stopTime) => {
      instance.noteOn(note.pitch, (note.velocity ?? 0.8) * 127, time)
      const delay = Math.max(0, (stopTime - ctx.currentTime) * 1000)
      if (typeof ctx.startRendering === 'function') instance.noteOff(note.pitch, stopTime)
      else setTimeout(() => instance.noteOff(note.pitch), delay)
    }
  }
  if (instrument.type === 'rack') {
    const handle = rackHandles.find(entry => entry.rack.id === instrument.rackId)
    const moduleId = handle && [...handle.mods].find(([, entry]) => entry.def?.type === 'midi-in')?.[0]
    return moduleId ? rackInstrument(handle, moduleId) : null
  }
  if (instrument.type !== 'palette') return null
  const palette = palettes?.[instrument.paletteKey || track.paletteKey || 'classic']
  return palette ? paletteInstrument(palette, ctx, output) : null
}

const TimelinePlayer = {
  _sources: [],           // active AudioBufferSourceNode[]
  _midiTimeouts: [],      // setTimeout handles for MIDI note scheduling
  _startAudioTime: 0,     // AudioContext.currentTime when play() was called
  _startBeat: 0,          // beat at which playback started
  _isPlaying: false,
  _rackClock: null,
  _rackClockTimer: null,
  _instrumentRackHandles: [],
  _packInstruments: [],

  play({ beat = 0, bpm, tracks, audioStore, mixerEngine, palettes, rackHandles = [], racks = {}, packFor, sampleStoreFor }) {
    this.stop()  // cancel any previous playback

    const ctx = AudioEngine.getContext()
    if (!ctx) return

    this._startAudioTime = ctx.currentTime + 0.05  // 50ms scheduling offset
    this._startBeat = beat
    this._isPlaying = true
    this._sources = []
    this._midiTimeouts = []
    this._packInstruments = []
    this._instrumentRackHandles = tracks
      .filter(track => track.type === 'midi' && track.instrument?.type === 'rack')
      .map(track => ({ track, rack: racks[track.instrument.rackId] }))
      .filter(({ rack }) => rack)
      .map(({ track, rack }) => RackEngine.mount(ctx, rack, {
        output: mixerEngine ? mixerEngine.getOutput(track.mixerChannelId) : AudioEngine.getMasterInput(),
        getBuffer: fileKey => audioStore?.getBufferOrLoad?.(fileKey) ?? null,
        onParam: (target, value) => {
          const [channelId, param] = target.split('.')
          if (param === 'volume') mixerEngine?.setVolume(channelId, value)
          else if (param === 'pan') mixerEngine?.setPan(channelId, value)
        }
      }))
    rackHandles = [...rackHandles, ...this._instrumentRackHandles]

    const clocks = rackHandles.flatMap(handle => [...handle.mods].filter(([, entry]) =>
      entry.def?.type === 'clock' && entry.params?.source === 'transport'
    ).map(([moduleId]) => [handle, moduleId]))
    if (clocks.length) {
      const send = (portId, event) => clocks.forEach(([handle, moduleId]) => RackEngine.sendEvent(handle, moduleId, portId, event))
      send('run', { type: 'gate-on', time: this._startAudioTime })
      this._rackClock = new RackClock({ bpm, emit: event => send('ext', event) })
      this._rackClock.start(this._startAudioTime, bpm)
      const schedule = () => this._rackClock.scheduleThrough(ctx.currentTime + 0.1)
      schedule()
      this._rackClockTimer = setInterval(schedule, 25)
    }

    tracks.forEach(track => {
      // ── MIDI track scheduling ──────────────────────────────────────────────
      if (track.type === 'midi') {
        const channelId = track.mixerChannelId
        const output = mixerEngine ? mixerEngine.getOutput(channelId) : AudioEngine.getMasterInput()
        const playNote = instrumentFor(track, { palettes, ctx, output, rackHandles, packFor, sampleStoreFor, packInstruments: this._packInstruments })
        if (!playNote) return

        track.clips.forEach(clip => {
          if (clip.type !== 'midi') return
          const notes = clip.notes || []
          notes.forEach(note => {
            const noteBeat = clip.startBeat + note.startBeat
            if (noteBeat + note.duration <= beat) return   // already past

            const noteAudioTime = this._startAudioTime + beatsToSeconds(noteBeat - beat, bpm)
            const stopAudioTime = noteAudioTime + beatsToSeconds(note.duration, bpm)
            const msUntilNote   = Math.max(0, (noteAudioTime - ctx.currentTime) * 1000)

            const handle = setTimeout(() => {
              if (!this._isPlaying) return
              try {
                playNote(note, noteAudioTime, stopAudioTime)
              } catch (err) { /* voice creation errors are non-fatal */ }
            }, msUntilNote)

            this._midiTimeouts.push(handle)
          })
        })
        return
      }

      if (track.type !== 'audio') return
      const mixerChannelId = track.mixerChannelId
      const output = mixerEngine ? mixerEngine.getOutput(mixerChannelId) : AudioEngine.getMasterInput()

      track.clips.forEach(clip => {
        if (clip.type !== 'audio') return
        const buf = audioStore.getBuffer(clip.file)
        if (!buf) {
          console.warn('[TimelinePlayer] Buffer not loaded for', clip.file, '— clip skipped')
          return
        }

        // When does this clip end in beats?
        const clipEndBeat = clip.startBeat + clip.duration
        if (clipEndBeat <= beat) return  // clip already past

        // When does this clip start relative to our playhead?
        const beatOffset = clip.startBeat - beat
        const scheduleAt = this._startAudioTime + beatsToSeconds(beatOffset, bpm)

        // If clip started before playhead, start partway in
        let startOffset = beatsToSeconds(clip.offset || 0, bpm)
        let when = scheduleAt
        if (scheduleAt < ctx.currentTime) {
          // How far into the clip are we?
          const skipBeats = beat - clip.startBeat
          startOffset += beatsToSeconds(skipBeats, bpm)
          when = ctx.currentTime
        }

        const clipDuration = beatsToSeconds(clip.duration, bpm)
        // Remaining duration after accounting for skip
        const played = beatsToSeconds(Math.max(0, beat - clip.startBeat), bpm)
        const remainingDuration = clipDuration - played
        if (remainingDuration <= 0) return

        const src = ctx.createBufferSource()
        src.buffer = buf
        src.connect(output)
        src.start(when, startOffset, remainingDuration)
        this._sources.push(src)
      })
    })
  },

  stop() {
    this._isPlaying = false
    if (this._rackClockTimer !== null) clearInterval(this._rackClockTimer)
    this._rackClockTimer = null
    this._rackClock?.stop()
    this._rackClock = null
    this._instrumentRackHandles.forEach(handle => RackEngine.unmount(handle))
    this._instrumentRackHandles = []
    this._packInstruments.forEach(instrument => instrument.dispose())
    this._packInstruments = []
    this._sources.forEach(src => { try { src.stop() } catch (e) {} })
    this._sources = []
    this._midiTimeouts.forEach(id => clearTimeout(id))
    this._midiTimeouts = []
  },

  /** Public running state — the UI derives the transport button from this. */
  isPlaying() { return this._isPlaying },

  getCurrentBeat(bpm) {
    if (!this._isPlaying) return this._startBeat
    const ctx = AudioEngine.getContext()
    if (!ctx) return this._startBeat
    const elapsed = ctx.currentTime - this._startAudioTime
    return this._startBeat + (elapsed / (60 / bpm))
  },

  async bounce({ bpm, tracks, audioStore, durationBeats, sampleRate = 44100, racks = {}, packFor, sampleStoreFor }) {
    const totalSeconds = beatsToSeconds(durationBeats, bpm)
    const offline = new OfflineAudioContext(2, Math.ceil(totalSeconds * sampleRate), sampleRate)
    const startTime = 0.05

    // Bounce reads only what is already decoded: kicking off a load mid-render
    // would finish after the render did, and silently change take to take.
    const rackHandles = Object.values(racks).map(rack => RackEngine.mount(offline, rack, {
      output: offline.destination,
      getBuffer: fileKey => audioStore?.getBuffer?.(fileKey) ?? null
    }))
    const packInstruments = []
    const missing = []
    for (const track of tracks.filter(track => track.type === 'midi' && track.instrument?.type === 'pack')) {
      const pack = packFor?.(track.instrument.packId, track.instrument.packVersion)
      const patch = pack?.byId?.get(track.instrument.patchId)
      const store = patch && sampleStoreFor?.(pack, offline)
      if (!store) { missing.push(`${track.instrument.packId}@${track.instrument.packVersion}:${track.instrument.patchId}`); continue }
      try { await store.preload((patch.zones || []).map(zone => zone.sampleId)) } catch (error) { missing.push(error.message) }
    }
    if (missing.length) throw new Error(`Missing pack samples: ${missing.join(', ')}`)
    tracks.forEach(track => {
      if (track.type === 'midi') {
        const playNote = instrumentFor(track, { palettes: null, ctx: offline, output: offline.destination, rackHandles, packFor, sampleStoreFor, packInstruments })
        for (const clip of track.clips) for (const note of clip.notes || []) {
          if (clip.type !== 'midi') continue
          const at = startTime + beatsToSeconds(clip.startBeat + note.startBeat, bpm)
          playNote?.(note, at, at + beatsToSeconds(note.duration, bpm))
        }
        return
      }
      if (track.type !== 'audio') return
      track.clips.forEach(clip => {
        if (clip.type !== 'audio') return
        const buf = audioStore.getBuffer(clip.file)
        if (!buf) return

        const when = startTime + beatsToSeconds(clip.startBeat, bpm)
        const offset = beatsToSeconds(clip.offset || 0, bpm)
        const duration = beatsToSeconds(clip.duration, bpm)

        const src = offline.createBufferSource()
        src.buffer = buf
        src.connect(offline.destination)
        src.start(when, offset, duration)
      })
    })

    const rendered = await offline.startRendering()
    rackHandles.forEach(handle => RackEngine.unmount(handle))
    packInstruments.forEach(instrument => instrument.dispose())
    return audioBufferToWAV(rendered)
  }
}

export default TimelinePlayer
