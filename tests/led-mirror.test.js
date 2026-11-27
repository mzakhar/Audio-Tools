import { describe, it, expect, vi } from 'vitest'
import { createLedMirror } from '../src/renderer/js/pads/led-mirror.js'

const RED = [255, 0, 0]
const pad = (extra = {}) => ({ hasSound: true, muted: false, wipeArmed: false, target: false, ...extra })
const ackAll = c => c.flatMap((rgb, i) => (rgb ? [i] : []))

function setup({ user = true, ack = ackAll } = {}) {
  const writes = []
  const link = { isUserMode: () => user, paint: vi.fn(async (c, max) => { writes.push([c, max]); return ack(c) }) }
  const mirror = createLedMirror({
    link, colours: () => Array(16).fill(RED), patterns: () => Array.from({ length: 16 }, () => pad()), now: () => 0
  })
  return { mirror, link, writes }
}

describe('led mirror', () => {
  it('asks the link for at most 8 SysEx writes per tick, and nothing once all pads are lit', async () => {
    const { mirror, link, writes } = setup()
    await mirror.tick(); await mirror.tick()
    expect(writes.map(([, max]) => max)).toEqual([8])
    expect(link.paint).toHaveBeenCalledTimes(1)
  })

  it('idle outside a user preset or with no kit', async () => {
    const a = setup({ user: false })
    await a.mirror.tick()
    expect(a.link.paint).not.toHaveBeenCalled()
    const link = { isUserMode: () => true, paint: vi.fn() }
    await createLedMirror({ link, colours: () => null, patterns: () => [] }).tick()
    expect(link.paint).not.toHaveBeenCalled()
  })

  it('prev advances only for acknowledged pads; the rest retry next tick', async () => {
    const { mirror, link } = setup({ ack: c => (c[0] ? [0, 1] : []) })
    await mirror.tick()
    expect(link.paint.mock.calls[0][0].filter(Boolean)).toHaveLength(16)
    await mirror.tick()
    const second = link.paint.mock.calls[1][0]
    expect(second[0]).toBeNull()
    expect(second[1]).toBeNull()
    expect(second.filter(Boolean)).toHaveLength(14)
  })

  it('a link that is idle (false) is retried', async () => {
    const { mirror, link } = setup({ ack: () => false })
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
    const link = { isUserMode: () => true, paint: vi.fn(async c => ackAll(c)) }
    const m = createLedMirror({
      link, colours: () => Array(16).fill(RED), now: () => t,
      patterns: () => Array.from({ length: 16 }, (_, i) => pad({ muted: i === 0 }))
    })
    await m.tick()
    link.paint.mockClear()
    await m.tick()
    expect(link.paint).not.toHaveBeenCalled()
    t = 130 // fast blink, off phase
    await m.tick()
    expect(link.paint.mock.calls[0][0][0]).toEqual([0, 0, 0])
  })

  it('more than 4 fast-blinking pads blink at the slow rate instead', async () => {
    let t = 0
    const link = { isUserMode: () => true, paint: vi.fn(async c => ackAll(c)) }
    const m = createLedMirror({
      link, colours: () => Array(16).fill(RED), now: () => t,
      patterns: () => Array.from({ length: 16 }, (_, i) => pad({ muted: i < 5 }))
    })
    await m.tick()
    link.paint.mockClear()
    t = 130 // fast would be off here; slow (1 Hz) is still on
    await m.tick()
    expect(link.paint).not.toHaveBeenCalled()
    t = 510
    await m.tick()
    expect(link.paint).toHaveBeenCalled()
  })
})
