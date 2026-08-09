import { describe, expect, it, vi } from 'vitest'
import { RackClock } from '../src/renderer/js/rack/rack-clock.js'

const ctx = { currentTime: 0 }
vi.mock('../src/renderer/js/audio-engine.js', () => ({ default: { getContext: () => ctx } }))
vi.mock('../src/renderer/js/rack/rack-engine.js', () => ({ default: { sendEvent: vi.fn() } }))

import RackEngine from '../src/renderer/js/rack/rack-engine.js'
import TimelinePlayer from '../src/renderer/js/playback/timeline-player.js'

describe('RackClock', () => {
  it('uses integer PPQN timestamps without drift', () => {
    const emit = vi.fn(), clock = new RackClock({ bpm: 120, emit })
    clock.start(10); clock.scheduleThrough(10 + 5 * 60 / 120)
    expect(emit).toHaveBeenCalledTimes(120)
    expect(emit.mock.calls.at(-1)[0].time).toBeCloseTo(clock.timeAt(119))
  })

  it('bridges transport pulses only to transport CLOCK modules', () => {
    const transportClock = { mods: new Map([['clock', { def: { type: 'clock' }, params: { source: 'transport' } }]]) }
    const internalClock = { mods: new Map([['clock', { def: { type: 'clock' }, params: { source: 'internal' } }]]) }

    TimelinePlayer.play({ bpm: 120, tracks: [], audioStore: {}, rackHandles: [transportClock, internalClock] })

    expect(RackEngine.sendEvent).toHaveBeenCalledWith(transportClock, 'clock', 'run', { type: 'gate-on', time: 0.05 })
    expect(RackEngine.sendEvent).toHaveBeenCalledWith(transportClock, 'clock', 'ext', expect.objectContaining({ type: 'ppqn', tick: 0 }))
    expect(RackEngine.sendEvent).not.toHaveBeenCalledWith(internalClock, expect.anything(), expect.anything(), expect.anything())
    TimelinePlayer.stop()
  })
})
