// Pure: map a MIDI event's performance.now() timestamp onto the audio clock.
// SLACK buys the graph a little headroom so a hit is scheduled just ahead of
// the render quantum instead of landing wherever the main thread got to.
const SLACK = 0.006

export function audioTimeFor(eventTimeMs, nowMs, ctxTime, slack = SLACK) {
  if (!Number.isFinite(eventTimeMs) || !Number.isFinite(nowMs)) return ctxTime + slack
  return Math.max(ctxTime, ctxTime + (eventTimeMs - nowMs) / 1000 + slack)
}
