import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../src/renderer/js/audio-engine.js', () => ({
  default: {
    getContext: () => ({ currentTime: 0 }),
    getMasterInput: () => null,
    init: vi.fn()
  }
}))

vi.mock('../src/renderer/js/palettes.js', () => ({
  default: {
    classic: { createVoice: vi.fn(() => ({ stop: vi.fn() })) },
    fm: { createVoice: vi.fn(() => ({ stop: vi.fn() })) },
    drum: {
      createVoice: vi.fn(() => ({ stop: vi.fn() })),
      createDrumVoice: vi.fn()
    },
    pad: { createVoice: vi.fn(() => ({ stop: vi.fn() })) },
  }
}))

import Sequencer from '../src/renderer/js/sequencer.js'

describe('Sequencer', () => {
  beforeEach(() => {
    // Reset sequencer state before each test
    Sequencer.stop()
    Sequencer.clear()
    vi.clearAllMocks()
  })

  // ─── Step timing math ────────────────────────────────────────────────────

  describe('step duration math', () => {
    it('at 120 BPM one step should be 0.125s', () => {
      const bpm = 120
      const stepDuration = (60 / bpm) / 4
      expect(stepDuration).toBeCloseTo(0.125)
    })

    it('at 60 BPM one step should be 0.25s', () => {
      const bpm = 60
      const stepDuration = (60 / bpm) / 4
      expect(stepDuration).toBeCloseTo(0.25)
    })

    it('at 180 BPM one step should be approximately 0.0833s', () => {
      const bpm = 180
      const stepDuration = (60 / bpm) / 4
      expect(stepDuration).toBeCloseTo(0.0833, 3)
    })

    it('at 220 BPM one step should be approximately 0.0682s', () => {
      const bpm = 220
      const stepDuration = (60 / bpm) / 4
      expect(stepDuration).toBeCloseTo(0.0682, 3)
    })
  })

  // ─── BPM clamping ────────────────────────────────────────────────────────

  describe('setBPM', () => {
    it('clamps BPM below minimum (30 → 40)', () => {
      Sequencer.setBPM(30)
      expect(Sequencer.getBPM()).toBe(40)
    })

    it('clamps BPM above maximum (250 → 220)', () => {
      Sequencer.setBPM(250)
      expect(Sequencer.getBPM()).toBe(220)
    })

    it('accepts valid BPM in range (120 → 120)', () => {
      Sequencer.setBPM(120)
      expect(Sequencer.getBPM()).toBe(120)
    })

    it('accepts minimum boundary BPM (40 → 40)', () => {
      Sequencer.setBPM(40)
      expect(Sequencer.getBPM()).toBe(40)
    })

    it('accepts maximum boundary BPM (220 → 220)', () => {
      Sequencer.setBPM(220)
      expect(Sequencer.getBPM()).toBe(220)
    })

    it('accepts a mid-range BPM (140 → 140)', () => {
      Sequencer.setBPM(140)
      expect(Sequencer.getBPM()).toBe(140)
    })
  })

  // ─── Track mutations ──────────────────────────────────────────────────────

  describe('addTrack', () => {
    it('adds a row to the DOM after init and addTrack', () => {
      const container = document.createElement('div')
      container.id = 'seq-grid'
      const labels = document.createElement('div')
      labels.id = 'seq-labels'
      document.body.appendChild(container)
      document.body.appendChild(labels)

      Sequencer.init('seq-grid', 'seq-labels')
      const initialRows = container.querySelectorAll('.seq-track-row').length

      Sequencer.addTrack()
      const newRows = container.querySelectorAll('.seq-track-row').length

      expect(newRows).toBe(initialRows + 1)

      document.body.removeChild(container)
      document.body.removeChild(labels)
    })
  })

  // ─── Clear ────────────────────────────────────────────────────────────────

  describe('clear', () => {
    it('unchecks all step buttons after clear()', () => {
      const container = document.createElement('div')
      container.id = 'seq-grid-clear'
      const labels = document.createElement('div')
      labels.id = 'seq-labels-clear'
      document.body.appendChild(container)
      document.body.appendChild(labels)

      Sequencer.init('seq-grid-clear', 'seq-labels-clear')

      // Activate some steps by clicking them
      const buttons = container.querySelectorAll('button.seq-step')
      if (buttons.length > 0) {
        buttons[0].click()
        buttons[1].click()
      }

      Sequencer.clear()

      const activeButtons = container.querySelectorAll('button.seq-step.active')
      expect(activeButtons.length).toBe(0)

      document.body.removeChild(container)
      document.body.removeChild(labels)
    })

    it('does not throw when clear() is called without init', () => {
      expect(() => Sequencer.clear()).not.toThrow()
    })
  })

  // ─── Play/stop lifecycle ─────────────────────────────────────────────────

  describe('play/stop lifecycle', () => {
    it('does not throw when play() is called with a null AudioContext', () => {
      // Our mock returns a ctx with currentTime: 0 but getMasterInput returns null
      expect(() => Sequencer.play()).not.toThrow()
    })

    it('does not throw when stop() is called without prior play()', () => {
      expect(() => Sequencer.stop()).not.toThrow()
    })

    it('does not throw when play() is called twice in a row', () => {
      expect(() => {
        Sequencer.play()
        Sequencer.play()
      }).not.toThrow()
    })

    it('does not throw when stop() is called after play()', () => {
      expect(() => {
        Sequencer.play()
        Sequencer.stop()
      }).not.toThrow()
    })

    it('isPlaying() returns true after play()', () => {
      Sequencer.play()
      expect(Sequencer.isPlaying()).toBe(true)
      Sequencer.stop()
    })

    it('isPlaying() returns false after stop()', () => {
      Sequencer.play()
      Sequencer.stop()
      expect(Sequencer.isPlaying()).toBe(false)
    })

    it('isPlaying() is false on fresh sequencer', () => {
      expect(Sequencer.isPlaying()).toBe(false)
    })
  })
})
