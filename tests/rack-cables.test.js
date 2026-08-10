import { describe, it, expect } from 'vitest'
import { cableSag, MAX_SAG, SAG_HEADROOM } from '../src/renderer/js/components/rack-cables.js'

const at = (x, y) => ({ x, y })

describe('cableSag', () => {
  it('never droops less than a short cable would', () => {
    expect(cableSag(at(0, 0), at(0, 0))).toBe(28)
    expect(cableSag(at(10, 0), at(20, 0))).toBe(28)
  })

  it('grows with the run between the jacks', () => {
    expect(cableSag(at(0, 0), at(200, 0))).toBeGreaterThan(cableSag(at(0, 0), at(100, 0)))
  })

  it('stays bounded so a long run cannot leave the canvas', () => {
    // The bug: an unbounded sag put the control points below the canvas and the
    // cable vanished. A rail-to-dock run is the case that broke.
    expect(cableSag(at(0, 0), at(0, 900))).toBe(MAX_SAG)
    expect(cableSag(at(0, 0), at(1600, 900))).toBe(MAX_SAG)
    expect(SAG_HEADROOM).toBeGreaterThan(MAX_SAG)
  })

  it('is symmetric — a cable looks the same drawn from either jack', () => {
    expect(cableSag(at(30, 400), at(700, 90))).toBe(cableSag(at(700, 90), at(30, 400)))
  })
})
