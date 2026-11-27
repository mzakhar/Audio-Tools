import { describe, it, expect, vi } from 'vitest'
import { createLedMirror } from '../src/renderer/js/pads/led-mirror.js'

const RED = [255, 0, 0]
const pad = (extra = {}) => ({ hasSound: true, muted: false, wipeArmed: false, target: false, ...extra })

function setup({ user = true, ok = true } = {}) {
  const writes = []
  const link = { isUserMode: () => user, paint: vi.fn(async c => { writes.push(c); return ok }) }
  const mirror = createLedMirror({
    link, colours: () => Array(16).fill(RED), patterns: () => Array.from({ length: 16 }, () => pad()), now: () => 0
  })
  return { mirror, link, writes }
}

describe('led mirror', () => {
  it('sends at most 4 pads per tick, then nothing once all are lit', async () => {
    const { mirror, writes } = setup()
    for (let i = 0; i < 5; i++) await mirror.tick()
    expect(writes.map(w => w.filter(Boolean).length)).toEqual([4, 4, 4, 4])
  })

  it('idle outside a user preset or with no kit', async () => {
    const a = setup({ user: false })
    await a.mirror.tick()
    expect(a.link.paint).not.toHaveBeenCalled()
    const link = { isUserMode: () => true, paint: vi.fn() }
    await createLedMirror({ link, colours: () => null, patterns: () => [] }).tick()
    expect(link.paint).not.toHaveBeenCalled()
  })

  it('a failed write is retried', async () => {
    const { mirror, link } = setup({ ok: false })
    await mirror.tick(); await mirror.tick()
    expect(link.paint).toHaveBeenCalledTimes(2)
  })

  it('snapshot records the frame as sent', async () => {
    const { mirror, link } = setup()
    expect(mirror.snapshot()).toHaveLength(16)
    await mirror.tick()
    expect(link.paint).not.toHaveBeenCalled()
  })

  it('a muted pad blinks: changes after the on-phase', async () => {
    let t = 0
    const link = { isUserMode: () => true, paint: vi.fn(async () => true) }
    const m = createLedMirror({
      link, colours: () => Array(16).fill(RED), now: () => t,
      patterns: () => Array.from({ length: 16 }, (_, i) => pad({ muted: i === 0 }))
    })
    for (let i = 0; i < 5; i++) await m.tick()
    link.paint.mockClear()
    await m.tick()
    expect(link.paint).not.toHaveBeenCalled()
    t = 130 // fast blink, off phase
    await m.tick()
    expect(link.paint.mock.calls[0][0][0]).toEqual([0, 0, 0])
  })
})
