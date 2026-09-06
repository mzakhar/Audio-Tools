// Model output stops here.  Nothing reaches ProjectStore.dispatch without
// passing validatePlan against live state.  Browser- and Node-safe: this module
// imports nothing from src/renderer, so the proxy can run the shape half.

import { text } from './digest.js'

export const MAX_SUMMARY = 240
export const MAX_ACTIONS = 24
export const MAX_NOTES = 512
export const MAX_CHAIN = 64
export const MAX_PARAM_ENTRIES = 32

const UNSAFE = new Set(['__proto__', 'constructor', 'prototype'])
const MIXER_PARAMS = new Set(['volume', 'pan', 'mute', 'solo'])
const BAR_PARAMS = new Set(['scale', 'shuffle', 'flam', 'lastStep', 'totalAccent'])
const TRACK_TYPES = new Set(['audio', 'midi'])
const INSTRUMENT_TYPES = new Set(['palette', 'rack', 'pack'])

const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)

// ── Field checks: null means "reject", undefined means "omit" ──────────────
const num = (min, max) => value => (typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max) ? value : null
const int = (min, max) => value => (Number.isInteger(value) && value >= min && value <= max) ? value : null
const bool = value => typeof value === 'boolean' ? value : null
const str = max => value => text(value, max) || null
const oneOf = set => value => (typeof value === 'string' && set.has(value)) ? value : null
const optional = (check, fallback) => value => value === undefined || value === null ? fallback : check(value)

const id = value => {
  const clean = text(value, 128)
  return clean && !UNSAFE.has(clean) ? clean : null
}

const SLUG = /^[a-z0-9][a-z0-9_-]{0,31}$/
const slug = value => (typeof value === 'string' && SLUG.test(value) && !UNSAFE.has(value)) ? value : null
const refValue = value => (plainObject(value) && slug(value.$ref) !== null) ? { $ref: value.$ref } : null

/** An id slot: a real id, or { $ref } naming something an earlier action makes. */
const idOrRef = value => plainObject(value) ? refValue(value) : id(value)

/** Anything that becomes an object key: no prototype pollution, no separators. */
const objectKey = value => {
  const clean = text(value, 64)
  return clean && !UNSAFE.has(clean) && /^[A-Za-z0-9_.-]+$/.test(clean) ? clean : null
}

const scalar = value => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'boolean') return value
  return str(64)(value)
}

const paramBag = value => {
  if (value === undefined || value === null) return {}
  if (!plainObject(value)) return null
  const entries = Object.entries(value)
  if (entries.length > MAX_PARAM_ENTRIES) return null
  const out = {}
  for (const [key, raw] of entries) {
    const safeKey = objectKey(key)
    const safeValue = scalar(raw)
    if (safeKey === null || safeValue === null) return null
    out[safeKey] = safeValue
  }
  return out
}

const note = value => {
  if (!plainObject(value)) return null
  const pitch = int(0, 127)(value.pitch)
  const startBeat = num(0, 1e6)(value.startBeat)
  const duration = num(0.0625, 1e4)(value.duration)
  const velocity = optional(num(0.01, 1), 0.8)(value.velocity)
  if (pitch === null || startBeat === null || duration === null || velocity === null) return null
  return { pitch, startBeat, duration, velocity }
}

const noteList = value => {
  if (!Array.isArray(value) || value.length > MAX_NOTES) return null
  const notes = value.map(note)
  return notes.some(item => item === null) ? null : notes
}

const clip = value => {
  if (!plainObject(value)) return null
  const startBeat = num(0, 1e6)(value.startBeat)
  const duration = num(0.0625, 1e4)(value.duration)
  const type = optional(oneOf(new Set(['midi', 'audio'])), 'midi')(value.type)
  const name = optional(str(64), 'Clip')(value.name)
  const notes = value.notes === undefined ? [] : noteList(value.notes)
  if (startBeat === null || duration === null || type === null || name === null || notes === null) return null
  return { name, type, startBeat, duration, notes }
}

const instrument = value => {
  if (!plainObject(value)) return null
  const type = oneOf(INSTRUMENT_TYPES)(value.type)
  if (type === null) return null
  if (type === 'palette') {
    const paletteKey = objectKey(value.paletteKey)
    return paletteKey === null ? null : { type, paletteKey }
  }
  if (type === 'rack') {
    const rackId = id(value.rackId)
    return rackId === null ? null : { type, rackId }
  }
  const packId = id(value.packId)
  const patchId = id(value.patchId)
  const packVersion = optional(str(64), undefined)(value.packVersion)
  if (packId === null || patchId === null) return null
  return { type, packId, patchId, ...(packVersion ? { packVersion } : {}) }
}

const endpoint = value => {
  if (!plainObject(value)) return null
  const moduleId = idOrRef(value.moduleId)
  const port = objectKey(value.port)
  return moduleId === null || port === null ? null : { moduleId, port }
}

const stepPatch = value => {
  if (!plainObject(value)) return null
  const out = {}
  for (const [key, check] of [['on', bool], ['accent', bool], ['flam', bool], ['velocity', num(0, 1)]]) {
    if (value[key] === undefined) continue
    const checked = check(value[key])
    if (checked === null) return null
    out[key] = checked
  }
  return Object.keys(out).length ? out : null
}

const chainList = value => {
  if (!Array.isArray(value) || !value.length || value.length > MAX_CHAIN) return null
  const chain = value.map(int(0, 255))
  return chain.some(item => item === null) ? null : chain
}

// ── The allowlist.  Adding a name here widens what a model may do. ─────────
// A spec is either a field map, or a function for cross-field rules.
const SPECS = {
  SetBpm: { bpm: num(40, 240) },

  AddTrack: { type: optional(oneOf(TRACK_TYPES), 'midi'), name: optional(str(64), 'Track') },
  RemoveTrack: { trackId: idOrRef },
  SetTrackInstrument: { trackId: idOrRef, instrument },
  SetTrackMidiChannel: { trackId: idOrRef, channel: int(0, 15) },

  AddClip: { trackId: idOrRef, clip },
  RemoveClip: { trackId: idOrRef, clipId: idOrRef },
  MoveClip: { trackId: idOrRef, clipId: idOrRef, startBeat: num(0, 1e6) },
  DuplicateClip: { trackId: idOrRef, clipId: idOrRef },
  TileClip: { trackId: idOrRef, clipId: idOrRef, endBeat: optional(num(0, 1e6), 64) },

  SetMidiClipNotes: { trackId: idOrRef, clipId: idOrRef, notes: noteList },
  AddMidiNote: { trackId: idOrRef, clipId: idOrRef, note },
  RemoveMidiNote: { trackId: idOrRef, clipId: idOrRef, noteId: idOrRef },

  // ProjectStore.js:322 writes channel[param] with no key check — this is the
  // only guard between a model string and an object key.
  SetMixerParam: args => {
    const channelId = idOrRef(args.channelId)
    const param = oneOf(MIXER_PARAMS)(args.param)
    if (channelId === null || param === null) return null
    const value = param === 'volume' ? num(0, 1)(args.value)
      : param === 'pan' ? num(-1, 1)(args.value)
      : bool(args.value)
    return value === null ? null : { channelId, param, value }
  },
  SetSendLevel: { channelId: idOrRef, busId: id, level: num(0, 1) },

  AddEffect: { trackId: idOrRef, type: objectKey, params: paramBag },
  RemoveEffect: { trackId: idOrRef, effectId: idOrRef },
  SetEffectParam: { trackId: idOrRef, effectId: idOrRef, param: objectKey, value: scalar },

  SetPatternStep: { patternId: id, barIndex: int(0, 63), instrumentId: objectKey, stepIndex: int(0, 15), patch: stepPatch },
  SetBarParam: args => {
    const patternId = id(args.patternId)
    const barIndex = int(0, 63)(args.barIndex)
    const key = oneOf(BAR_PARAMS)(args.key)
    if (patternId === null || barIndex === null || key === null) return null
    const value = key === 'scale' ? str(16)(args.value)
      : key === 'lastStep' ? int(1, 16)(args.value)
      : num(0, 1)(args.value)
    return value === null ? null : { patternId, barIndex, key, value }
  },
  ClearBar: { patternId: id, barIndex: int(0, 63) },
  AddBar: { patternId: id, copyFrom: optional(int(0, 63), null) },
  SetChain: { patternId: id, chain: chainList },

  AddModule: { rackId: id, type: objectKey, rail: optional(int(0, 7), 0), hp: optional(int(0, 512), 0), params: paramBag },
  RemoveModule: { rackId: id, moduleId: idOrRef },
  MoveModule: { rackId: id, moduleId: idOrRef, rail: int(0, 7), hp: int(0, 512) },
  SetModuleParam: { rackId: id, moduleId: idOrRef, key: objectKey, value: scalar },
  SetAttenuverter: { rackId: id, moduleId: idOrRef, portId: objectKey, value: num(-1, 1) },
  SetModuleBypass: { rackId: id, moduleId: idOrRef, bypassed: bool },
  Connect: { rackId: id, from: endpoint, to: endpoint },
  Disconnect: { rackId: id, cableId: id },

  // `key` is resolved against the palette definition (capabilities.paletteParamKeys),
  // never a static list here — same posture as SetModuleParam above.
  SetInstrumentParam: { trackId: idOrRef, key: objectKey, value: scalar },
  // packId/patchId name an installed pack patch; every other field of the
  // selection (packVersion, bank/program) is resolved from the installed
  // manifest by our code, never taken from model text.
  SetTrackInstrumentProgram: { trackId: idOrRef, packId: str(128), patchId: str(128) },
}

export const ALLOWLIST = Object.freeze(Object.keys(SPECS))

// ── Forward references ─────────────────────────────────────────────────────
// An action may name something an *earlier* action in the same plan creates,
// because ids do not exist until apply.  Which creating action may fill which
// slot, and which of its ids goes there: a track ref in a channelId slot
// resolves to that track's mixer channel.
const REF_SLOTS = {
  trackId: { AddTrack: 'trackId' },
  channelId: { AddTrack: 'channelId' },
  clipId: { AddClip: 'clipId' },
  noteId: { AddMidiNote: 'noteId' },
  effectId: { AddEffect: 'effectId' },
  moduleId: { AddModule: 'moduleId' },
}
const CREATING = new Set(Object.values(REF_SLOTS).flatMap(Object.keys))
const CREATED_NOUN = { AddTrack: 'a track', AddClip: 'a clip', AddMidiNote: 'a note', AddEffect: 'an effect', AddModule: 'a module' }

/** Rewrite every { $ref } in an id slot through `lookup(slot, slug)`.  Pure. */
function resolveRefs(args, lookup) {
  const out = { ...args }
  for (const slot of Object.keys(REF_SLOTS)) {
    if (plainObject(out[slot])) out[slot] = lookup(slot, out[slot].$ref)
  }
  for (const side of ['from', 'to']) {
    if (plainObject(out[side]) && plainObject(out[side].moduleId)) {
      out[side] = { ...out[side], moduleId: lookup('moduleId', out[side].moduleId.$ref) }
    }
  }
  return out
}

/** Structure only — safe to run where no project state exists (the proxy). */
export function validatePlanShape(plan) {
  if (!plainObject(plan)) return { ok: false, errors: ['Plan must be an object'] }
  const errors = []
  const summary = typeof plan.summary === 'string' ? text(plan.summary, MAX_SUMMARY) : null
  if (typeof plan.summary !== 'string') errors.push('summary must be a string')
  else if (plan.summary.length > MAX_SUMMARY) errors.push(`summary must be <= ${MAX_SUMMARY} characters`)
  if (!Array.isArray(plan.actions) || !plan.actions.length) errors.push('actions must be a non-empty array')
  else if (plan.actions.length > MAX_ACTIONS) errors.push(`actions must be <= ${MAX_ACTIONS} entries`)

  const actions = []
  const seenRefs = new Set()
  if (Array.isArray(plan.actions) && plan.actions.length && plan.actions.length <= MAX_ACTIONS) {
    plan.actions.forEach((raw, index) => {
      const where = `Action ${index + 1}`
      if (!plainObject(raw)) { errors.push(`${where}: must be an object`); return }
      // Literal lookup on our own table — a model string never indexes a module.
      const spec = Object.prototype.hasOwnProperty.call(SPECS, raw.action) ? SPECS[raw.action] : null
      if (!spec) { errors.push(`${where}: unknown action "${text(raw.action, 40) || String(raw.action)}"`); return }
      let ref = null
      if (raw.ref !== undefined && raw.ref !== null) {
        ref = slug(raw.ref)
        if (ref === null) { errors.push(`${where}: "ref" must be a short lowercase slug`); return }
        if (!CREATING.has(raw.action)) { errors.push(`${where}: ${raw.action} creates nothing, so it cannot define a ref`); return }
        if (seenRefs.has(ref)) { errors.push(`${where}: duplicate ref "${ref}"`); return }
        seenRefs.add(ref)
      }
      const named = ref ? { ref } : {}
      const rawArgs = plainObject(raw.args) ? raw.args : {}
      if (typeof spec === 'function') {
        const args = spec(rawArgs)
        if (args === null) { errors.push(`${where} (${raw.action}): invalid arguments`); return }
        actions.push({ action: raw.action, args, ...named })
        return
      }
      const args = {}
      let bad = false
      for (const [field, check] of Object.entries(spec)) {
        const value = check(rawArgs[field])
        if (value === null) { errors.push(`${where} (${raw.action}): invalid "${field}"`); bad = true; continue }
        if (value !== undefined) args[field] = value
      }
      if (!bad) actions.push({ action: raw.action, args, ...named })
    })
  }
  return errors.length ? { ok: false, errors } : { ok: true, value: { summary, actions } }
}

// ── Live lookups ───────────────────────────────────────────────────────────
const trackOf = (state, trackId) => (state?.tracks || []).find(track => track.id === trackId)
const clipOf = (track, clipId) => (track?.clips || []).find(item => item.id === clipId)
const rackOf = (state, rackId) => (state?.racks || {})[rackId]
const moduleOf = (rack, moduleId) => (rack?.modules || []).find(mod => mod.id === moduleId)
const patternOf = (state, patternId) => (state?.patterns || {})[patternId]

const has = (set, value) => set instanceof Set ? set.has(value) : Array.isArray(set) ? set.includes(value) : null

const trackClip = (state, args, errors, where) => {
  const track = trackOf(state, args.trackId)
  if (!track) { errors.push(`${where}: track not found`); return null }
  const found = clipOf(track, args.clipId)
  if (!found) errors.push(`${where}: clip not found`)
  return found || null
}

/** Every id already in the project — a ref slug may not shadow one of them. */
function collectIds(state) {
  const ids = new Set()
  for (const track of state?.tracks || []) {
    ids.add(track.id).add(track.mixerChannelId)
    for (const item of track.clips || []) {
      ids.add(item.id)
      for (const item2 of item.notes || []) ids.add(item2.id)
    }
    for (const effect of track.effects || []) ids.add(effect.id)
  }
  for (const channel of state?.mixer?.channels || []) ids.add(channel.id)
  for (const bus of state?.buses || []) ids.add(bus.id)
  for (const [rackId, rack] of Object.entries(state?.racks || {})) {
    ids.add(rackId)
    for (const mod of rack?.modules || []) ids.add(mod.id)
    for (const cable of rack?.cables || []) ids.add(cable.id)
  }
  for (const patternId of Object.keys(state?.patterns || {})) ids.add(patternId)
  ids.delete(undefined)
  return ids
}

const withTrack = (state, trackId, fn) => ({
  ...state,
  tracks: (state?.tracks || []).map(track => track.id === trackId ? fn(track) : track),
})

/** Placeholder ids, so the checks below see what the plan is about to create.
 *  REF_SLOTS decides which key is ever read, so one bag covers every kind. */
const stubIds = ref => ({ trackId: ref, channelId: `${ref}#channel`, clipId: ref, noteId: ref, effectId: ref, moduleId: ref })

/**
 * The state as it will be *after* a creating action runs — enough of it that
 * every existence check, canConnect included, still runs against a real shape.
 */
function project(state, action, args, ref) {
  switch (action) {
    case 'AddTrack': return {
      ...state,
      tracks: [...(state?.tracks || []), { id: ref, name: args.name, type: args.type, mixerChannelId: `${ref}#channel`, clips: [], effects: [] }],
      mixer: { ...(state?.mixer || {}), channels: [...(state?.mixer?.channels || []), { id: `${ref}#channel`, trackId: ref, volume: 1, pan: 0, mute: false, solo: false, sends: {} }] },
    }
    case 'AddClip': return withTrack(state, args.trackId, track => ({ ...track, clips: [...(track.clips || []), { id: ref, ...args.clip, notes: [] }] }))
    case 'AddMidiNote': return withTrack(state, args.trackId, track => ({
      ...track,
      clips: (track.clips || []).map(item => item.id === args.clipId ? { ...item, notes: [...(item.notes || []), { id: ref, ...args.note }] } : item),
    }))
    case 'AddEffect': return withTrack(state, args.trackId, track => ({ ...track, effects: [...(track.effects || []), { id: ref, type: args.type, params: args.params }] }))
    case 'AddModule': {
      const rack = rackOf(state, args.rackId)
      if (!rack) return state
      return { ...state, racks: { ...state.racks, [args.rackId]: { ...rack, modules: [...(rack.modules || []), { id: ref, type: args.type, rail: args.rail, hp: args.hp, params: args.params, atten: {}, bypassed: false, name: null }] } } }
    }
    default: return state
  }
}

/**
 * Everything validatePlanShape checks, plus ids resolved against the state in
 * front of the user right now.  `capabilities` is optional; a check whose
 * capability is missing is skipped, never assumed to pass.
 */
export function validatePlan(plan, state, capabilities = {}) {
  const shape = validatePlanShape(plan)
  if (!shape.ok) return shape
  const caps = plainObject(capabilities) ? capabilities : {}
  const errors = []
  const stateIds = collectIds(state)
  const declared = new Map(shape.value.actions.flatMap((item, index) => item.ref ? [[item.ref, index]] : []))
  const refs = new Map()
  let live = state

  shape.value.actions.forEach(({ action, args: named, ref }, index) => {
    const where = `Action ${index + 1} (${action})`
    // A $ref must point strictly backwards, so `refs` only ever holds actions
    // already walked.  Resolved to placeholder ids, every check below is the
    // same check it was before refs existed.
    let broken = false
    const args = resolveRefs(named, (slot, wanted) => {
      const entry = refs.get(wanted)
      // Only ever set, never cleared: an action with two ref slots (Connect)
      // must stay broken when the first fails and the second resolves, or the
      // checks below run against a half-resolved arg.
      if (!entry) {
        broken = true
        errors.push(declared.has(wanted)
          ? `${where}: ref "${wanted}" is created by a later action`
          : `${where}: unknown ref "${wanted}"`)
        return null
      }
      const key = REF_SLOTS[slot][entry.action]
      if (!key) {
        broken = true
        errors.push(`${where}: ref "${wanted}" is ${CREATED_NOUN[entry.action]}, not usable as ${slot}`)
        return null
      }
      return entry.ids[key]
    })
    if (ref) {
      // Every id the ref stands for, not just the slug: AddTrack also derives a
      // channel id, and that must not alias a real mixer channel either.
      const collision = [ref, ...Object.values(stubIds(ref))].find(candidate => stateIds.has(candidate))
      if (collision) errors.push(`${where}: ref "${ref}" collides with an id already in the project`)
      refs.set(ref, { action, ids: stubIds(ref) })
    }
    const state = live   // shadows the parameter: the checks below run against
    if (ref) live = project(live, action, args, ref)   // the projected state
    if (broken) return
    switch (action) {
      case 'SetBpm': case 'AddTrack':
        break
      case 'RemoveTrack': case 'SetTrackMidiChannel': case 'AddClip': case 'AddEffect':
        if (!trackOf(state, args.trackId)) errors.push(`${where}: track not found`)
        break
      case 'SetTrackInstrument':
        if (!trackOf(state, args.trackId)) errors.push(`${where}: track not found`)
        if (args.instrument.type === 'rack' && !rackOf(state, args.instrument.rackId)) errors.push(`${where}: rack not found`)
        break
      case 'RemoveClip': case 'MoveClip': case 'DuplicateClip': case 'TileClip':
      case 'SetMidiClipNotes': case 'AddMidiNote':
        trackClip(state, args, errors, where)
        break
      case 'RemoveMidiNote': {
        const found = trackClip(state, args, errors, where)
        if (found && !(found.notes || []).some(item => item.id === args.noteId)) errors.push(`${where}: note not found`)
        break
      }
      case 'SetMixerParam':
        if (!(state?.mixer?.channels || []).some(channel => channel.id === args.channelId)) errors.push(`${where}: mixer channel not found`)
        break
      case 'SetSendLevel':
        if (!(state?.mixer?.channels || []).some(channel => channel.id === args.channelId)) errors.push(`${where}: mixer channel not found`)
        if (!(state?.buses || []).some(bus => bus.id === args.busId)) errors.push(`${where}: bus not found`)
        break
      case 'RemoveEffect': case 'SetEffectParam': {
        const track = trackOf(state, args.trackId)
        if (!track) { errors.push(`${where}: track not found`); break }
        if (!(track.effects || []).some(effect => effect.id === args.effectId)) errors.push(`${where}: effect not found`)
        break
      }
      case 'SetPatternStep': case 'SetBarParam': case 'ClearBar': case 'AddBar': case 'SetChain': {
        const pattern = patternOf(state, args.patternId)
        if (!pattern) { errors.push(`${where}: pattern not found`); break }
        const bars = pattern.bars || []
        if (action === 'SetChain') {
          if (args.chain.some(barIndex => barIndex >= bars.length)) errors.push(`${where}: chain names a missing bar`)
          break
        }
        if (action === 'AddBar') {
          if (args.copyFrom !== null && !bars[args.copyFrom]) errors.push(`${where}: bar not found`)
          break
        }
        const bar = bars[args.barIndex]
        if (!bar) { errors.push(`${where}: bar not found`); break }
        if (action === 'SetPatternStep' && !(bar.lanes || {})[args.instrumentId]) errors.push(`${where}: instrument not in this bar`)
        break
      }
      case 'AddModule': {
        if (!rackOf(state, args.rackId)) errors.push(`${where}: rack not found`)
        const known = has(caps.moduleTypes, args.type)
        if (known === false) errors.push(`${where}: unknown module type "${args.type}"`)
        break
      }
      case 'RemoveModule': case 'MoveModule': case 'SetAttenuverter': case 'SetModuleBypass': {
        const rack = rackOf(state, args.rackId)
        if (!rack) { errors.push(`${where}: rack not found`); break }
        if (!moduleOf(rack, args.moduleId)) errors.push(`${where}: module not found`)
        break
      }
      case 'SetModuleParam': {
        const rack = rackOf(state, args.rackId)
        if (!rack) { errors.push(`${where}: rack not found`); break }
        const mod = moduleOf(rack, args.moduleId)
        if (!mod) { errors.push(`${where}: module not found`); break }
        if (typeof caps.moduleParamKeys !== 'function') break
        if (has(caps.moduleParamKeys(mod.type), args.key) === false) errors.push(`${where}: "${args.key}" is not a param of ${mod.type}`)
        break
      }
      case 'Connect': {
        const rack = rackOf(state, args.rackId)
        if (!rack) { errors.push(`${where}: rack not found`); break }
        if (!moduleOf(rack, args.from.moduleId) || !moduleOf(rack, args.to.moduleId)) { errors.push(`${where}: module not found`); break }
        if (typeof caps.canConnect !== 'function') break
        // Only the registry knows port direction; ProjectStore.js:673 does not.
        const verdict = caps.canConnect(rack, args.from, args.to)
        const ok = typeof verdict === 'boolean' ? verdict : !!verdict?.ok
        if (!ok) errors.push(`${where}: ${text(verdict?.reason, 64) || 'cable not allowed'}`)
        break
      }
      case 'Disconnect': {
        const rack = rackOf(state, args.rackId)
        if (!rack) { errors.push(`${where}: rack not found`); break }
        if (!(rack.cables || []).some(cable => cable.id === args.cableId)) errors.push(`${where}: cable not found`)
        break
      }
      case 'SetInstrumentParam': {
        const track = trackOf(state, args.trackId)
        if (!track) { errors.push(`${where}: track not found`); break }
        if (track.instrument?.type !== 'palette') { errors.push(`${where}: track instrument is not a palette`); break }
        if (typeof caps.paletteParamKeys !== 'function') break
        if (has(caps.paletteParamKeys(track.instrument.paletteKey), args.key) === false) errors.push(`${where}: "${args.key}" is not a param of ${track.instrument.paletteKey}`)
        break
      }
      case 'SetTrackInstrumentProgram': {
        const track = trackOf(state, args.trackId)
        if (!track) { errors.push(`${where}: track not found`); break }
        if (track.type !== 'midi') { errors.push(`${where}: track is not a MIDI track`); break }
        // ProjectStore.js:160 ignores a program change on a pinned instrument —
        // refuse here rather than emit an action we know will be a no-op.
        if (track.instrument?.programFollow === 'pinned') { errors.push(`${where}: instrument is pinned and would ignore a program change`); break }
        if (typeof caps.packPatchIds !== 'function') break
        if (has(caps.packPatchIds(args.packId), args.patchId) === false) errors.push(`${where}: "${args.patchId}" is not an installed patch of pack "${args.packId}"`)
        break
      }
    }
  })

  return errors.length ? { ok: false, errors } : shape
}

const nameOf = (thing, fallback) => text(thing?.name, 64) || fallback

const SLOT_NOUN = { trackId: 'track', channelId: 'channel of the track', clipId: 'clip', noteId: 'note', effectId: 'effect', moduleId: 'module' }

/** A $ref reads as the step that creates it, never as a slug or an object. */
const refPhrase = (slot, wanted, actions) => {
  const step = actions.findIndex(item => item?.ref === wanted)
  return step < 0 ? `the ${SLOT_NOUN[slot]} added earlier` : `the ${SLOT_NOUN[slot]} added in step ${step + 1}`
}

/** One sentence for a preview row; the action name alone if the target is gone.
 *  `actions` is the rest of the plan, needed only to number a $ref's step.
 *  `packs` (same shape buildDigest takes) is only needed to name a patch and
 *  its pack rather than print their ids. */
export function describeAction(action, state, actions = [], packs = []) {
  if (!plainObject(action) || !Object.prototype.hasOwnProperty.call(SPECS, action.action)) return 'Unknown action'
  const plan = Array.isArray(actions) ? actions : []
  const args = resolveRefs(plainObject(action.args) ? action.args : {}, (slot, wanted) => refPhrase(slot, wanted, plan))
  const track = () => nameOf(trackOf(state, args.trackId), args.trackId)
  const rack = () => nameOf(rackOf(state, args.rackId), args.rackId)
  const mod = () => {
    const found = moduleOf(rackOf(state, args.rackId), args.moduleId)
    return found ? (text(found.name, 64) || String(found.type).toUpperCase()) : args.moduleId
  }
  const channel = () => {
    const found = (state?.mixer?.channels || []).find(item => item.id === args.channelId)
    return found ? nameOf(trackOf(state, found.trackId), found.trackId) : args.channelId
  }
  const patchName = () => {
    const pack = (Array.isArray(packs) ? packs : []).find(item => item?.id === args.packId)
    const patch = pack?.manifest?.patches?.find(item => item?.id === args.patchId)
    return { pack: text(pack?.manifest?.name) || args.packId, patch: text(patch?.name) || args.patchId }
  }
  switch (action.action) {
    case 'SetBpm': return `Set BPM to ${args.bpm}`
    case 'AddTrack': return `Add a ${args.type} track named "${args.name}"`
    case 'RemoveTrack': return `Remove track "${track()}"`
    case 'SetTrackInstrument': return `Set the instrument on "${track()}" to ${args.instrument.type === 'rack' ? nameOf(rackOf(state, args.instrument.rackId), args.instrument.rackId) : args.instrument.paletteKey || args.instrument.patchId}`
    case 'SetTrackMidiChannel': return `Set "${track()}" to MIDI channel ${args.channel + 1}`
    case 'AddClip': return `Add a ${args.clip.duration}-beat clip to "${track()}" at beat ${args.clip.startBeat}`
    case 'RemoveClip': return `Remove a clip from "${track()}"`
    case 'MoveClip': return `Move a clip on "${track()}" to beat ${args.startBeat}`
    case 'DuplicateClip': return `Duplicate a clip on "${track()}"`
    case 'TileClip': return `Repeat a clip on "${track()}" up to beat ${args.endBeat}`
    case 'SetMidiClipNotes': return `Replace the notes in a clip on "${track()}" with ${args.notes.length} note${args.notes.length === 1 ? '' : 's'}`
    case 'AddMidiNote': return `Add a note at pitch ${args.note.pitch} to a clip on "${track()}"`
    case 'RemoveMidiNote': return `Remove a note from a clip on "${track()}"`
    case 'SetMixerParam': return `Set ${args.param} on "${channel()}" to ${args.value}`
    case 'SetSendLevel': return `Set the ${args.busId} send on "${channel()}" to ${args.level}`
    case 'AddEffect': return `Add a ${args.type} effect to "${track()}"`
    case 'RemoveEffect': return `Remove an effect from "${track()}"`
    case 'SetEffectParam': return `Set ${args.param} to ${args.value} on an effect on "${track()}"`
    case 'SetPatternStep': return `${args.patch.on === false ? 'Clear' : 'Set'} ${args.instrumentId} step ${args.stepIndex + 1} in bar ${args.barIndex + 1}`
    case 'SetBarParam': return `Set ${args.key} to ${args.value} in bar ${args.barIndex + 1}`
    case 'ClearBar': return `Clear bar ${args.barIndex + 1}`
    case 'AddBar': return args.copyFrom === null ? 'Add an empty bar' : `Add a copy of bar ${args.copyFrom + 1}`
    case 'SetChain': return `Play bars ${args.chain.map(index => index + 1).join(', ')}`
    case 'AddModule': return `Add a ${args.type.toUpperCase()} module to ${rack()}, rail ${args.rail + 1}`
    case 'RemoveModule': return `Remove ${mod()} from ${rack()}`
    case 'MoveModule': return `Move ${mod()} to rail ${args.rail + 1} of ${rack()}`
    case 'SetModuleParam': return `Set ${args.key} to ${args.value} on ${mod()}`
    case 'SetAttenuverter': return `Set the ${args.portId} attenuverter on ${mod()} to ${args.value}`
    case 'SetModuleBypass': return `${args.bypassed ? 'Bypass' : 'Un-bypass'} ${mod()} in ${rack()}`
    case 'Connect': return `Patch ${args.from.port} into ${args.to.port} in ${rack()}`
    case 'Disconnect': return `Unpatch a cable in ${rack()}`
    case 'SetInstrumentParam': return `Set ${args.key} to ${args.value} on ${track()}`
    case 'SetTrackInstrumentProgram': { const names = patchName(); return `Set the instrument on ${track()} to "${names.patch}" from ${names.pack}` }
    default: return action.action
  }
}

// Command factories live in the renderer store; src/shared must not import it,
// and the store also owns module-level singleton state.  So this returns
// *calls* — a factory name from our own frozen table plus its arguments — and
// the renderer binds them to the real factories.
const CALLS = {
  SetBpm: a => ['SetBpm', a.bpm],
  AddTrack: (a, mint, ids) => ['AddTrack', a.type, a.name, { trackId: ids.trackId, channelId: ids.channelId }],
  RemoveTrack: a => ['RemoveTrack', a.trackId],
  SetTrackInstrument: a => ['SetTrackInstrument', a.trackId, a.instrument],
  SetTrackMidiChannel: a => ['SetTrackMidiChannel', a.trackId, a.channel],
  AddClip: (a, mint, ids) => ['AddClip', a.trackId, { id: ids.clipId, ...a.clip, notes: a.clip.notes.map(item => ({ id: mint('note'), ...item })) }],
  RemoveClip: a => ['RemoveClip', a.trackId, a.clipId],
  MoveClip: a => ['MoveClip', a.trackId, a.clipId, a.startBeat],
  DuplicateClip: a => ['DuplicateClip', a.trackId, a.clipId],
  TileClip: a => ['TileClip', a.trackId, a.clipId, a.endBeat],
  SetMidiClipNotes: (a, mint) => ['SetMidiClipNotes', a.trackId, a.clipId, a.notes.map(item => ({ id: mint('note'), ...item }))],
  AddMidiNote: (a, mint, ids) => ['AddMidiNote', a.trackId, a.clipId, { id: ids.noteId, ...a.note }],
  RemoveMidiNote: a => ['RemoveMidiNote', a.trackId, a.clipId, a.noteId],
  SetMixerParam: a => ['SetMixerParam', a.channelId, a.param, a.value],
  SetSendLevel: a => ['SetSendLevel', a.channelId, a.busId, a.level],
  AddEffect: (a, mint, ids) => ['AddEffect', a.trackId, a.type, a.params, ids.effectId],
  RemoveEffect: a => ['RemoveEffect', a.trackId, a.effectId],
  SetEffectParam: a => ['SetEffectParam', a.trackId, a.effectId, a.param, a.value],
  SetPatternStep: a => ['SetPatternStep', a.patternId, a.barIndex, a.instrumentId, a.stepIndex, a.patch],
  SetBarParam: a => ['SetBarParam', a.patternId, a.barIndex, a.key, a.value],
  ClearBar: a => ['ClearBar', a.patternId, a.barIndex],
  AddBar: a => ['AddBar', a.patternId, { copyFrom: a.copyFrom }],
  SetChain: a => ['SetChain', a.patternId, a.chain],
  AddModule: (a, mint, ids) => ['AddModule', a.rackId, a.type, { rail: a.rail, hp: a.hp, params: a.params, id: ids.moduleId }],
  RemoveModule: a => ['RemoveModule', a.rackId, a.moduleId],
  MoveModule: a => ['MoveModule', a.rackId, a.moduleId, a.rail, a.hp],
  SetModuleParam: a => ['SetModuleParam', a.rackId, a.moduleId, a.key, a.value],
  SetAttenuverter: a => ['SetAttenuverter', a.rackId, a.moduleId, a.portId, a.value],
  SetModuleBypass: a => ['SetModuleBypass', a.rackId, a.moduleId, a.bypassed],
  Connect: a => ['Connect', a.rackId, a.from, a.to],
  Disconnect: a => ['Disconnect', a.rackId, a.cableId],
  SetInstrumentParam: a => ['SetInstrumentParam', a.trackId, a.key, a.value],
  // packSelection is caller-injected (the renderer's installed pack manifest),
  // never the model's packId/patchId strings used as-is.
  SetTrackInstrumentProgram: (a, mint, ids, packSelection) => ['SetTrackInstrumentProgram', a.trackId, packSelection(a.packId, a.patchId)],
}

/** Every id a creating action needs, minted before anything executes — so a
 *  later action in the same plan can name it, and so the store mints nothing. */
const MINTED = {
  AddTrack: mint => ({ trackId: mint('track'), channelId: mint('channel') }),
  AddClip: mint => ({ clipId: mint('clip') }),
  AddMidiNote: mint => ({ noteId: mint('note') }),
  AddEffect: mint => ({ effectId: mint('effect') }),
  AddModule: mint => ({ moduleId: mint('mod') }),
}

/** Actions that need an id from the caller (SetMidiClipNotes mints per note). */
const MINTS_IDS = new Set([...Object.keys(MINTED), 'SetMidiClipNotes'])

/**
 * -> [{ factory, args }] in plan order.  Throws if the plan never passed a
 * validator: reaching here with an unvalidated plan is a caller bug.
 * New ids come from the injected `makeId(kind)`, never from counting state:
 * two applies of one plan against one stale state must not collide, and a
 * derived fallback would silently reintroduce exactly that.  Every id is minted
 * here and passed to the store, so a $ref resolves to the id the command will
 * actually use and nothing is minted during execution.
 */
export function planToCommands(plan, state, { makeId, packSelection } = {}) {
  const shape = validatePlanShape(plan)
  if (!shape.ok) throw new TypeError(`planToCommands got an invalid plan: ${shape.errors[0]}`)
  if (typeof makeId !== 'function' && shape.value.actions.some(({ action }) => MINTS_IDS.has(action))) {
    throw new TypeError('planToCommands needs a makeId(kind) for plans that create tracks, clips, notes, effects or modules')
  }
  if (typeof packSelection !== 'function' && shape.value.actions.some(({ action }) => action === 'SetTrackInstrumentProgram')) {
    throw new TypeError('planToCommands needs a packSelection(packId, patchId) for plans that select a pack patch')
  }
  const refs = new Map()
  return shape.value.actions.map(({ action, args: named, ref }) => {
    const args = resolveRefs(named, (slot, wanted) => {
      const key = REF_SLOTS[slot][refs.get(wanted)?.action]
      // validatePlan already refused these; reaching here is a caller bug.
      if (!key) throw new TypeError(`planToCommands got an unresolvable $ref "${wanted}"`)
      return refs.get(wanted).ids[key]
    })
    const ids = MINTED[action] ? MINTED[action](makeId) : {}
    if (ref) refs.set(ref, { action, ids })
    const [factory, ...factoryArgs] = CALLS[action](args, makeId, ids, packSelection)
    return { factory, args: factoryArgs }
  })
}
