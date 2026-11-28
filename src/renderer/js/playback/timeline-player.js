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
import { paletteDefaults } from '../palettes.js'
import { kitFor } from '../pads/kit.js'
import { kitInstrument } from '../pads/kit-voices.js'
import { userSampleStoreFor as defaultUserSampleStoreFor } from '../instruments/user-samples.js'
import { fm1Descriptor, failureText } from '../fm1/descriptor.js'

const FM1_SLACK = 0.03 // seconds of timer jitter on top of the session's own lead

// One note contract for both instrument kinds. Keep scheduling here; only
// delivery differs, so palette and rack timing cannot drift apart.
export function paletteInstrument(palette, ctx, output, params) {
  return (note, time, stopTime) => {
    const freq = 440 * Math.pow(2, (note.pitch - 69) / 12)
    const voice = palette.createVoice(ctx, output, freq, note.velocity ?? 0.8, time, params)
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
export function instrumentFor(track, { palettes, ctx, output, rackHandles, kits, packFor, sampleStoreFor, userSampleStoreFor = defaultUserSampleStoreFor, packInstruments, fm1Sessions, trackId }) {
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
  if (instrument.type === 'kit') {
    const kit = kitFor(instrument.kitId, kits)
    if (!kit) return null
    const inst = kitInstrument(kit, { ctx, output, sampleStore: userSampleStoreFor?.(ctx) })
    return (note, time) => inst.hit(note.pitch, note.velocity ?? 0.8, time)
  }
  if (instrument.type === 'fm1') {
    const key = trackId ?? track.id
    if (!fm1Sessions || !key) return null
    // The device runs in its own clock: notes go to it ahead of time with exact
    // audio times, and the session owns the device, so nothing here disposes it.
    const session = fm1Sessions.acquire(key, fm1Descriptor(instrument), output)
    const play = (note, time, stopTime) => {
      session.noteOn(note.pitch, Math.round((note.velocity ?? 0.8) * 127), time)
      session.noteOff(note.pitch, stopTime)
    }
    play.session = session
    play.lead = () => session.leadSec + FM1_SLACK
    return play
  }
  if (instrument.type !== 'palette') return null
  const paletteKey = instrument.paletteKey || track.paletteKey || 'classic'
  const palette = palettes?.[paletteKey]
  const params = instrument.params || paletteDefaults(paletteKey)
  return palette ? paletteInstrument(palette, ctx, output, params) : null
}

/** Sample ids used by the kit tracks' sample slots (deduped). */
export function kitSampleIds(tracks, kits) {
  const ids = tracks.filter(track => track.type === 'midi' && track.instrument?.type === 'kit')
    .flatMap(track => Object.values(kitFor(track.instrument.kitId, kits)?.slots ?? {}))
    .filter(def => def.voice === 'sample').map(def => def.sampleId)
  return [...new Set(ids)]
}

/** Decode every kit sample into `store`; a missing one stays silent. */
export const preloadKitSamples = (store, tracks, kits) =>
  store ? Promise.allSettled(kitSampleIds(tracks, kits).map(id => store.get(id))).then(() => {}) : Promise.resolve()

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
  _fm1Sessions: [],       // device sessions this playback drives; stop() silences, never disposes

  play({ beat = 0, bpm, tracks, audioStore, mixerEngine, palettes, rackHandles = [], racks = {}, kits, packFor, sampleStoreFor, fm1Sessions, notify }) {
    this.stop()  // cancel any previous playback

    const ctx = AudioEngine.getContext()
    if (!ctx) return

    this._startAudioTime = ctx.currentTime + 0.05  // 50ms scheduling offset
    this._startBeat = beat
    this._isPlaying = true
    this._sources = []
    this._midiTimeouts = []
    this._packInstruments = []
    this._fm1Sessions = []
    const fm1Problems = []
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
        const playNote = instrumentFor(track, { palettes, ctx, output, rackHandles, kits, packFor, sampleStoreFor, packInstruments: this._packInstruments, fm1Sessions, trackId: track.id })
        if (track.instrument?.type === 'fm1') {
          const status = playNote?.session.status()
          if (!playNote) fm1Problems.push(`${track.name || 'MIDI'}: no device`)
          else if (status.state === 'failed') fm1Problems.push(`${track.name || 'MIDI'}: ${failureText(status.reason)}`)
          else if (status.state !== 'ready') fm1Problems.push(`${track.name || 'MIDI'}: still starting, early notes will be missed`)
          if (playNote) this._fm1Sessions.push(playNote.session)
        }
        if (!playNote) return
        const lead = playNote.lead?.() ?? 0

        track.clips.forEach(clip => {
          if (clip.type !== 'midi') return
          const notes = clip.notes || []
          notes.forEach(note => {
            const noteBeat = clip.startBeat + note.startBeat
            if (noteBeat + note.duration <= beat) return   // already past

            const noteAudioTime = this._startAudioTime + beatsToSeconds(noteBeat - beat, bpm)
            const stopAudioTime = noteAudioTime + beatsToSeconds(note.duration, bpm)
            const msUntilNote   = Math.max(0, (noteAudioTime - ctx.currentTime - lead) * 1000)

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
    if (fm1Problems.length) notify?.(`FM-1 ${fm1Problems.join('; ')}`)
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
    this._fm1Sessions.forEach(session => { try { session.panic() } catch (e) {} })
    this._fm1Sessions = []
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

  async bounce({ bpm, tracks, audioStore, durationBeats, sampleRate = 44100, racks = {}, kits, packFor, sampleStoreFor, userSampleStoreFor = defaultUserSampleStoreFor, palettes = null }) {
    const fm1Tracks = tracks.filter(track => track.type === 'midi' && track.instrument?.type === 'fm1')
    if (fm1Tracks.length) throw new Error(`FM-1 tracks cannot be bounced yet: ${fm1Tracks.map(track => track.name || track.id).join(', ')}`)
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
    // Kit sample slots: decode into the offline store before render. A missing sample bounces silent, like a missing sample live.
    const kitStore = userSampleStoreFor?.(offline)
    await preloadKitSamples(kitStore, tracks, kits)
    if (missing.length) throw new Error(`Missing pack samples: ${missing.join(', ')}`)
    tracks.forEach(track => {
      if (track.type === 'midi') {
        const playNote = instrumentFor(track, { palettes, ctx: offline, output: offline.destination, rackHandles, kits, packFor, sampleStoreFor, userSampleStoreFor, packInstruments })
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
