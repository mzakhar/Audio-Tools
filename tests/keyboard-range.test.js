import { describe, expect, it } from 'vitest'
import { windowForNote, shiftWindow, MIDI_MAX } from '../src/renderer/js/keyboard-range.js'

const START = 48, END = 72 // the 25-key default

describe('windowForNote', () => {
  it('leaves the window alone when the note already fits', () => {
    for (const note of [START, 60, END]) {
      expect(windowForNote(START, END, note)).toEqual({ start: START, end: END })
    }
  })

  it('scrolls down in whole octaves until the note is inside', () => {
    expect(windowForNote(START, END, 47)).toEqual({ start: 36, end: 60 })
    expect(windowForNote(START, END, 35)).toEqual({ start: 24, end: 48 })
    expect(windowForNote(START, END, 0)).toEqual({ start: 0, end: 24 })
  })

  it('scrolls up in whole octaves until the note is inside', () => {
    expect(windowForNote(START, END, 73)).toEqual({ start: 60, end: 84 })
    expect(windowForNote(START, END, 85)).toEqual({ start: 72, end: 96 })
  })

  it('keeps the shift a multiple of an octave and the note inside', () => {
    for (let note = 12; note <= 115; note++) {
      const win = windowForNote(START, END, note)
      expect(Math.abs((win.start - START) % 12)).toBe(0)
      expect(win.end - win.start).toBe(END - START)
      expect(note).toBeGreaterThanOrEqual(win.start)
      expect(note).toBeLessThanOrEqual(win.end)
    }
  })

  it('never leaves the MIDI range', () => {
    expect(windowForNote(START, END, 0).start).toBe(0)
    expect(windowForNote(START, END, MIDI_MAX).end).toBeLessThanOrEqual(MIDI_MAX)
  })
})

describe('shiftWindow', () => {
  it('moves by whole octaves', () => {
    expect(shiftWindow(START, END, -1)).toEqual({ start: 36, end: 60 })
    expect(shiftWindow(START, END, 2)).toEqual({ start: 72, end: 96 })
  })

  it('refuses to walk off either end', () => {
    expect(shiftWindow(0, 24, -1)).toEqual({ start: 0, end: 24 })
    expect(shiftWindow(96, 120, 1).end).toBeLessThanOrEqual(MIDI_MAX)
  })
})
