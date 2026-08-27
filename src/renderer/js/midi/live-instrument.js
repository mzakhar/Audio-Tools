// live-instrument.js — plays one track live from external MIDI. Palette
// tracks make voices directly; rack tracks mount lazily and drive the
// track's midi-in module. Same note maths as timeline-player.js.

import RackEngine from '../rack/rack-engine.js'
import { sampleInstrumentFor } from '../instruments/sample-instrument.js'

export function liveInstrumentFor(track, { palettes, ctx, output, racks, mountRack, packFor, sampleStoreFor, onStatus }) {
  const instrument = track.instrument || { type: 'palette', paletteKey: track.paletteKey || 'classic' }
  if (instrument.type === 'pack') {
    const pack = packFor?.(instrument.packId, instrument.packVersion)
    const patch = pack?.byId?.get(instrument.patchId)
    const sampleStore = patch && sampleStoreFor?.(pack, ctx)
    return sampleStore ? sampleInstrumentFor(patch, { ctx, output, sampleStore, onStatus }) : null
  }

  if (instrument.type === 'rack') {
    const rack = racks[instrument.rackId]
    if (!rack) return null

    let handle = null
    let moduleId = null
    let unusable = false          // rack has no midi-in — do not remount every note
    const held = new Set()        // pitches currently gated, so a repeat note-on
                                  // cannot orphan a voice in midi-in's allocator
    const ensureMounted = () => {
      if (handle || unusable) return
      // ponytail: live rack mount is independent of TimelinePlayer's, so a rack
      // played live during transport is mounted twice. Share handles if CPU bites.
      handle = mountRack(rack)
      moduleId = [...handle.mods].find(([, entry]) => entry.def?.type === 'midi-in')?.[0]
      if (!moduleId) { RackEngine.unmount(handle); handle = null; unusable = true }
    }

    return {
      noteOn(pitch, velocity) {
        if (held.has(pitch)) return
        ensureMounted()
        if (!moduleId) return
        held.add(pitch)
        RackEngine.sendEvent(handle, moduleId, 'note', { type: 'note-on', note: pitch, velocity, time: ctx.currentTime })
      },
      noteOff(pitch) {
        if (!moduleId || !held.delete(pitch)) return
        RackEngine.sendEvent(handle, moduleId, 'note', { type: 'note-off', note: pitch, time: ctx.currentTime })
      },
      send(event) {
        ensureMounted()
        if (!moduleId) return
        RackEngine.sendEvent(handle, moduleId, 'note', event)
      },
      dispose() {
        if (handle) RackEngine.unmount(handle)
        handle = null
        moduleId = null
        held.clear()
      }
    }
  }

  // Pack playback is added with the pack sample store. Never substitute a
  // palette here: an unavailable selected pack must stay silent and visible.
  if (instrument.type !== 'palette') return null

  const palette = palettes?.[instrument.paletteKey || track.paletteKey || 'classic']
  if (!palette) return null

  const voices = new Map() // pitch → voice
  return {
    noteOn(pitch, velocity) {
      if (voices.has(pitch)) return
      const freq = 440 * Math.pow(2, (pitch - 69) / 12)
      voices.set(pitch, palette.createVoice(ctx, output, freq, velocity / 127, ctx.currentTime))
    },
    noteOff(pitch) {
      const voice = voices.get(pitch)
      if (!voice) return
      voice.stop(ctx.currentTime)
      voices.delete(pitch)
    },
    send() {},
    dispose() {
      for (const voice of voices.values()) voice.stop(ctx.currentTime)
      voices.clear()
    }
  }
}
