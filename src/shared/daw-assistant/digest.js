// The only projection of project state a model ever sees.  Capped while it is
// built, never truncated after.  Keep this module browser- and Node-safe.

export const MAX_TRACKS = 32
export const MAX_CLIPS = 32
export const MAX_MODULES = 64
export const MAX_CABLES = 64
export const MAX_BARS = 8
export const MAX_NAME = 64
export const STEPS = 16

const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)

const DEL = String.fromCharCode(127)

export const text = (value, max = MAX_NAME) => typeof value === 'string'
  ? [...value].map(ch => (ch < ' ' || ch === DEL ? ' ' : ch)).join('').replace(/\s+/g, ' ').trim().slice(0, max)
  : ''

const finite = value => Number.isFinite(value) ? value : 0

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/** Params are attacker-influenced when a patch was shared; carry scalars only. */
const scalars = params => {
  if (!plainObject(params)) return {}
  const out = {}
  for (const [key, value] of Object.entries(params)) {
    if (UNSAFE_KEYS.has(key) || key.length > MAX_NAME) continue
    if (typeof value === 'number') { if (Number.isFinite(value)) out[key] = value }
    else if (typeof value === 'boolean') out[key] = value
    else if (typeof value === 'string') out[key] = text(value)
  }
  return out
}

const instrument = value => {
  if (!plainObject(value)) return null
  return {
    type: text(value.type, 32),
    ...(value.paletteKey ? { paletteKey: text(value.paletteKey, 32) } : {}),
    ...(value.rackId ? { rackId: text(value.rackId) } : {}),
    ...(value.packId ? { packId: text(value.packId) } : {}),
  }
}

/**
 * `truncated` tells the model it saw part of the project, so it can say so.
 * Every cap that drops something sets it.
 */
export function buildDigest(state) {
  if (!plainObject(state)) return { bpm: 120, timeSignature: [4, 4], tracks: [], mixer: [], racks: [], patterns: [], truncated: false }
  let truncated = false
  const drop = (list, cap) => {
    const items = Array.isArray(list) ? list : []
    if (items.length > cap) truncated = true
    return items.slice(0, cap)
  }

  const tracks = drop(state.tracks, MAX_TRACKS).map(track => {
    const clips = Array.isArray(track?.clips) ? track.clips : []
    return {
      id: text(track?.id),
      name: text(track?.name),
      type: text(track?.type, 16),
      ...(instrument(track?.instrument) ? { instrument: instrument(track.instrument) } : {}),
      ...(Number.isInteger(track?.midiChannel) ? { midiChannel: track.midiChannel } : {}),
      clipCount: clips.length,
      clips: drop(clips, MAX_CLIPS).map(clip => ({
        id: text(clip?.id),
        startBeat: finite(clip?.startBeat),
        duration: finite(clip?.duration),
        noteCount: Array.isArray(clip?.notes) ? clip.notes.length : 0,
      })),
    }
  })

  const mixer = (Array.isArray(state.mixer?.channels) ? state.mixer.channels : [])
    .filter(channel => tracks.some(track => track.id === channel?.trackId))
    .map(channel => ({
      id: text(channel.id), trackId: text(channel.trackId),
      volume: finite(channel.volume), pan: finite(channel.pan),
      mute: !!channel.mute, solo: !!channel.solo,
    }))

  const racks = Object.values(plainObject(state.racks) ? state.racks : {}).map(rack => ({
    id: text(rack?.id),
    name: text(rack?.name),
    modules: drop(rack?.modules, MAX_MODULES).map(mod => ({
      id: text(mod?.id), type: text(mod?.type, 32),
      rail: finite(mod?.rail), hp: finite(mod?.hp),
      bypassed: !!mod?.bypassed, params: scalars(mod?.params),
    })),
    cables: drop(rack?.cables, MAX_CABLES).map(cable => ({
      id: text(cable?.id),
      from: { moduleId: text(cable?.from?.moduleId), port: text(cable?.from?.port, 32) },
      to: { moduleId: text(cable?.to?.moduleId), port: text(cable?.to?.port, 32) },
    })),
  }))

  // 16 objects per lane costs an order of magnitude more tokens than the string
  // a model reasons about better anyway.
  const lane = steps => Array.from({ length: STEPS }, (_, i) => (Array.isArray(steps) && steps[i]?.on ? '1' : '0')).join('')

  const patterns = Object.values(plainObject(state.patterns) ? state.patterns : {}).map(pattern => {
    const bars = Array.isArray(pattern?.bars) ? pattern.bars : []
    return {
      id: text(pattern?.id),
      name: text(pattern?.name),
      barCount: bars.length,
      currentBar: finite(pattern?.currentBar),
      chain: (Array.isArray(pattern?.chain) ? pattern.chain : []).slice(0, 64).map(finite),
      bars: drop(bars, MAX_BARS).map(bar => ({
        lastStep: finite(bar?.lastStep),
        scale: text(bar?.scale, 16),
        lanes: Object.fromEntries(Object.entries(plainObject(bar?.lanes) ? bar.lanes : {})
          .filter(([id]) => !UNSAFE_KEYS.has(id) && id.length <= MAX_NAME)
          .map(([id, steps]) => [id, lane(steps)])),
      })),
    }
  })

  return {
    bpm: finite(state.bpm),
    timeSignature: Array.isArray(state.timeSignature) ? state.timeSignature.slice(0, 2).map(finite) : [4, 4],
    tracks, mixer, racks, patterns, truncated,
  }
}

/**
 * The server must not trust that a client sent `buildDigest()` output — a
 * stale or hostile caller could otherwise inflate the digest it forwards to
 * OpenAI far past what a real digest costs. Re-applies the same caps and
 * sanitizers against an arbitrary parsed JSON value, coercing bad types to
 * safe defaults instead of throwing, and dropping unknown keys by rebuilding
 * every entry from a fixed whitelist of fields.
 */
export function clampDigest(digest) {
  const empty = { bpm: 120, timeSignature: [4, 4], tracks: [], mixer: [], racks: [], patterns: [], truncated: false }
  if (!plainObject(digest)) return empty
  let truncated = false
  const drop = (list, cap) => {
    const items = Array.isArray(list) ? list : []
    if (items.length > cap) truncated = true
    return items.slice(0, cap)
  }

  const tracks = drop(digest.tracks, MAX_TRACKS).map(track => {
    if (!plainObject(track)) track = {}
    return {
      id: text(track.id),
      name: text(track.name),
      type: text(track.type, 16),
      ...(instrument(track.instrument) ? { instrument: instrument(track.instrument) } : {}),
      ...(Number.isInteger(track.midiChannel) ? { midiChannel: track.midiChannel } : {}),
      clipCount: finite(track.clipCount),
      clips: drop(track.clips, MAX_CLIPS).map(clip => plainObject(clip) ? {
        id: text(clip.id), startBeat: finite(clip.startBeat), duration: finite(clip.duration), noteCount: finite(clip.noteCount),
      } : { id: '', startBeat: 0, duration: 0, noteCount: 0 }),
    }
  })

  const mixer = drop(digest.mixer, MAX_TRACKS)
    .filter(channel => plainObject(channel) && tracks.some(track => track.id === channel.trackId))
    .map(channel => ({
      id: text(channel.id), trackId: text(channel.trackId),
      volume: finite(channel.volume), pan: finite(channel.pan),
      mute: !!channel.mute, solo: !!channel.solo,
    }))

  const racks = (Array.isArray(digest.racks) ? digest.racks : []).map(rack => {
    if (!plainObject(rack)) rack = {}
    return {
      id: text(rack.id),
      name: text(rack.name),
      modules: drop(rack.modules, MAX_MODULES).map(mod => plainObject(mod) ? {
        id: text(mod.id), type: text(mod.type, 32),
        rail: finite(mod.rail), hp: finite(mod.hp),
        bypassed: !!mod.bypassed, params: scalars(mod.params),
      } : { id: '', type: '', rail: 0, hp: 0, bypassed: false, params: {} }),
      cables: drop(rack.cables, MAX_CABLES).map(cable => plainObject(cable) ? {
        id: text(cable.id),
        from: { moduleId: text(cable.from?.moduleId), port: text(cable.from?.port, 32) },
        to: { moduleId: text(cable.to?.moduleId), port: text(cable.to?.port, 32) },
      } : { id: '', from: { moduleId: '', port: '' }, to: { moduleId: '', port: '' } }),
    }
  })

  const patterns = (Array.isArray(digest.patterns) ? digest.patterns : []).map(pattern => {
    if (!plainObject(pattern)) pattern = {}
    return {
      id: text(pattern.id),
      name: text(pattern.name),
      barCount: finite(pattern.barCount),
      currentBar: finite(pattern.currentBar),
      chain: (Array.isArray(pattern.chain) ? pattern.chain : []).slice(0, 64).map(finite),
      bars: drop(pattern.bars, MAX_BARS).map(bar => plainObject(bar) ? {
        lastStep: finite(bar.lastStep),
        scale: text(bar.scale, 16),
        lanes: Object.fromEntries(Object.entries(plainObject(bar.lanes) ? bar.lanes : {})
          .filter(([id]) => !UNSAFE_KEYS.has(id) && id.length <= MAX_NAME)
          .map(([id, steps]) => [id, typeof steps === 'string' ? steps.replace(/[^01]/g, '0').padEnd(STEPS, '0').slice(0, STEPS) : '0'.repeat(STEPS)])),
      } : { lastStep: 0, scale: '', lanes: {} }),
    }
  })

  return {
    bpm: finite(digest.bpm),
    timeSignature: Array.isArray(digest.timeSignature) ? digest.timeSignature.slice(0, 2).map(finite) : [4, 4],
    tracks, mixer, racks, patterns, truncated,
  }
}
