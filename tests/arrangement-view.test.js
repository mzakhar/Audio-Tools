import { describe, it, expect, beforeEach, vi } from 'vitest'
import { hitTestClip, packOptionValue, packPatchOptions, packInstrumentLabel } from '../src/renderer/js/components/arrangement-view.js'

// Mock ProjectStore imports used inside arrangement-view.js
vi.mock('../src/renderer/js/store/ProjectStore.js', () => ({
  default: {
    getState: vi.fn(() => ({
      bpm: 120, sampleRate: 44100, timeSignature: [4, 4],
      tracks: [], mixer: { channels: [], master: { volume: 1 } },
      patterns: {}, version: 1
    })),
    subscribe: vi.fn(() => () => {}),
    dispatch: vi.fn()
  },
  MoveClip: vi.fn((tid, cid, beat) => ({ label: 'Move', execute: s => s, undo: s => s })),
  TrimClip: vi.fn((tid, cid, off, dur) => ({ label: 'Trim', execute: s => s, undo: s => s }))
}))

vi.mock('../src/renderer/js/utils/timeline-math.js', async () => {
  const actual = await vi.importActual('../src/renderer/js/utils/timeline-math.js')
  return actual
})

vi.mock('../src/renderer/js/audio-store.js', () => ({
  default: { getLod: vi.fn(() => null), isLodReady: vi.fn(() => false) }
}))

describe('hitTestClip', () => {
  const clip = { startBeat: 2, duration: 4, file: 'audio/test.wav' }
  const ppb = 64
  const scrollLeft = 0
  const headerW = 160
  const trackH = 72

  it('returns null when mouse is left of clip', () => {
    // clip starts at beat 2 → x = 2*64 + 160 = 288
    expect(hitTestClip(clip, 100, 0, ppb, scrollLeft, headerW, trackH)).toBeNull()
  })

  it('returns null when mouse is right of clip', () => {
    // clip ends at beat 6 → x = 6*64 + 160 = 544
    expect(hitTestClip(clip, 600, 0, ppb, scrollLeft, headerW, trackH)).toBeNull()
  })

  it('returns trim-left within 8px of left edge', () => {
    const clipX = 2 * ppb + headerW  // = 288
    expect(hitTestClip(clip, clipX + 3, 0, ppb, scrollLeft, headerW, trackH)).toBe('trim-left')
  })

  it('returns trim-right within 8px of right edge', () => {
    const clipX = 2 * ppb + headerW
    const clipW = 4 * ppb
    expect(hitTestClip(clip, clipX + clipW - 3, 0, ppb, scrollLeft, headerW, trackH)).toBe('trim-right')
  })

  it('returns body for center of clip', () => {
    const clipX = 2 * ppb + headerW
    const clipW = 4 * ppb
    expect(hitTestClip(clip, clipX + clipW / 2, 0, ppb, scrollLeft, headerW, trackH)).toBe('body')
  })
})

describe('hitTestClip with scroll', () => {
  it('accounts for scrollLeft', () => {
    const clip = { startBeat: 4, duration: 4, file: 'audio/test.wav' }
    const ppb = 64, scrollLeft = 128, headerW = 160
    // clipX = 4*64 - 128 + 160 = 256 - 128 + 160 = 288
    // clipW = 4*64 = 256 → center = 288 + 128 = 416
    expect(hitTestClip(clip, 416, 0, ppb, scrollLeft, headerW, 72)).toBe('body')
  })
})

describe('pack selector options', () => {
  const catalog = () => [{
    id: 'starter', version: '1.0.0', manifest: {
      id: 'starter', version: '1.0.0', name: 'Starter',
      patches: [{ id: 'piano', name: 'Piano' }]
    }
  }]

  it('lists catalog patches with stable pack selection values', () => {
    expect(packPatchOptions(catalog)).toEqual([{
      value: packOptionValue('starter', '1.0.0', 'piano'),
      label: 'Starter — Piano',
      selection: { packId: 'starter', packVersion: '1.0.0', patchId: 'piano' }
    }])
  })

  it('labels unavailable selected packs without changing selection', () => {
    expect(packInstrumentLabel({ type: 'pack', packId: 'gone', packVersion: '1', patchId: 'piano' }, catalog))
      .toBe('Missing pack: gone@1 — piano')
  })
})
