/**
 * timeline-player.js
 * AudioClip playback scheduler + OfflineAudioContext bounce.
 */
import AudioEngine from '../audio-engine.js'
import { beatsToSeconds } from '../utils/timeline-math.js'
import { audioBufferToWAV } from '../utils/wav-encoder.js'

const TimelinePlayer = {
  _sources: [],           // active AudioBufferSourceNode[]
  _midiTimeouts: [],      // setTimeout handles for MIDI note scheduling
  _startAudioTime: 0,     // AudioContext.currentTime when play() was called
  _startBeat: 0,          // beat at which playback started
  _isPlaying: false,

  play({ beat = 0, bpm, tracks, audioStore, mixerEngine, palettes }) {
    this.stop()  // cancel any previous playback

    const ctx = AudioEngine.getContext()
    if (!ctx) return

    this._startAudioTime = ctx.currentTime + 0.05  // 50ms scheduling offset
    this._startBeat = beat
    this._isPlaying = true
    this._sources = []
    this._midiTimeouts = []

    tracks.forEach(track => {
      // ── MIDI track scheduling ──────────────────────────────────────────────
      if (track.type === 'midi' && palettes) {
        const palette = palettes[track.paletteKey || 'classic']
        if (!palette) return
        const channelId = track.mixerChannelId
        const output = mixerEngine ? mixerEngine.getOutput(channelId) : AudioEngine.getMasterInput()

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
              const freq  = 440 * Math.pow(2, (note.pitch - 69) / 12)
              const vel   = note.velocity ?? 0.8
              try {
                const voice = palette.createVoice(ctx, output, freq, vel, noteAudioTime)
                voice.stop(stopAudioTime)
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
        if (!buf) return

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
    this._sources.forEach(src => { try { src.stop() } catch (e) {} })
    this._sources = []
    this._midiTimeouts.forEach(id => clearTimeout(id))
    this._midiTimeouts = []
  },

  getCurrentBeat(bpm) {
    if (!this._isPlaying) return this._startBeat
    const ctx = AudioEngine.getContext()
    if (!ctx) return this._startBeat
    const elapsed = ctx.currentTime - this._startAudioTime
    return this._startBeat + (elapsed / (60 / bpm))
  },

  async bounce({ bpm, tracks, audioStore, durationBeats, sampleRate = 44100 }) {
    const totalSeconds = beatsToSeconds(durationBeats, bpm)
    const offline = new OfflineAudioContext(2, Math.ceil(totalSeconds * sampleRate), sampleRate)
    const startTime = 0.05

    tracks.forEach(track => {
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
    return audioBufferToWAV(rendered)
  }
}

export default TimelinePlayer
