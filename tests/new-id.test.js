import { describe, it, expect } from 'vitest'
import { newId } from '../src/renderer/js/utils/new-id.js'

describe('newId', () => {
  it('uses crypto.randomUUID where it exists', () => {
    expect(newId({ randomUUID: () => 'u-1' })).toBe('u-1')
  })
  it('falls back without randomUUID (insecure http: the LAN route) and stays unique', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => newId({})))
    expect(ids.size).toBe(1000)
    expect(newId(null)).toMatch(/^[a-z0-9]+-[a-z0-9]+$/)
  })
})
