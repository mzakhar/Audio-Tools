/**
 * MidiController.js
 * Wraps the Web MIDI API: device enumeration, input selection,
 * live note routing (fires CustomEvents on document), and
 * punch-in recording to produce MidiClip note arrays.
 */
import { parseMidiMessage } from './midi-message.js'
import { applyVelocityCurve, curveForDevice } from '../pads/velocity-curve.js'

let _noteIdCounter = 0
function genNoteId() { return `mn-${++_noteIdCounter}-${Date.now()}` }

const MidiController = {
  _access: null,
  _input: null,       // currently subscribed MIDIInput
  _curve: curveForDevice(''), // velocity shaping for that device, resolved at selection
  _sysex: false,      // granted SysEx; the SMC-PAD LED link needs it
  _noteMap: null,     // device note → played note (SMC-PAD user preset → kit pads)
  onSysex: null,      // (bytes) => void, for the selected input's SysEx replies
  _recording: false,
  _recordStartPerf: 0, // performance.now() when recording started
  _bpm: 120,
  _pendingNotes: {},   // pitch → { startBeat, velocity }
  _recordedNotes: [],  // completed note objects

  // ── Access ──────────────────────────────────────────────────────────────────

  /**
   * Request MIDI access on an explicit user gesture.
   * Returns { granted: boolean, inputs: [{id, name}], error: string|null }.
   */
  async requestAccess() {
    if (!navigator.requestMIDIAccess) {
      return { granted: false, inputs: [], error: 'Web MIDI API is not supported in this browser.' }
    }
    try {
      // SysEx (approved 2026-11-26) drives the SMC-PAD pad colours. A refusal
      // must not cost the notes, so fall back to plain access.
      try {
        this._access = await navigator.requestMIDIAccess({ sysex: true })
        this._sysex = true
      } catch (err) {
        this._access = await navigator.requestMIDIAccess({ sysex: false })
        this._sysex = false
      }
      this._access.onstatechange = () => {
        document.dispatchEvent(new CustomEvent('midi-device-change', {
          detail: { inputs: this.getInputs() }
        }))
      }
      return { granted: true, inputs: this.getInputs(), error: null }
    } catch (err) {
      return { granted: false, inputs: [], error: err.message || 'MIDI access denied.' }
    }
  },

  /** Returns array of available MIDI inputs: [{ id, name }] */
  getInputs() {
    if (!this._access) return []
    const inputs = []
    this._access.inputs.forEach(input => inputs.push({ id: input.id, name: input.name }))
    return inputs
  },

  /** Select a MIDI input by id ('' to deselect). */
  selectInput(id) {
    if (this._input) {
      this._input.onmidimessage = null
      this._input = null
    }
    this._curve = curveForDevice('')
    this._noteMap = null
    if (!this._access || !id) return
    this._input = this._access.inputs.get(id) ?? null
    if (this._input) {
      this._curve = curveForDevice(this._input.name)
      this._input.onmidimessage = e => this._onMidiMessage(e)
    }
  },

  isGranted() { return this._access !== null },

  /** The out port named like the selected input, or null without SysEx. */
  selectedOutput() {
    if (!this._sysex || !this._input || !this._access.outputs) return null
    for (const output of this._access.outputs.values()) if (output.name === this._input.name) return output
    return null
  },

  /** Translate device notes before anything sees them; null for none. */
  setNoteMap(map) { this._noteMap = map },

  // ── Recording ────────────────────────────────────────────────────────────────

  /** Begin capturing MIDI note events as beat-relative positions. */
  startRecording(bpm) {
    this._bpm = bpm
    this._recordStartPerf = performance.now()
    this._pendingNotes = {}
    this._recordedNotes = []
    this._recording = true
  },

  /**
   * End recording. Any notes still held are closed at the current position.
   * Returns notes[] sorted by startBeat, ready for a MidiClip.
   */
  stopRecording() {
    this._recording = false
    const nowBeat = this._perfToBeat(performance.now())
    for (const pitch of Object.keys(this._pendingNotes)) {
      const p = this._pendingNotes[pitch]
      const duration = Math.max(0.0625, nowBeat - p.startBeat)
      this._recordedNotes.push({
        id: genNoteId(),
        pitch: parseInt(pitch, 10),
        startBeat: p.startBeat,
        duration,
        velocity: p.velocity
      })
    }
    this._pendingNotes = {}
    return this._recordedNotes.slice().sort((a, b) => a.startBeat - b.startBeat)
  },

  // ── Internal ─────────────────────────────────────────────────────────────────

  _perfToBeat(perfNow) {
    return ((perfNow - this._recordStartPerf) / 1000) * (this._bpm / 60)
  },

  _onMidiMessage(e) {
    if (e.data[0] === 0xf0) { this.onSysex?.(e.data); return }
    let parsed = parseMidiMessage(e.data)
    if (!parsed) return
    if (this._noteMap && (parsed.kind === 'note-on' || parsed.kind === 'note-off')) {
      const pitch = this._noteMap.get(parsed.pitch)
      if (pitch != null) parsed = { ...parsed, pitch }
    }
    // A device property, so recordings keep what was heard. 0 = hit dropped.
    if (parsed.kind === 'note-on') {
      const velocity = applyVelocityCurve(parsed.velocity, this._curve)
      if (!velocity) return
      parsed = { ...parsed, velocity }
    }

    document.dispatchEvent(new CustomEvent('midi-event', { detail: { ...parsed, time: e.timeStamp } }))

    if (parsed.kind === 'note-on') {
      const { pitch, velocity } = parsed
      document.dispatchEvent(new CustomEvent('midi-note-on', { detail: { pitch, velocity } }))
      if (this._recording) {
        const startBeat = this._perfToBeat(performance.now())
        this._pendingNotes[pitch] = { startBeat, velocity: velocity / 127 }
      }
      return
    }

    if (parsed.kind === 'note-off') {
      const { pitch } = parsed
      document.dispatchEvent(new CustomEvent('midi-note-off', { detail: { pitch } }))
      if (this._recording && this._pendingNotes[pitch]) {
        const p = this._pendingNotes[pitch]
        const duration = Math.max(0.0625, this._perfToBeat(performance.now()) - p.startBeat)
        this._recordedNotes.push({
          id: genNoteId(),
          pitch,
          startBeat: p.startBeat,
          duration,
          velocity: p.velocity
        })
        delete this._pendingNotes[pitch]
      }
    }
  }
}

export default MidiController
