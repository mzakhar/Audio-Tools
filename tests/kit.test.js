import { describe, it, expect } from 'vitest'
import { kitFor, slotParams, velocityTimbre, DEFAULT_KIT_ID } from '../src/renderer/js/pads/kit.js'
import { padBank } from '../src/renderer/js/instruments/pad-map.js'

describe('kitFor', () => {
  it('resolves the default kit and returns null for an unknown one', () => {
    expect(kitFor(DEFAULT_KIT_ID).slots).toBeTruthy()
    expect(kitFor('nope')).toBeNull()
    expect(kitFor(undefined)).toBeNull()
  })

  it('gives notes 36-51 sixteen distinct sounds', () => {
    const kit = kitFor(DEFAULT_KIT_ID)
    const sounds = new Set()
    for (let note = 36; note <= 51; note++) {
      expect(kit.slots[note], `note ${note}`).toBeTruthy()
      sounds.add(kit.slots[note].voice + JSON.stringify(slotParams(kit.slots[note])))
    }
    expect(sounds.size).toBe(16)
  })

  it('answers every pad-bank note and GM 35-59', () => {
    const kit = kitFor(DEFAULT_KIT_ID)
    for (const pad of [...padBank('A'), ...padBank('B')]) expect(kit.slots[pad.note], `pad ${pad.note}`).toBeTruthy()
    for (let note = 35; note <= 59; note++) expect(kit.slots[note], `note ${note}`).toBeTruthy()
  })

  it('puts 42, 44 and 46 in one hat choke group; only 46 is open', () => {
    const { slots } = kitFor(DEFAULT_KIT_ID)
    expect([42, 44, 46].map(n => slots[n].group)).toEqual(['hat', 'hat', 'hat'])
    expect(slots[46].open).toBe(true)
    expect(slots[42].open).toBeUndefined()
    expect(slots[36].group).toBeUndefined()
  })
})

describe('velocityTimbre', () => {
  const params = { level: 0.7, decay: 0.5, tone: 0.6 }

  it('lengthens decay and brightens tone monotonically with velocity', () => {
    let last = velocityTimbre(0, params).params
    for (let v = 0.1; v <= 1.0001; v += 0.1) {
      const next = velocityTimbre(v, params).params
      expect(next.decay).toBeGreaterThan(last.decay)
      expect(next.tone).toBeGreaterThan(last.tone)
      last = next
    }
  })

  it('accents only at the top, never mutates, and skips params a voice lacks', () => {
    expect(velocityTimbre(0.89, params).accent).toBe(false)
    expect(velocityTimbre(0.9, params).accent).toBe(true)
    expect(params).toEqual({ level: 0.7, decay: 0.5, tone: 0.6 })
    expect('decay' in velocityTimbre(0.5, { level: 0.5 }).params).toBe(false)
  })
})
