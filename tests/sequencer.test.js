import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('../src/renderer/js/audio-engine.js', () => ({
  default: {
    getContext: () => ({ currentTime: 0 }),
    getMasterInput: () => null,
    init: vi.fn()
  }
}))

import Sequencer from '../src/renderer/js/sequencer.js'
import { padToNote, GM_PERCUSSION } from '../src/renderer/js/instruments/pad-map.js'

function mount(deps = {}) {
  document.body.innerHTML = '<div id="seq-tracks"></div>'
  Sequencer.init('seq-tracks', deps)
  return document.getElementById('seq-tracks')
}

/** Rows, skipping the step-number header. */
function rows(container) {
  return [...container.querySelectorAll('.seq-track-row:not(.header)')]
}

describe('Sequencer', () => {
  beforeEach(() => {
    Sequencer.stop()
    document.body.innerHTML = ''
    vi.clearAllMocks()
  })
  afterEach(() => Sequencer.stop())

  // ─── Row model ────────────────────────────────────────────────────────────

  describe('rows', () => {
    it('defaults to four pad rows and four note rows', () => {
      mount()
      const tracks = Sequencer.getTracks()
      expect(tracks.map(t => t.kind)).toEqual(['pad','pad','pad','pad','note','note','note','note'])
      expect(tracks.every(t => t.steps.length === 16)).toBe(true)
      expect(tracks.every(t => !('paletteKey' in t) && !('drumIndex' in t))).toBe(true)
    })

    it('resolves the default pad rows to GM notes through pad-map', () => {
      mount()
      const padNotes = Sequencer.getTracks().filter(t => t.kind === 'pad').map(t => t.note)
      expect(padNotes).toEqual([1, 2, 5, 4].map(slot => padToNote('A', slot)))
      expect(padNotes.map(n => GM_PERCUSSION[n]))
        .toEqual(['Bass Drum 1', 'Acoustic Snare', 'Closed Hi Hat', 'Hand Clap'])
    })

    it('tags rows with kind and, for pads, the bank', () => {
      const container = mount()
      const [first, , , , note] = rows(container)
      expect(first.dataset.kind).toBe('pad')
      expect(first.dataset.bank).toBe('A')
      expect(note.dataset.kind).toBe('note')
      expect(note.dataset.bank).toBeUndefined()
    })

    it('switching a row to NOTE rebuilds it as a pitched row', () => {
      const container = mount()
      const kindSel = rows(container)[0].querySelector('.track-kind-sel')
      kindSel.value = 'note'
      kindSel.dispatchEvent(new window.Event('change'))
      expect(Sequencer.getTracks()[0]).toMatchObject({ kind: 'note', note: 60 })
      expect(rows(container)[0].dataset.kind).toBe('note')
    })
  })

  // ─── Playback ─────────────────────────────────────────────────────────────

  describe('playback', () => {
    it('calls the injected playNote with the row note and a future time', () => {
      const playNote = vi.fn()
      const container = mount({ playNote })
      rows(container)[0].querySelector('.seq-cell[data-step="0"]').click()

      Sequencer.play()
      Sequencer.stop()

      expect(playNote).toHaveBeenCalledTimes(1)
      const [note, velocity, time] = playNote.mock.calls[0]
      expect(note).toBe(padToNote('A', 1))
      expect(velocity).toBeGreaterThan(0)
      expect(time).toBeGreaterThan(0)   // ctx.currentTime is 0 in the mock
    })

    it('stays silent instead of throwing when no playNote is injected', () => {
      const container = mount()
      rows(container)[0].querySelector('.seq-cell[data-step="0"]').click()
      expect(() => { Sequencer.play(); Sequencer.stop() }).not.toThrow()
    })

    it('does not throw when stop() is called without prior play()', () => {
      expect(() => Sequencer.stop()).not.toThrow()
    })

    it('does not throw when play() is called twice in a row', () => {
      mount()
      expect(() => { Sequencer.play(); Sequencer.play() }).not.toThrow()
    })

    it('tracks isPlaying across play/stop', () => {
      mount()
      expect(Sequencer.isPlaying()).toBe(false)
      Sequencer.play()
      expect(Sequencer.isPlaying()).toBe(true)
      Sequencer.stop()
      expect(Sequencer.isPlaying()).toBe(false)
    })
  })

  // ─── Track mutations ──────────────────────────────────────────────────────

  describe('addTrack', () => {
    it('appends a note row in the new shape', () => {
      const container = mount()
      const before = rows(container).length
      Sequencer.addTrack()
      expect(rows(container)).toHaveLength(before + 1)
      const added = Sequencer.getTracks().at(-1)
      expect(added).toMatchObject({ kind: 'note', note: 60 })
      expect(added.steps).toHaveLength(16)
    })
  })

  describe('clear', () => {
    it('unsets every step and its cell', () => {
      const container = mount()
      container.querySelectorAll('.seq-cell[data-step="0"]').forEach(c => c.click())
      expect(container.querySelectorAll('.seq-cell.active').length).toBeGreaterThan(0)

      Sequencer.clear()

      expect(container.querySelectorAll('.seq-cell.active')).toHaveLength(0)
      expect(Sequencer.getTracks().every(t => t.steps.every(s => s === false))).toBe(true)
      expect(Sequencer.getTracks()).toHaveLength(8)
    })

    it('does not throw when clear() is called without init', () => {
      expect(() => Sequencer.clear()).not.toThrow()
    })
  })

  // ─── BPM ──────────────────────────────────────────────────────────────────

  describe('setBPM', () => {
    it.each([[30, 40], [250, 220], [40, 40], [120, 120], [220, 220]])(
      'clamps %i to %i', (input, expected) => {
        Sequencer.setBPM(input)
        expect(Sequencer.getBPM()).toBe(expected)
      })
  })
})
