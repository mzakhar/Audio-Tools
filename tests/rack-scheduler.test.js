import { describe, it, expect, vi } from 'vitest'
import { LookaheadScheduler } from '../src/renderer/js/rack/scheduler.js'

function makeScheduler(overrides = {}) {
  let now = 0
  const schedule = vi.fn()
  const scheduler = new LookaheadScheduler({
    getCurrentTime: () => now,
    schedule,
    advance: () => 0.02,
    steps: 4,
    ...overrides
  })
  return { scheduler, schedule, setNow: time => { now = time } }
}

describe('LookaheadScheduler', () => {
  it('schedules every step inside the lookahead window and records its time', () => {
    const { scheduler, schedule } = makeScheduler()

    scheduler.start({ time: 0.05 })

    expect(schedule.mock.calls.map(([step]) => step)).toEqual([0, 1, 2])
    schedule.mock.calls.forEach(([, time], step) => expect(time).toBeCloseTo(0.05 + step * 0.02))
    expect(scheduler.stepTimes).toHaveLength(3)
    scheduler.stop()
  })

  it('continues from the next step on each timer tick', () => {
    vi.useFakeTimers()
    const { scheduler, schedule, setNow } = makeScheduler()

    scheduler.start({ time: 0.05, step: 2 })
    setNow(0.05)
    vi.advanceTimersByTime(25)

    expect(schedule.mock.calls.map(([step]) => step)).toEqual([2, 3, 0, 1, 2, 3])
    schedule.mock.calls.forEach(([, time], index) => expect(time).toBeCloseTo(0.05 + index * 0.02))
    scheduler.stop()
    vi.useRealTimers()
  })

  it('cancels its pending tick when stopped', () => {
    vi.useFakeTimers()
    const { scheduler, schedule } = makeScheduler()

    scheduler.start({ time: 0.05 })
    scheduler.stop()
    vi.advanceTimersByTime(100)

    expect(schedule).toHaveBeenCalledTimes(3)
    expect(scheduler.isRunning).toBe(false)
    vi.useRealTimers()
  })
})
