// ProjectStore.js — Central state store for the DAW
// Implements a command pattern for undo/redo.

// ---------------------------------------------------------------------------
// ID generation (no crypto dependency)
// ---------------------------------------------------------------------------
let _idCounter = 0
function genId(prefix = 'id') { return `${prefix}-${++_idCounter}-${Date.now()}` }

// ---------------------------------------------------------------------------
// Default state schema
// ---------------------------------------------------------------------------
export const DEFAULT_STATE = {
  version: 1,
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
// ID generation for effects (shared with the module-level genId)
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
      track.effects.push({ id: effectId, type, params: { ...params } })
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
    _state = JSON.parse(JSON.stringify(projectJson))
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
