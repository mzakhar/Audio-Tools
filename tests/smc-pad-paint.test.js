import { describe, it, expect } from 'vitest'
import { createSmcPadLink } from '../src/renderer/js/pads/smc-pad-link.js'

describe('smc-pad link paint', () => {
  it('is idle and not user-mode before a refresh has read the device', async () => {
    const sent = []
    const link = createSmcPadLink({ send: b => sent.push(b) })
    expect(link.isUserMode()).toBe(false)
    expect(await link.paint(Array(16).fill([1, 2, 3]))).toBe(false)
    expect(sent).toHaveLength(0)
  })
})
