export const LOOK_AHEAD_SEC = 0.1
export const SCHEDULE_INTERVAL = 25

/** Schedules discrete events slightly ahead of the audio clock. */
export class LookaheadScheduler {
  constructor({
    getCurrentTime,
    schedule,
    advance,
    steps = Infinity,
    lookahead = LOOK_AHEAD_SEC,
    interval = SCHEDULE_INTERVAL,
    setTimer = setTimeout,
    clearTimer = clearTimeout
  }) {
    this.getCurrentTime = getCurrentTime
    this.schedule = schedule
    this.advance = advance
    this.steps = steps
    this.lookahead = lookahead
    this.interval = interval
    this.setTimer = setTimer
    this.clearTimer = clearTimer
    this.nextTime = 0
    this.step = 0
    this.stepTimes = []
    this.timerId = null
    this.isRunning = false
  }

  start({ time, step = 0 }) {
    if (this.isRunning) return
    this.isRunning = true
    this.nextTime = time
    this.step = step
    this.tick()
  }

  stop() {
    this.isRunning = false
    if (this.timerId !== null) this.clearTimer(this.timerId)
    this.timerId = null
  }

  tick() {
    if (!this.isRunning) return
    const now = this.getCurrentTime()
    if (!Number.isFinite(now)) return this.stop()

    while (this.nextTime < now + this.lookahead) {
      this.stepTimes[this.step] = this.nextTime
      this.schedule(this.step, this.nextTime)
      const duration = this.advance()
      if (!(duration > 0)) return this.stop()
      this.nextTime += duration
      this.step = (this.step + 1) % this.steps
    }
    this.timerId = this.setTimer(() => {
      this.timerId = null
      this.tick()
    }, this.interval)
  }
}
