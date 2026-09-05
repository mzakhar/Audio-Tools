// live-instrument.js — builds one playable instrument from an instrument
// descriptor. The browser's audition, the armed-track live path and timeline
// playback all come through here, so a sound auditions exactly as it plays.
// Palette tracks make voices directly; rack tracks mount lazily and drive the
// track's midi-in module. Same note maths as timeline-player.js.

import RackEngine from '../rack/rack-engine.js'
import { sampleInstrumentFor } from '../instruments/sample-instrument.js'
import { PALETTE_DRUM_NOTES } from '../instruments/pad-map.js'
import { velocityGain } from '../utils/velocity.js'

const DEFAULT_BEND_RANGE = 2 // semitones, the GM default

/** An internal drum palette answers to fixed voices, not to pitches. */
const isDrumPalette = palette => palette?.type === 'drum' && !!palette.createDrumVoice

/** Can this palette make a sound for this note at all? Drives the unlit pad. */
export function paletteAcceptsNote(palette, note) {
  if (!palette) return false
  return isDrumPalette(palette) ? PALETTE_DRUM_NOTES[note] !== undefined : true
}

export function liveInstrumentFor(track, deps) {
  return instrumentFor(track.instrument || { type: 'palette', paletteKey: track.paletteKey || 'classic' }, deps)
}

export function instrumentFor(instrument, { palettes, ctx, output, racks, mountRack, packFor, sampleStoreFor, onStatus } = {}) {
  if (!instrument) return null
  const bendRange = instrument.bendRange ?? DEFAULT_BEND_RANGE
  const modOff = instrument.modDest === 'off'

  if (instrument.type === 'pack') {
    const pack = packFor?.(instrument.packId, instrument.packVersion)
    const patch = pack?.byId?.get(instrument.patchId)
    const sampleStore = patch && sampleStoreFor?.(pack, ctx)
    if (!sampleStore) return null
    // The curve belongs to playing, not to stored notes: zone selection still
    // sees the raw velocity, so a soft hit keeps its soft velocity layer.
    const inst = sampleInstrumentFor(patch, { ctx, output, sampleStore, onStatus, velocityToGain: velocityGain })
    return {
      ...inst,
      send(event) {
        if (event?.type === 'pitch-bend') inst.setBend?.(event.value * bendRange)
        else if (event?.type === 'mod' && !modOff) inst.setMod?.(event.value)
      }
    }
  }

  if (instrument.type === 'rack') {
    const rack = racks?.[instrument.rackId]
    if (!rack) return null

    let handle = null
    let moduleId = null
    let unusable = false          // rack has no midi-in — do not remount every note
    const held = new Set()        // pitches currently gated, so a repeat note-on
                                  // cannot orphan a voice in midi-in's allocator
    let standingBend = null     // last expression seen while unmounted
    let standingMod = null
    const ensureMounted = () => {
      if (handle || unusable) return
      // ponytail: live rack mount is independent of TimelinePlayer's, so a rack
      // played live during transport is mounted twice. Share handles if CPU bites.
      handle = mountRack(rack)
      moduleId = [...handle.mods].find(([, entry]) => entry.def?.type === 'midi-in')?.[0]
      if (!moduleId) { RackEngine.unmount(handle); handle = null; unusable = true; return }
      // A wheel deflected before the first note still has to be heard on it.
      for (const event of [standingBend, standingMod]) {
        if (event) RackEngine.sendEvent(handle, moduleId, 'note', event)
      }
    }

    return {
      noteOn(pitch, velocity, time = ctx.currentTime) {
        if (held.has(pitch)) return
        ensureMounted()
        if (!moduleId) return
        held.add(pitch)
        RackEngine.sendEvent(handle, moduleId, 'note', { type: 'note-on', note: pitch, velocity, time: Math.max(time, ctx.currentTime) })
      },
      noteOff(pitch, time = ctx.currentTime) {
        if (!moduleId || !held.delete(pitch)) return
        RackEngine.sendEvent(handle, moduleId, 'note', { type: 'note-off', note: pitch, time: Math.max(time, ctx.currentTime) })
      },
      send(event) {
        // Never mounts: a wheel nudge must not start every oscillator in a rack
        // that has not played a note. bendRange is midi-in's own scaling here —
        // applying it again would double the bend.
        if (event?.type === 'mod' && modOff) return
        if (!moduleId) {
          // Remember it instead of dropping it; ensureMounted replays it.
          if (event?.type === 'pitch-bend') standingBend = event
          else if (event?.type === 'mod') standingMod = event
          return
        }
        RackEngine.sendEvent(handle, moduleId, 'note', event)
      },
      dispose() {
        if (handle) RackEngine.unmount(handle)
        handle = null
        moduleId = null
        held.clear()
        standingBend = null
        standingMod = null
      }
    }
  }

  // Pack playback is added with the pack sample store. Never substitute a
  // palette here: an unavailable selected pack must stay silent and visible.
  if (instrument.type !== 'palette') return null

  const palette = palettes?.[instrument.paletteKey || 'classic']
  if (!palette) return null

  const drums = isDrumPalette(palette)
  const voices = new Map() // pitch → voice
  let bend = 0             // semitones, applied to voices struck later too
  let mod = 0
  return {
    noteOn(pitch, velocity, time = ctx.currentTime) {
      const t = Math.max(time, ctx.currentTime)
      // Drum voices are one-shot and stop() is a no-op (palettes.js), so a
      // repeat hit while the map entry is stale has nothing to release —
      // overwrite and let it sound. A held melodic key must still not stack.
      if (voices.has(pitch) && !drums) return
      let voice
      if (drums) {
        // GM percussion onto the palette's 0–3 voices. An unmapped note is
        // silent rather than detuned — the pad shows unlit for the same reason.
        const index = PALETTE_DRUM_NOTES[pitch]
        if (index === undefined) return
        voice = palette.createDrumVoice(ctx, output, index, velocityGain(velocity), t)
      } else {
        const freq = 440 * Math.pow(2, (pitch - 69) / 12)
        voice = palette.createVoice(ctx, output, freq, velocityGain(velocity), t)
      }
      voices.set(pitch, voice)
      // A note struck mid-bend has to land in tune, not snap on the next wheel move.
      if (bend) voice?.setBend?.(bend)
      if (mod) voice?.setMod?.(mod)
    },
    noteOff(pitch, time = ctx.currentTime) {
      const voice = voices.get(pitch)
      if (!voice) return
      voice.stop(Math.max(time, ctx.currentTime))
      voices.delete(pitch)
    },
    send(event) {
      // Drum voices have neither — the optional calls keep them silent, not broken.
      if (event?.type === 'pitch-bend') {
        bend = event.value * bendRange
        for (const voice of voices.values()) voice?.setBend?.(bend)
      } else if (event?.type === 'mod' && !modOff) {
        mod = event.value
        for (const voice of voices.values()) voice?.setMod?.(mod)
      }
    },
    dispose() {
      for (const voice of voices.values()) voice.stop(ctx.currentTime)
      voices.clear()
    }
  }
}
