// One control-rate loop for rack meters, scopes and activity. Modules register
// work; the visible rack owns whether it runs.
export class RackPoll {
  constructor(rate = 30) { this.jobs = new Set(); this.timer = null; this.rate = rate }
  add(job) { this.jobs.add(job); return () => this.jobs.delete(job) }
  start() { if (!this.timer) this.timer = setInterval(() => this.jobs.forEach(job => job()), 1000 / this.rate) }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null }
  clear() { this.jobs.clear() }
}
