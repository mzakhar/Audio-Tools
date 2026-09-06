import { describe, it, expect } from 'vitest'
import { MODES, MAX_CITED, validateAnswerShape, resolveCitation, resolveCitations } from '../src/shared/daw-assistant/ask.js'

const digest = () => ({
  bpm: 128,
  tracks: [{ id: 'trk-1', name: 'Kick', mute: true }],
  mixer: [{ id: 'chan-1', volume: 0.8 }],
})

describe('MODES', () => {
  it('is exactly plan and ask', () => {
    expect(MODES).toEqual(['plan', 'ask'])
  })
})

describe('validateAnswerShape', () => {
  it('accepts a plain answer with citations', () => {
    const result = validateAnswerShape({ answer: 'Kick is muted.', cited: ['tracks.0.mute'] })
    expect(result.ok).toBe(true)
    expect(result.value).toEqual({ answer: 'Kick is muted.', cited: ['tracks.0.mute'] })
  })

  it('refuses an answer carrying an actions field, even if otherwise valid', () => {
    const result = validateAnswerShape({ answer: 'ok', cited: [], actions: [{ action: 'SetBpm', args: { bpm: 128 } }] })
    expect(result.ok).toBe(false)
    expect(result.errors.join(' ')).toMatch(/actions/)
  })

  it('refuses cited over the entry cap', () => {
    const cited = Array.from({ length: MAX_CITED + 1 }, (_, i) => `bpm${i}`)
    const result = validateAnswerShape({ answer: 'ok', cited })
    expect(result.ok).toBe(false)
  })

  it('refuses a cited entry that is not a conservative path', () => {
    const result = validateAnswerShape({ answer: 'ok', cited: ['tracks[0].mute'] })
    expect(result.ok).toBe(false)
  })

  it('refuses a non-string answer', () => {
    expect(validateAnswerShape({ answer: 42, cited: [] }).ok).toBe(false)
    expect(validateAnswerShape(null).ok).toBe(false)
  })
})

describe('resolveCitation', () => {
  it('walks a numeric segment into an array', () => {
    expect(resolveCitation(digest(), 'tracks.0.mute')).toEqual({ path: 'tracks.0.mute', value: true })
  })

  it('resolves a top-level scalar', () => {
    expect(resolveCitation(digest(), 'bpm')).toEqual({ path: 'bpm', value: 128 })
  })

  it('returns null for a missing path', () => {
    expect(resolveCitation(digest(), 'tracks.5.mute')).toBeNull()
    expect(resolveCitation(digest(), 'tracks.0.nope')).toBeNull()
  })

  it('returns null for an object or array leaf', () => {
    expect(resolveCitation(digest(), 'tracks.0')).toBeNull()
    expect(resolveCitation(digest(), 'tracks')).toBeNull()
  })

  it('returns null for a __proto__ segment, never touching the prototype chain', () => {
    expect(resolveCitation(digest(), '__proto__.polluted')).toBeNull()
    expect(resolveCitation(digest(), 'tracks.0.__proto__')).toBeNull()
  })
})

describe('resolveCitations', () => {
  it('drops unresolvable entries and keeps the rest in order', () => {
    const resolved = resolveCitations(digest(), ['bpm', 'tracks.0.nope', 'mixer.0.volume'])
    expect(resolved).toEqual([{ path: 'bpm', value: 128 }, { path: 'mixer.0.volume', value: 0.8 }])
  })
})
