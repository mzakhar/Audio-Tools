/**
 * Tests for MidiController — recording logic (no hardware required).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import MidiController from '../src/renderer/js/midi/MidiController.js'

// Stub navigator.requestMIDIAccess
function setupMockMidi(inputs = []) {
  const inputMap = new Map(inputs.map(({ id, name }) => [id, { id, name, onmidimessage: null }]))
  globalThis.navigator = {
    requestMIDIAccess: vi.fn().mockResolvedValue({
      inputs: inputMap,
      onstatechange: null
    })
  }
  return inputMap
}

beforeEach(() => {
  // Reset internal state
  MidiController._access = null
  MidiController._input = null
  MidiController._recording = false
  MidiController._pendingNotes = {}
  MidiController._recordedNotes = []
})

describe('requestAccess', () => {
  it('returns granted:false when Web MIDI is unavailable', async () => {
    globalThis.navigator = {}
    const result = await MidiController.requestAccess()
    expect(result.granted).toBe(false)
    expect(result.error).toMatch(/not supported/i)
  })

  it('returns granted:true and inputs when API is available', async () => {
    setupMockMidi([{ id: '1', name: 'Keyboard' }])
    const result = await MidiController.requestAccess()
    expect(result.granted).toBe(true)
    expect(result.inputs).toEqual([{ id: '1', name: 'Keyboard' }])
  })

  it('returns granted:false when access is denied', async () => {
    globalThis.navigator = {
      requestMIDIAccess: vi.fn().mockRejectedValue(new Error('User denied'))
    }
    const result = await MidiController.requestAccess()
    expect(result.granted).toBe(false)
    expect(result.error).toMatch(/user denied/i)
  })
})

describe('getInputs', () => {
  it('returns empty array before access is granted', () => {
    expect(MidiController.getInputs()).toEqual([])
  })

  it('lists available inputs after access', async () => {
    setupMockMidi([{ id: '1', name: 'Piano' }, { id: '2', name: 'Pad' }])
    await MidiController.requestAccess()
    expect(MidiController.getInputs()).toHaveLength(2)
  })
})

describe('recording', () => {
  it('stopRecording returns empty array with no notes played', () => {
    MidiController.startRecording(120)
    const notes = MidiController.stopRecording()
    expect(notes).toEqual([])
  })

  it('records a note-on then note-off as a single note', () => {
    MidiController.startRecording(120)
    // Simulate instant note-on / off (same perf timestamp for simplicity)
    const perfStart = performance.now()
    MidiController._recordStartPerf = perfStart - 1000  // 1 second ago = 2 beats at 120 bpm
    // Trigger note-on at t=0 beats (perfNow = recordStartPerf)
    MidiController._pendingNotes[60] = { startBeat: 0, velocity: 0.8 }
    // Trigger note-off 1 beat later
    MidiController._recordStartPerf = performance.now() - 500  // 0.5s = 1 beat at 120bpm
    // Simulate note-off processing
    const startBeat = 0
    const duration = Math.max(0.0625, MidiController._perfToBeat(performance.now()) - startBeat)
    MidiController._recordedNotes.push({ id: 'n1', pitch: 60, startBeat, duration, velocity: 0.8 })
    delete MidiController._pendingNotes[60]

    const notes = MidiController.stopRecording()
    expect(notes).toHaveLength(1)
    expect(notes[0].pitch).toBe(60)
    expect(notes[0].velocity).toBe(0.8)
    expect(notes[0].duration).toBeGreaterThan(0)
  })

  it('closes pending notes on stopRecording', () => {
    MidiController.startRecording(120)
    MidiController._pendingNotes[64] = { startBeat: 0, velocity: 0.7 }
    const notes = MidiController.stopRecording()
    expect(notes).toHaveLength(1)
    expect(notes[0].pitch).toBe(64)
    expect(notes[0].duration).toBeGreaterThanOrEqual(0.0625)
  })

  it('sorts notes by startBeat', () => {
    MidiController.startRecording(120)
    MidiController._recordedNotes = [
      { id: 'n2', pitch: 64, startBeat: 2, duration: 0.5, velocity: 0.8 },
      { id: 'n1', pitch: 60, startBeat: 0, duration: 0.5, velocity: 0.8 }
    ]
    const notes = MidiController.stopRecording()
    expect(notes[0].startBeat).toBe(0)
    expect(notes[1].startBeat).toBe(2)
  })
})

describe('isGranted', () => {
  it('returns false before requestAccess', () => {
    expect(MidiController.isGranted()).toBe(false)
  })

  it('returns true after successful requestAccess', async () => {
    setupMockMidi([])
    await MidiController.requestAccess()
    expect(MidiController.isGranted()).toBe(true)
  })
})

describe('device velocity curve', () => {
  const noteOn = velocity => ({ data: new Uint8Array([0x99, 38, velocity]), timeStamp: 1 })

  it('stretches an SMC-PAD hit to the full range and leaves other devices alone', async () => {
    setupMockMidi([{ id: 'p', name: 'SMC-PAD' }, { id: 'k', name: 'Keystation' }])
    await MidiController.requestAccess()
    const seen = []
    const listener = e => seen.push(e.detail.velocity)
    document.addEventListener('midi-event', listener)
    MidiController.selectInput('p')
    MidiController._input.onmidimessage(noteOn(110))
    MidiController.selectInput('k')
    MidiController._input.onmidimessage(noteOn(110))
    document.removeEventListener('midi-event', listener)
    expect(seen).toEqual([127, 110])
  })
})

describe('SMC-PAD LED link hooks', () => {
  it('asks for SysEx and falls back to plain access when it is refused', async () => {
    const access = { inputs: new Map(), outputs: new Map(), onstatechange: null }
    globalThis.navigator = {
      requestMIDIAccess: vi.fn(opts => opts.sysex ? Promise.reject(new Error('no sysex')) : Promise.resolve(access))
    }
    const result = await MidiController.requestAccess()
    expect(result.granted).toBe(true)
    expect(MidiController._sysex).toBe(false)
  })

  it('routes SysEx to the link, maps pad notes, and finds the matching out port', async () => {
    setupMockMidi([{ id: 'p', name: 'SMC-PAD' }])
    await MidiController.requestAccess()
    MidiController._sysex = true
    MidiController._access.outputs = new Map([['o', { name: 'SMC-PAD' }]])
    MidiController.selectInput('p')
    expect(MidiController.selectedOutput().name).toBe('SMC-PAD')

    const sysex = []
    MidiController.onSysex = bytes => sysex.push(bytes)
    const pitches = []
    const listener = e => pitches.push(e.detail.pitch)
    document.addEventListener('midi-event', listener)
    MidiController.setNoteMap(new Map([[20, 36]]))
    MidiController._input.onmidimessage({ data: new Uint8Array([0xf0, 0x00, 0xf7]), timeStamp: 1 })
    MidiController._input.onmidimessage({ data: new Uint8Array([0x99, 20, 100]), timeStamp: 1 })
    MidiController._input.onmidimessage({ data: new Uint8Array([0x89, 20, 64]), timeStamp: 1 })
    MidiController._input.onmidimessage({ data: new Uint8Array([0x99, 60, 100]), timeStamp: 1 })
    document.removeEventListener('midi-event', listener)
    MidiController.onSysex = null
    expect(sysex).toHaveLength(1)
    expect(pitches).toEqual([36, 36, 60])
  })
})

describe('note map swap', () => {
  it('a note-off follows the pitch its note-on played, even after the map changes', async () => {
    setupMockMidi([{ id: 'p', name: 'SMC-PAD' }])
    await MidiController.requestAccess()
    MidiController.selectInput('p')
    const seen = []
    const listener = e => seen.push(`${e.detail.kind}:${e.detail.pitch}`)
    document.addEventListener('midi-event', listener)
    MidiController.setNoteMap(new Map([[20, 36]]))
    MidiController._input.onmidimessage({ data: new Uint8Array([0x99, 20, 100]), timeStamp: 1 })
    MidiController.setNoteMap(null)
    MidiController._input.onmidimessage({ data: new Uint8Array([0x89, 20, 64]), timeStamp: 1 })
    document.removeEventListener('midi-event', listener)
    expect(seen).toEqual(['note-on:36', 'note-off:36'])
  })
})
