import { describe, expect, it } from 'vitest'
import { euclid } from '../src/renderer/js/rack/euclid.js'

describe('euclid', () => {
  it('distributes canonical patterns', () => {
    expect(euclid(8, 3, 0)).toEqual([true, false, false, true, false, false, true, false])
    expect(euclid(8, 5, 0)).toEqual([true, false, true, true, false, true, true, false])
  })
  it('rotates without changing hit count', () => {
    expect(euclid(8, 3, 2)).toEqual([true, false, true, false, false, true, false, false])
    expect(euclid(16, 7).filter(Boolean)).toHaveLength(7)
  })
})
