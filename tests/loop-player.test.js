import { describe, it, expect } from 'vitest'
import { createLoopPlayer } from '../src/renderer/js/pads/loop-player.js'

// 120 bpm => 0.5 s per beat. Loop = 4 beats (1 bar of 4/4). Start time = 10.05.
function rig({ notes = [], bpm = 120, metronome = true } = {}) {
  const ctx = { currentTime: 10 }
  const hits = []
  const clicks = []
  const wraps = []
  let timerFn = null
  let bpmNow = bpm
  const player = createLoopPlayer({
    getContext: () => ctx,
    bpm: () => bpmNow,
    beatsPerBar: () => 4,
    loopBeats: () => 4,
    notes: () => notes,
    playHit: (pitch, vel, time) => hits.push({ pitch, vel, time }),
    playClick: (accent, time) => clicks.push({ accent, time }),
    metronome: () => metronome,
    onWrap: k => wraps.push(k),
    setTimer: fn => { timerFn = fn; return 1 },
    clearTimer: () => { timerFn = null },
  })
  const advance = sec => { ctx.currentTime += sec; timerFn?.() }
  const run = (seconds, step = 0.025) => { for (let t = 0; t < seconds - 1e-9; t += step) advance(step) }
  return { player, hits, clicks, wraps, advance, run, setBpm: v => { bpmNow = v }, hasTimer: () => timerFn !== null }
}

describe('loop player', () => {
  it('schedules notes at start time + beat offset and repeats each loop', () => {
    const r = rig({ notes: [{ pitch: 36, velocity: 0.5, startBeat: 1 }] })
    r.player.start()
    r.run(2.5)
    expect(r.hits[0].time).toBeCloseTo(10.05 + 0.5, 6)   // beat 1
    expect(r.hits[1].time).toBeCloseTo(10.05 + 2.5, 6)   // beat 5 = next loop
    expect(r.hits[0]).toMatchObject({ pitch: 36, vel: 0.5 })
  })

  it('clicks every beat, accent on the bar downbeat', () => {
    const r = rig()
    r.player.start()
    r.run(2.2)
    expect(r.clicks.slice(0, 5).map(c => c.accent)).toEqual([true, false, false, false, true])
  })

  it('count-in plays clicks only, from a negative start beat, even with the metronome off', () => {
    const r = rig({ notes: [{ pitch: 36, velocity: 1, startBeat: 0 }], metronome: false })
    r.player.start({ countInBars: 1 })
    expect(r.player.beatAt(10.05)).toBe(-4)
    r.run(2.3)
    expect(r.clicks).toHaveLength(4)                       // metronome off => none after the count-in
    expect(r.clicks[3].time).toBeCloseTo(10.05 + 1.5, 6)
    expect(r.hits[0].time).toBeCloseTo(10.05 + 2, 6)       // note at beat 0
  })

  it('fires onWrap when the audible position crosses a loop boundary, not for the count-in', () => {
    const r = rig()
    r.player.start({ countInBars: 1 })
    r.run(2.5)
    expect(r.wraps).toEqual([])    // beat 0 is the loop start, not a wrap
    r.run(1.45)                    // t=13.95: scheduler already reached beat 4 (14.05), audio has not
    expect(r.wraps).toEqual([])
    r.run(0.2)
    expect(r.wraps).toEqual([1])
  })

  it('stop clears the timer and isPlaying flips', () => {
    const r = rig()
    r.player.start()
    expect(r.player.isPlaying()).toBe(true)
    r.player.stop()
    expect(r.player.isPlaying()).toBe(false)
    expect(r.hasTimer()).toBe(false)
  })

  it('re-anchors on a bpm change so the position does not jump', () => {
    const r = rig()
    r.player.start()
    r.run(1)
    const before = r.player.currentBeat()
    r.setBpm(60)
    r.advance(0)
    expect(r.player.currentBeat()).toBeCloseTo(before, 6)
    r.advance(1)
    expect(r.player.currentBeat()).toBeCloseTo(before + 1, 6)   // 1 beat/s now
  })

  it('skips the repetition of a pass-added note in its own lap only', () => {
    // loop = 4 beats; pitch 36 lap 1 (hit at 3.95 snapped to 4.0), pitch 38 lap 0 (hit at 1.02 snapped to 1.0)
    const r = rig({ notes: [{ pitch: 36, velocity: 1, startBeat: 0, lap: 1 }, { pitch: 38, velocity: 1, startBeat: 1, lap: 0 }] })
    r.player.start()
    r.run(6)
    const beatOf = h => Math.round((h.time - 10.05) / 0.5)
    expect(r.hits.filter(h => h.pitch === 36).map(beatOf)).toEqual([0, 8, 12])
    expect(r.hits.filter(h => h.pitch === 38).map(beatOf)).toEqual([5, 9])
  })

  it('syncBpm re-anchors immediately', () => {
    const r = rig()
    r.player.start()
    r.run(1)
    const before = r.player.currentBeat()
    r.setBpm(60)
    r.player.syncBpm()
    r.advance(1)
    expect(r.player.currentBeat()).toBeCloseTo(before + 1, 6)
  })
})
