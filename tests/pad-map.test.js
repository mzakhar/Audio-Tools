import { describe, it, expect } from 'vitest'
import { GM_PERCUSSION, padBank, padToNote, noteToPad, PALETTE_DRUM_NOTES } from '../src/renderer/js/instruments/pad-map.js'

describe('pad-map', () => {
  it('each bank has exactly 8 slots with no duplicate notes', () => {
    const a = padBank('A')
    const b = padBank('B')
    expect(a).toHaveLength(8)
    expect(b).toHaveLength(8)
    const allNotes = [...a, ...b].map(r => r.note)
    expect(new Set(allNotes).size).toBe(allNotes.length)
  })

  it('round-trips padToNote/noteToPad for every slot of both banks', () => {
    for (const bank of ['A', 'B']) {
      for (const row of padBank(bank)) {
        expect(padToNote(bank, row.slot)).toBe(row.note)
        expect(noteToPad(row.note)).toEqual({ bank, slot: row.slot })
      }
    }
  })

  it('returns null for out-of-range slot', () => {
    expect(padToNote('A', 99)).toBeNull()
    expect(padToNote('A', 0)).toBeNull()
    expect(padToNote('Z', 1)).toBeNull()
    expect(noteToPad(1)).toBeNull()
  })

  it('every bank-A note has a GM_PERCUSSION name', () => {
    for (const row of padBank('A')) {
      expect(GM_PERCUSSION[row.note]).toBeTruthy()
    }
  })

  it('PALETTE_DRUM_NOTES covers every note in both banks', () => {
    const allNotes = [...padBank('A'), ...padBank('B')].map(r => r.note)
    for (const note of allNotes) {
      expect(PALETTE_DRUM_NOTES[note]).toBeDefined()
    }
  })

  it('PALETTE_DRUM_NOTES values are all valid palette voice indices 0-3', () => {
    for (const index of Object.values(PALETTE_DRUM_NOTES)) {
      expect(index).toBeGreaterThanOrEqual(0)
      expect(index).toBeLessThanOrEqual(3)
    }
  })

  it('maps every hi-hat to the hihat voice, open included', () => {
    // 46 sat on the clap voice for as long as the map had only four entries.
    // A pad labelled Open Hi-Hat that claps is a pad the player cannot trust.
    const closed = PALETTE_DRUM_NOTES[42]
    for (const note of [42, 44, 46]) expect(PALETTE_DRUM_NOTES[note]).toBe(closed)
    expect(PALETTE_DRUM_NOTES[39]).not.toBe(closed)   // Hand Clap is the clap
  })

  it('pc keys are 1-8 matching slot', () => {
    for (const row of padBank('A')) expect(row.key).toBe(String(row.slot))
  })
})
