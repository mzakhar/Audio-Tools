// Loop player shell: plays a looping note list plus metronome clicks against
// the audio clock. Not a transport owner — the global Play/Stop start and stop
// it. Every effect is injected so tests run it with a fake clock and timer.
import { notesInWindow, clicksInWindow } from './loop-record.js'
import { beatsToSeconds, secondsToBeats } from '../utils/timeline-math.js'

const INTERVAL_MS = 25
const LOOKAHEAD_SEC = 0.1
const START_DELAY_SEC = 0.05

export function createLoopPlayer({
  getContext, bpm, beatsPerBar, loopBeats, notes, playHit, playClick, metronome,
  onWrap = () => {}, onTick = () => {},
  setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = id => clearTimeout(id)
}) {
  let playing = false
  let timer = null
  let startTime = 0     // audio time of startBeat
  let startBeat = 0
  let anchorBpm = 120
  let scheduledTo = 0   // beats already handed to the audio clock
  let lastPlayhead = 0

  const beatAt = time => startBeat + secondsToBeats(time - startTime, anchorBpm)
  const timeOf = beat => startTime + beatsToSeconds(beat - startBeat, anchorBpm)
  const now = () => getContext().currentTime

  /** BPM moved: keep the current position, change only the slope. */
  function syncBpm() {
    if (!playing || bpm() === anchorBpm) return
    const t = now()
    startBeat = beatAt(t)
    startTime = t
    anchorBpm = bpm()
  }

  function scheduleSegment(from, to) {
    const L = loopBeats()
    if (L > 0) {
      for (const { note, beat, k } of notesInWindow(notes(), L, from, to)) {
        // A pass-added hit already sounded live in its own lap; its snapped copy plays from the next lap.
        if (note.lap === k) continue
        playHit(note.pitch, note.velocity ?? 0.8, timeOf(beat))
      }
    }
    // Count-in clicks always sound; the metronome setting gates the rest.
    for (const { beat, accent } of clicksInWindow(from, to, beatsPerBar())) {
      if (beat < 0 || metronome()) playClick(accent, timeOf(beat))
    }
  }

  function tick() {
    if (!playing) return
    syncBpm()
    const t = now()
    const playhead = beatAt(t)
    const L = loopBeats()
    if (playhead > lastPlayhead) {
      onTick(lastPlayhead, playhead)
      // Wrap = the AUDIBLE position crossing a positive boundary, not the scheduler.
      if (L > 0) {
        for (let k = Math.floor(lastPlayhead / L) + 1; k * L <= playhead; k++) if (k * L > 0) onWrap(k)
      }
    }
    lastPlayhead = Math.max(lastPlayhead, playhead)

    const to = beatAt(t + LOOKAHEAD_SEC)
    while (scheduledTo < to) {
      // Split the window at each loop boundary.
      const boundary = L > 0 ? (Math.floor(scheduledTo / L) + 1) * L : Infinity
      const end = Math.min(to, boundary)
      if (end <= scheduledTo) break
      scheduleSegment(scheduledTo, end)
      scheduledTo = end
    }
    timer = setTimer(tick, INTERVAL_MS)
  }

  return {
    start({ countInBars = 0 } = {}) {
      if (playing) return
      anchorBpm = bpm()
      startBeat = countInBars > 0 ? -countInBars * beatsPerBar() : 0
      startTime = now() + START_DELAY_SEC
      scheduledTo = startBeat
      lastPlayhead = Math.max(0, startBeat)
      playing = true
      tick()
    },
    stop() {
      playing = false
      if (timer !== null) clearTimer(timer)
      timer = null
    },
    isPlaying: () => playing,
    syncBpm,
    beatAt,
    currentBeat: () => (playing ? beatAt(now()) : 0),
  }
}
