import { describe, it, expect } from 'vitest'
import { groupInputs } from '../src/renderer/js/midi/device-group.js'

describe('groupInputs', () => {
  it('collapses a MIDIIN2 mirror onto the plain port, either order', () => {
    for (const inputs of [
      [{ id: 'a', name: 'SMC-PAD' }, { id: 'b', name: 'MIDIIN2 (SMC-PAD)' }],
      [{ id: 'b', name: 'MIDIIN2 (SMC-PAD)' }, { id: 'a', name: 'SMC-PAD' }]
    ]) {
      const groups = groupInputs(inputs)
      expect(groups).toHaveLength(1)
      expect(groups[0].primaryId).toBe('a')
      expect(groups[0].name).toBe('SMC-PAD')
      expect([...groups[0].ids].sort()).toEqual(['a', 'b'])
    }
  })

  it('keeps unrelated devices apart and survives a mirror with no plain port', () => {
    const groups = groupInputs([{ id: '1', name: 'Keystation' }, { id: '2', name: 'MIDIIN2 (Other)' }])
    expect(groups.map(g => g.primaryId)).toEqual(['1', '2'])
  })

  it('handles empty input and missing names', () => {
    expect(groupInputs([])).toEqual([])
    expect(groupInputs([{ id: 'x' }])[0].primaryId).toBe('x')
  })
})
