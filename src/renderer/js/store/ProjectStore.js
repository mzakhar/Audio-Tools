// ProjectStore.js — Central state store for the DAW
// Implements a command pattern for undo/redo.

import { INSTRUMENTS } from '../drums/tr909-kit.js'

// ---------------------------------------------------------------------------
// ID generation (no crypto dependency)
// ---------------------------------------------------------------------------
let _idCounter = 0
function genId(prefix = 'id') { return `${prefix}-${++_idCounter}-${Date.now()}` }

// ---------------------------------------------------------------------------
// Default state schema
// ---------------------------------------------------------------------------
export const CURRENT_VERSION = 4

export const DEFAULT_STATE = {
  version: CURRENT_VERSION,
  bpm: 120,
  timeSignature: [4, 4],
  sampleRate: 44100,
  tracks: [],       // Track[]
  mixer: {
    channels: [],   // MixerChannel[]
    master: { volume: 0.85 }
  },
  patterns: {},     // id → PatternClip data
  buses: [
    { id: 'reverb', name: 'Reverb', returnLevel: 0.8,  params: { decay: 1.5 } },
    { id: 'delay',  name: 'Delay',  returnLevel: 0.6,  params: { time: 0.375, feedback: 0.4 } },
  ],
  racks: {},        // rackId → Rack
}

// ---------------------------------------------------------------------------
// Migration — projects saved before a schema bump
// ---------------------------------------------------------------------------
export function migrate(projectJson) {
  const next = JSON.parse(JSON.stringify(projectJson))
  if ((next.version ?? 1) < 2) {
    if (!next.racks) next.racks = {}
    next.version = 2
  }
  if ((next.version ?? 1) < 3) {
    if (!next.patterns) next.patterns = {}
    next.version = 3
  }
  if ((next.version ?? 1) < 4) {
    // VC lost its MIX jack when its channels started cascading: D carries the
    // mix now. A saved patch still holds cables from `vc.mix`, and the engine
    // drops a cable to a port that no longer exists without a word — the patch
    // would just quietly stop passing signal. Move them to D.
    for (const rack of Object.values(next.racks || {})) {
      const vcIds = new Set((rack.modules || []).filter(m => m.type === 'vc').map(m => m.id))
      for (const cable of rack.cables || []) {
        if (vcIds.has(cable.from?.moduleId) && cable.from.port === 'mix') cable.from.port = 'outd'
      }
    }
    next.version = 4
  }
  for (const track of next.tracks || []) {
    if (track.type === 'midi' && !track.instrument) {
      track.instrument = { type: 'palette', paletteKey: track.paletteKey || 'classic' }
    }
  }
  return next
}

// ---------------------------------------------------------------------------
// Command factories
// Commands are pure: receive state, return new state (no mutation).
// ---------------------------------------------------------------------------

export function AddTrack(type = 'audio', name = 'Track') {
  return {
    label: `Add track "${name}"`,
    execute(state) {
      const next = JSON.parse(JSON.stringify(state))
      const trackId = genId('track')
      const channelId = genId('channel')
      next.tracks.push({
        id: trackId,
        name,
        type,
        mixerChannelId: channelId,
        clips: [],
        effects: []
      })
      if (type === 'midi') next.tracks.at(-1).instrument = { type: 'palette', paletteKey: 'classic' }
      next.mixer.channels.push({
        id: channelId,
        trackId,
        volume: 1.0,
        pan: 0.0,
        mute: false,
        solo: false,
        sends: {},  // busId → level (0..1)
      })
      return next
    },
    undo(state) {
      // undo is handled by ProjectStore restoring prev state
      return state
    }
  }
}

export function RemoveTrack(trackId) {
  return {
    label: `Remove track`,
    execute(state) {
      const next = JSON.parse(JSON.stringify(state))
      const track = next.tracks.find(t => t.id === trackId)
      if (!track) return next
      next.tracks = next.tracks.filter(t => t.id !== trackId)
      next.mixer.channels = next.mixer.channels.filter(
        ch => ch.id !== track.mixerChannelId
      )
      return next
    },
    undo(state) {
      return state
    }
  }
}

export function SetBpm(bpm) {
  const clamped = Math.max(40, Math.min(240, bpm))
  return {
    label: `Set BPM to ${clamped}`,
    execute(state) { return { ...state, bpm: clamped } },
    undo(state)    { return state }
  }
}

export function AddClip(trackId, clip) {
  return {
    label: `Add clip to track`,
    execute(state) {
      const next = JSON.parse(JSON.stringify(state))
      const track = next.tracks.find(t => t.id === trackId)
      if (!track) return next
      track.clips.push(clip)
      return next
    },
    undo(state) {
      return state
    }
  }
}

export function MoveClip(trackId, clipId, newStartBeat) {
  return {
    label: `Move clip`,
    execute(state) {
      const next = JSON.parse(JSON.stringify(state))
      const track = next.tracks.find(t => t.id === trackId)
      if (!track) return next
      const clip = track.clips.find(c => c.id === clipId)
      if (!clip) return next
      clip.startBeat = newStartBeat
      return next
    },
    undo(state) {
      return state
    }
  }
}

export function TrimClip(trackId, clipId, offset, duration) {
  return {
    label: `Trim clip`,
    execute(state) {
      const next = JSON.parse(JSON.stringify(state))
      const track = next.tracks.find(t => t.id === trackId)
      if (!track) return next
      const clip = track.clips.find(c => c.id === clipId)
      if (!clip) return next
      clip.offset = offset
      clip.duration = duration
      return next
    },
    undo(state) {
      return state
    }
  }
}

export function DuplicateClip(trackId, clipId) {
  return {
    label: `Duplicate clip`,
    execute(state) {
      const next = JSON.parse(JSON.stringify(state))
      const track = next.tracks.find(t => t.id === trackId)
      if (!track) return next
      const clip = track.clips.find(c => c.id === clipId)
      if (!clip) return next
      const copy = JSON.parse(JSON.stringify(clip))
      copy.id = `clip-${++_idCounter}-${Date.now()}`
      copy.startBeat = clip.startBeat + clip.duration
      track.clips.push(copy)
      return next
    },
    undo(state) { return state }
  }
}

export function RemoveClip(trackId, clipId) {
  return {
    label: 'Remove clip',
    execute(state) {
      const next = JSON.parse(JSON.stringify(state))
      const track = next.tracks.find(t => t.id === trackId)
      if (!track) return next
      track.clips = track.clips.filter(c => c.id !== clipId)
      return next
    },
    undo(state) { return state }
  }
}

export function TileClip(trackId, clipId, endBeat = 64) {
  return {
    label: 'Tile clip across track',
    execute(state) {
      const next = JSON.parse(JSON.stringify(state))
      const track = next.tracks.find(t => t.id === trackId)
      if (!track) return next
      const clip = track.clips.find(c => c.id === clipId)
      if (!clip || clip.duration <= 0) return next
      let pos = clip.startBeat + clip.duration
      while (pos + clip.duration <= endBeat) {
        const copy = JSON.parse(JSON.stringify(clip))
        copy.id = `clip-${++_idCounter}-${Date.now()}`
        copy.startBeat = pos
        track.clips.push(copy)
        pos += clip.duration
      }
      return next
    },
    undo(state) { return state }
  }
}

export function SetMixerParam(channelId, param, value) {
  return {
    label: `Set mixer ${param}`,
    execute(state) {
      const next = JSON.parse(JSON.stringify(state))
      const channel = next.mixer.channels.find(ch => ch.id === channelId)
      if (!channel) return next
      channel[param] = value
      return next
    },
    undo(state) {
      return state
    }
  }
}

// ---------------------------------------------------------------------------
// FX bus command factories
// ---------------------------------------------------------------------------

export function SetSendLevel(channelId, busId, level) {
  return {
    label: `Set send level for bus "${busId}"`,
    execute(state) {
      const next = JSON.parse(JSON.stringify(state))
      const channel = next.mixer.channels.find(ch => ch.id === channelId)
      if (!channel) return next
      if (!channel.sends) channel.sends = {}
      channel.sends[busId] = Math.max(0, Math.min(1, level))
      return next
    },
    undo(state) {
      return state
    }
  }
}

export function SetBusReturn(busId, level) {
  return {
    label: `Set return level for bus "${busId}"`,
    execute(state) {
      const next = JSON.parse(JSON.stringify(state))
      const bus = next.buses ? next.buses.find(b => b.id === busId) : null
      if (!bus) return next
      bus.returnLevel = Math.max(0, Math.min(1, level))
      return next
    },
    undo(state) {
      return state
    }
  }
}

// ---------------------------------------------------------------------------
// Effect command factories
// ---------------------------------------------------------------------------

export function AddEffect(trackId, type, params = {}) {
  return {
    label: `Add ${type} effect`,
    execute(state) {
      const next = JSON.parse(JSON.stringify(state))
      const track = next.tracks.find(t => t.id === trackId)
      if (!track) return next
      if (!track.effects) track.effects = []
      const effectId = genId('effect')
      track.effects.push({ id: effectId, type, params: { ...params } }) // rack params carry { rack }
      return next
    },
    undo(state) {
      return state
    }
  }
}

export function RemoveEffect(trackId, effectId) {
  return {
    label: `Remove effect`,
    execute(state) {
      const next = JSON.parse(JSON.stringify(state))
      const track = next.tracks.find(t => t.id === trackId)
      if (!track || !track.effects) return next
      track.effects = track.effects.filter(e => e.id !== effectId)
      return next
    },
    undo(state) {
      return state
    }
  }
}

// ---------------------------------------------------------------------------
// MIDI note command factories
// ---------------------------------------------------------------------------

export function AddMidiNote(trackId, clipId, note) {
  return {
    label: 'Add MIDI note',
    execute(state) {
      const next = JSON.parse(JSON.stringify(state))
      const track = next.tracks.find(t => t.id === trackId)
      if (!track) return next
      const clip = track.clips.find(c => c.id === clipId)
      if (!clip) return next
      if (!clip.notes) clip.notes = []
      clip.notes.push(note)
      return next
    },
    undo(state) { return state }
  }
}

export function RemoveMidiNote(trackId, clipId, noteId) {
  return {
    label: 'Remove MIDI note',
    execute(state) {
      const next = JSON.parse(JSON.stringify(state))
      const track = next.tracks.find(t => t.id === trackId)
      if (!track) return next
      const clip = track.clips.find(c => c.id === clipId)
      if (!clip || !clip.notes) return next
      clip.notes = clip.notes.filter(n => n.id !== noteId)
      return next
    },
    undo(state) { return state }
  }
}

export function MoveMidiNote(trackId, clipId, noteId, startBeat, pitch) {
  return {
    label: 'Move MIDI note',
    execute(state) {
      const next = JSON.parse(JSON.stringify(state))
      const track = next.tracks.find(t => t.id === trackId)
      if (!track) return next
      const clip = track.clips.find(c => c.id === clipId)
      if (!clip || !clip.notes) return next
      const note = clip.notes.find(n => n.id === noteId)
      if (!note) return next
      note.startBeat = startBeat
      note.pitch = pitch
      return next
    },
    undo(state) { return state }
  }
}

export function ResizeMidiNote(trackId, clipId, noteId, duration) {
  return {
    label: 'Resize MIDI note',
    execute(state) {
      const next = JSON.parse(JSON.stringify(state))
      const track = next.tracks.find(t => t.id === trackId)
      if (!track) return next
      const clip = track.clips.find(c => c.id === clipId)
      if (!clip || !clip.notes) return next
      const note = clip.notes.find(n => n.id === noteId)
      if (!note) return next
      note.duration = Math.max(0.0625, duration)
      return next
    },
    undo(state) { return state }
  }
}

export function SetMidiNoteVelocity(trackId, clipId, noteId, velocity) {
  return {
    label: 'Set MIDI note velocity',
    execute(state) {
      const next = JSON.parse(JSON.stringify(state))
      const track = next.tracks.find(t => t.id === trackId)
      if (!track) return next
      const clip = track.clips.find(c => c.id === clipId)
      if (!clip || !clip.notes) return next
      const note = clip.notes.find(n => n.id === noteId)
      if (!note) return next
      note.velocity = Math.max(0.01, Math.min(1, velocity))
      return next
    },
    undo(state) { return state }
  }
}

export function SetMidiClipNotes(trackId, clipId, notes) {
  return {
    label: 'Set MIDI clip notes',
    execute(state) {
      const next = JSON.parse(JSON.stringify(state))
      const track = next.tracks.find(t => t.id === trackId)
      if (!track) return next
      const clip = track.clips.find(c => c.id === clipId)
      if (!clip) return next
      clip.notes = notes
      return next
    },
    undo(state) { return state }
  }
}

export function SetEffectParam(trackId, effectId, param, value) {
  return {
    label: `Set effect param ${param}`,
    execute(state) {
      const next = JSON.parse(JSON.stringify(state))
      const track = next.tracks.find(t => t.id === trackId)
      if (!track || !track.effects) return next
      const effect = track.effects.find(e => e.id === effectId)
      if (!effect) return next
      effect.params[param] = value
      return next
    },
    undo(state) {
      return state
    }
  }
}

// ---------------------------------------------------------------------------
// Modular rack command factories
//
// Rack state is plain JSON (see specs/modular-rack.md §5.1):
//   { id, name, rails, railHp, cableColorMode, polyLimit, modules[], cables[] }
// `hp` on a module is its left offset in HP within its rail; width comes from
// the module registry, never from state.
// ---------------------------------------------------------------------------

export const DEFAULT_RACK = {
  rails: 2,
  railHp: 104,
  cableColorMode: 'kind',
  polyLimit: 8,
}

// Every rack command is "clone state, mutate one rack, return it".
function rackCommand(label, rackId, mutate) {
  return {
    label,
    execute(state) {
      const next = JSON.parse(JSON.stringify(state))
      if (!next.racks) next.racks = {}
      const rack = next.racks[rackId]
      if (!rack) return next
      mutate(rack, next)
      return next
    },
    undo(state) { return state }
  }
}

export function SetRackRails(rackId, rails) {
  return rackCommand(`Set rails to ${rails}`, rackId, rack => { rack.rails = Math.max(1, Math.min(8, rails | 0)) })
}

export function AddRack(name = 'Rack', rackId = null) {
  return {
    label: `Add rack "${name}"`,
    execute(state) {
      const next = JSON.parse(JSON.stringify(state))
      if (!next.racks) next.racks = {}
      const id = rackId || genId('rack')
      next.racks[id] = { id, name, ...DEFAULT_RACK, modules: [], cables: [] }
      return next
    },
    undo(state) { return state }
  }
}

export function RemoveRack(rackId) {
  return {
    label: 'Remove rack',
    execute(state) {
      const next = JSON.parse(JSON.stringify(state))
      if (next.racks) delete next.racks[rackId]
      return next
    },
    undo(state) { return state }
  }
}

export function RenameRack(rackId, name) {
  return rackCommand(`Rename rack to "${name}"`, rackId, rack => { rack.name = name })
}

export function AddModule(rackId, type, { rail = 0, hp = 0, params = {}, id = null } = {}) {
  return rackCommand(`Add ${type} module`, rackId, rack => {
    rack.modules.push({
      id: id || genId('mod'),
      type,
      rail,
      hp,
      params: { ...params },
      atten: {},
      bypassed: false,
      name: null
    })
  })
}

export function RemoveModule(rackId, moduleId) {
  return rackCommand('Remove module', rackId, rack => {
    rack.modules = rack.modules.filter(m => m.id !== moduleId)
    rack.cables = rack.cables.filter(
      c => c.from.moduleId !== moduleId && c.to.moduleId !== moduleId
    )
  })
}

export function MoveModule(rackId, moduleId, rail, hp) {
  return rackCommand('Move module', rackId, rack => {
    const mod = rack.modules.find(m => m.id === moduleId)
    if (!mod) return
    mod.rail = rail
    mod.hp = hp
  })
}

export function SetModuleParam(rackId, moduleId, key, value) {
  return rackCommand(`Set ${key}`, rackId, rack => {
    const mod = rack.modules.find(m => m.id === moduleId)
    if (!mod) return
    mod.params[key] = value
  })
}

export function SetAttenuverter(rackId, moduleId, portId, value) {
  return rackCommand(`Set ${portId} attenuverter`, rackId, rack => {
    const mod = rack.modules.find(m => m.id === moduleId)
    if (!mod) return
    if (!mod.atten) mod.atten = {}
    mod.atten[portId] = Math.max(-1, Math.min(1, value))
  })
}

export function SetModuleBypass(rackId, moduleId, bypassed) {
  return rackCommand(bypassed ? 'Bypass module' : 'Un-bypass module', rackId, rack => {
    const mod = rack.modules.find(m => m.id === moduleId)
    if (!mod) return
    mod.bypassed = !!bypassed
  })
}

// from/to are { moduleId, port }. Port direction is validated by the registry
// (rack/modules/index.js canConnect) before dispatch — the store only refuses
// endpoints it can see are wrong: missing modules, self-patch, duplicates.
export function Connect(rackId, from, to, color = null) {
  return rackCommand('Patch cable', rackId, rack => {
    const has = id => rack.modules.some(m => m.id === id)
    if (!has(from.moduleId) || !has(to.moduleId)) return
    if (from.moduleId === to.moduleId && from.port === to.port) return
    const dup = rack.cables.some(c =>
      c.from.moduleId === from.moduleId && c.from.port === from.port &&
      c.to.moduleId === to.moduleId && c.to.port === to.port
    )
    if (dup) return
    rack.cables.push({
      id: genId('cable'),
      from: { moduleId: from.moduleId, port: from.port },
      to: { moduleId: to.moduleId, port: to.port },
      color
    })
  })
}

export function Disconnect(rackId, cableId) {
  return rackCommand('Unpatch cable', rackId, rack => {
    rack.cables = rack.cables.filter(c => c.id !== cableId)
  })
}

export function SetCableColor(rackId, cableId, color) {
  return rackCommand('Set cable colour', rackId, rack => {
    const cable = rack.cables.find(c => c.id === cableId)
    if (cable) cable.color = color
  })
}

// Replace a rack wholesale — preset load, patch import, undo-able as one step.
export function LoadRackPatch(rackId, rackData) {
  return {
    label: 'Load rack patch',
    execute(state) {
      const next = JSON.parse(JSON.stringify(state))
      if (!next.racks) next.racks = {}
      next.racks[rackId] = {
        ...DEFAULT_RACK,
        ...JSON.parse(JSON.stringify(rackData)),
        id: rackId
      }
      const rack = next.racks[rackId]
      if (!Array.isArray(rack.modules)) rack.modules = []
      if (!Array.isArray(rack.cables)) rack.cables = []
      return next
    },
    undo(state) { return state }
  }
}

// ---------------------------------------------------------------------------
// TR-909 pattern bars (specs/tr-909-pattern-bars.md)
//
// state.patterns[patternId] = { id, name, currentBar, chain, bars[] }
// Each bar holds its own scale/shuffle/flam/lastStep/totalAccent and a
// lanes map keyed by INSTRUMENTS id. `chain` is a list of indices into
// `bars`, so a bar can repeat without duplicating its lanes.
// ---------------------------------------------------------------------------

const BAR_PARAM_KEYS = new Set(['scale', 'shuffle', 'flam', 'lastStep', 'totalAccent'])

function makeStep() {
  return { on: false, velocity: 0.85, accent: false, flam: false }
}

export function makeBar() {
  return {
    id: genId('bar'),
    scale: '1/16',
    shuffle: 0,
    flam: 0.18,
    lastStep: 16,
    totalAccent: 0.45,
    lanes: Object.fromEntries(INSTRUMENTS.map(inst => [
      inst.id,
      Array.from({ length: 16 }, makeStep)
    ]))
  }
}

export function makePattern909(id) {
  return {
    id,
    name: '909',
    currentBar: 0,
    chain: [0],
    bars: [makeBar()]
  }
}

// Chain cursor wraparound — pure, used by playback and by tests.
export function nextChainPos(pos, chainLength) {
  if (chainLength <= 0) return 0
  return (pos + 1) % chainLength
}

// Clone state, ensure the pattern exists (creating it via makePattern909 if
// absent), mutate it, return the new state. Mirrors rackCommand above.
function patternCommand(label, patternId, mutate) {
  return {
    label,
    execute(state) {
      const next = JSON.parse(JSON.stringify(state))
      if (!next.patterns) next.patterns = {}
      if (!next.patterns[patternId]) next.patterns[patternId] = makePattern909(patternId)
      mutate(next.patterns[patternId], next)
      return next
    },
    undo(state) { return state }
  }
}

export function SetPatternStep(patternId, barIndex, instrumentId, stepIndex, patch) {
  return patternCommand('Set step', patternId, pattern => {
    const bar = pattern.bars[barIndex]
    if (!bar) return
    const lane = bar.lanes[instrumentId]
    if (!lane || !lane[stepIndex]) return
    Object.assign(lane[stepIndex], patch)
  })
}

export function SetBarParam(patternId, barIndex, key, value) {
  return patternCommand('Set bar param', patternId, pattern => {
    if (!BAR_PARAM_KEYS.has(key)) return
    const bar = pattern.bars[barIndex]
    if (!bar) return
    bar[key] = value
  })
}

export function AddBar(patternId, { copyFrom = null } = {}) {
  return patternCommand('Add bar', patternId, pattern => {
    let bar
    if (copyFrom !== null && pattern.bars[copyFrom]) {
      bar = JSON.parse(JSON.stringify(pattern.bars[copyFrom]))
      bar.id = genId('bar')
    } else {
      bar = makeBar()
    }
    pattern.bars.push(bar)
    pattern.chain.push(pattern.bars.length - 1)
  })
}

export function RemoveBar(patternId, barIndex) {
  return patternCommand('Remove bar', patternId, pattern => {
    if (pattern.bars.length <= 1) return
    if (barIndex < 0 || barIndex >= pattern.bars.length) return
    pattern.bars.splice(barIndex, 1)
    pattern.chain = pattern.chain
      .filter(i => i !== barIndex)
      .map(i => (i > barIndex ? i - 1 : i))
    if (!pattern.chain.length) pattern.chain = [0]
    if (pattern.currentBar >= pattern.bars.length) pattern.currentBar = pattern.bars.length - 1
    else if (pattern.currentBar > barIndex) pattern.currentBar -= 1
  })
}

export function SetCurrentBar(patternId, barIndex) {
  return patternCommand('Set current bar', patternId, pattern => {
    if (barIndex < 0 || barIndex >= pattern.bars.length) return
    pattern.currentBar = barIndex
  })
}

export function SetChain(patternId, chain) {
  return patternCommand('Set chain', patternId, pattern => {
    pattern.chain = [...chain]
  })
}

export function ClearBar(patternId, barIndex) {
  return patternCommand('Clear bar', patternId, pattern => {
    const bar = pattern.bars[barIndex]
    if (!bar) return
    for (const instId of Object.keys(bar.lanes)) {
      bar.lanes[instId] = Array.from({ length: bar.lanes[instId].length }, makeStep)
    }
  })
}

// ---------------------------------------------------------------------------
// ProjectStore
// ---------------------------------------------------------------------------
const MAX_HISTORY = 100

let _state = JSON.parse(JSON.stringify(DEFAULT_STATE))
let _undoStack = []
let _redoStack = []
const _listeners = new Set()

function notify() {
  _listeners.forEach(fn => fn(_state))
}

const ProjectStore = {
  getState() { return JSON.parse(JSON.stringify(_state)) },

  dispatch(command) {
    const next = command.execute(_state)
    _undoStack.push({ command, prev: _state })
    if (_undoStack.length > MAX_HISTORY) _undoStack.shift()
    _redoStack = []
    _state = next
    notify()
  },

  undo() {
    if (!_undoStack.length) return
    const { command, prev } = _undoStack.pop()
    _redoStack.push({ command, next: _state })
    _state = prev
    notify()
  },

  redo() {
    if (!_redoStack.length) return
    const { command, next } = _redoStack.pop()
    _undoStack.push({ command, prev: _state })
    _state = next
    notify()
  },

  canUndo() { return _undoStack.length > 0 },
  canRedo() { return _redoStack.length > 0 },
  getUndoStackSize() { return _undoStack.length },
  getUndoLabel() { return _undoStack.at(-1)?.command.label ?? null },
  getRedoLabel() { return _redoStack.at(-1)?.command.label ?? null },

  subscribe(listener) {
    _listeners.add(listener)
    return () => _listeners.delete(listener)
  },

  load(projectJson) {
    _state = migrate(projectJson)
    _undoStack = []
    _redoStack = []
    notify()
  },

  reset() {
    _state = JSON.parse(JSON.stringify(DEFAULT_STATE))
    _undoStack = []
    _redoStack = []
    notify()
  }
}

export default ProjectStore
