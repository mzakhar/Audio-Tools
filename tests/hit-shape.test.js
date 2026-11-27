import { describe, it, expect } from 'vitest'
import { shapeHit } from '../src/renderer/js/pads/hit-shape.js'

describe('shapeHit', () => {
  it('plain hit becomes the source', () => {
    const r = shapeHit({}, null, { note: 38, velocity: 90 })
    expect(r).toMatchObject({ note: 38, velocity: 90, source: { note: 38, velocity: 90 } })
    expect(r.override).toBeUndefined()
  })
  it('repeat hits never become the source', () => {
    expect(shapeHit({}, { note: 36, velocity: 50 }, { note: 38, velocity: 90, repeat: true }).source).toEqual({ note: 36, velocity: 50 })
  })
  it('full forces 127', () => {
    expect(shapeHit({ full: true }, null, { note: 36, velocity: 20 }).velocity).toBe(127)
  })
  it('ladder: first hit seeds, then pad i plays the source at step i', () => {
    const seed = shapeHit({ ladder: 'velocity' }, null, { note: 36, velocity: 100 })
    expect(seed.velocity).toBe(100)
    const hit = shapeHit({ ladder: 'velocity' }, seed.source, { note: 36 + 16 + 15, velocity: 10 })
    expect(hit).toMatchObject({ note: 36, velocity: 127, source: { note: 36, velocity: 100 } })
  })
  it('ladder + full: full wins on velocity', () => {
    const r = shapeHit({ ladder: 'velocity', full: true }, { note: 36, velocity: 100 }, { note: 36, velocity: 10 })
    expect(r.velocity).toBe(127)
  })
})
