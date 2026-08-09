// Integer PPQN clock. Derive every timestamp from its index: no accumulated drift.
export class RackClock {
  constructor({ bpm = 120, ppqn = 24, emit = () => {} } = {}) { this.bpm = bpm; this.ppqn = ppqn; this.emit = emit; this.running = false; this.startTime = 0; this.tick = 0 }
  start(time = 0, bpm = this.bpm) { this.bpm = bpm; this.startTime = time; this.tick = 0; this.running = true }
  stop() { this.running = false }
  timeAt(tick) { return this.startTime + tick * 60 / this.bpm / this.ppqn }
  scheduleThrough(time) { while (this.running && this.timeAt(this.tick) < time) this.emit({ type: 'ppqn', time: this.timeAt(this.tick++), tick: this.tick - 1 }) }
}
