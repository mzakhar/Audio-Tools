import { describe, it, expect } from 'vitest'
import { keyLayout, BLACK_OFFSET } from '../src/renderer/js/key-layout.js'

describe('keyLayout', () => {
  it('has 25 keys for the default C3..C5 range, 15 white + 10 black', () => {
    const { keys } = keyLayout()
    expect(keys.length).toBe(25)
    expect(keys.filter(k => !k.black).length).toBe(15)
    expect(keys.filter(k => k.black).length).toBe(10)
  })

  it('width is whiteCount * whiteW', () => {
    const { width, keys } = keyLayout({ whiteW: 44 })
    expect(width).toBe(15 * 44)
    expect(keys.filter(k => !k.black).length).toBe(15)
  })

  it('lays whites flush left and monotonic in x', () => {
    const whites = keyLayout().keys.filter(k => !k.black)
    for (let i = 1; i < whites.length; i++) expect(whites[i].x).toBeGreaterThan(whites[i - 1].x)
    expect(whites[0].x).toBe(0)
  })

  it('places a black key per BLACK_OFFSET — C#3 (note 49) centred on the C3/D3 boundary', () => {
    const { whiteW, blackW } = { whiteW: 44, blackW: 28 }
    const key = keyLayout({ whiteW, blackW }).keys.find(k => k.note === 49)
    expect(key.x).toBe(Math.round(BLACK_OFFSET[1] * whiteW - blackW / 2))
  })

  it('blacks all come after whites in the array', () => {
    const keys = keyLayout().keys
    const firstBlack = keys.findIndex(k => k.black)
    expect(keys.slice(firstBlack).every(k => k.black)).toBe(true)
  })
})
