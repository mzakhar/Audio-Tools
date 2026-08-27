import { describe, it, expect } from 'vitest'
import { parseMidiMessage } from '../src/renderer/js/midi/midi-message.js'

describe('note-on', () => {
  it('parses a note-on with velocity > 0', () => {
    expect(parseMidiMessage([0x90, 60, 100])).toEqual({ kind: 'note-on', channel: 0, pitch: 60, velocity: 100 })
  })

  it('velocity 0 parses as note-off', () => {
    expect(parseMidiMessage([0x90, 60, 0])).toEqual({ kind: 'note-off', channel: 0, pitch: 60 })
  })

  it('channel nibble survives on channel 15', () => {
    expect(parseMidiMessage([0x9f, 60, 100])).toEqual({ kind: 'note-on', channel: 15, pitch: 60, velocity: 100 })
  })
})

describe('note-off', () => {
  it('parses a 0x80 note-off', () => {
    expect(parseMidiMessage([0x80, 60, 0])).toEqual({ kind: 'note-off', channel: 0, pitch: 60 })
  })

  it('channel nibble survives on channel 15', () => {
    expect(parseMidiMessage([0x8f, 60, 0])).toEqual({ kind: 'note-off', channel: 15, pitch: 60 })
  })
})

describe('cc', () => {
  it('parses controller and raw value', () => {
    expect(parseMidiMessage([0xb0, 7, 100])).toEqual({ kind: 'cc', channel: 0, controller: 7, value: 100 })
  })

  it('channel nibble survives on channel 15', () => {
    expect(parseMidiMessage([0xbf, 7, 100])).toEqual({ kind: 'cc', channel: 15, controller: 7, value: 100 })
  })
})

describe('pitch-bend', () => {
  it('centre (8192) normalises to exactly 0', () => {
    expect(parseMidiMessage([0xe0, 0, 64])).toEqual({ kind: 'pitch-bend', channel: 0, value: 0 })
  })

  it('minimum bends to exactly -1', () => {
    expect(parseMidiMessage([0xe0, 0, 0])).toEqual({ kind: 'pitch-bend', channel: 0, value: -1 })
  })

  it('maximum bends to exactly +1', () => {
    expect(parseMidiMessage([0xe0, 127, 127])).toEqual({ kind: 'pitch-bend', channel: 0, value: 1 })
  })

  it('channel nibble survives on channel 15', () => {
    expect(parseMidiMessage([0xef, 0, 64])).toEqual({ kind: 'pitch-bend', channel: 15, value: 0 })
  })
})

describe('realtime', () => {
  it('parses clock', () => {
    expect(parseMidiMessage([0xf8])).toEqual({ kind: 'clock' })
  })

  it('parses start', () => {
    expect(parseMidiMessage([0xfa])).toEqual({ kind: 'start' })
  })

  it('parses stop', () => {
    expect(parseMidiMessage([0xfc])).toEqual({ kind: 'stop' })
  })

  it('parses continue', () => {
    expect(parseMidiMessage([0xfb])).toEqual({ kind: 'continue' })
  })
})

describe('unhandled', () => {
  it('returns null for sysex', () => {
    expect(parseMidiMessage([0xf0, 0x7e, 0xf7])).toBe(null)
  })

  it('parses a program change', () => {
    expect(parseMidiMessage([0xcf, 5])).toEqual({ kind: 'program-change', channel: 15, program: 5 })
  })
})

describe('poly-aftertouch', () => {
  it('parses pitch and pressure', () => {
    expect(parseMidiMessage([0xa0, 60, 100])).toEqual({ kind: 'poly-aftertouch', channel: 0, pitch: 60, pressure: 100 })
  })

  it('channel nibble survives on channel 15', () => {
    expect(parseMidiMessage([0xaf, 60, 100])).toEqual({ kind: 'poly-aftertouch', channel: 15, pitch: 60, pressure: 100 })
  })
})

describe('channel-aftertouch', () => {
  it('parses pressure', () => {
    expect(parseMidiMessage([0xd0, 90])).toEqual({ kind: 'channel-aftertouch', channel: 0, pressure: 90 })
  })

  it('channel nibble survives on channel 15', () => {
    expect(parseMidiMessage([0xdf, 90])).toEqual({ kind: 'channel-aftertouch', channel: 15, pressure: 90 })
  })
})
