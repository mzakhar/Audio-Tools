// lesson-session.js — runs one Pads lesson: collects hits/loop passes/mute toggles,
// scores them (lesson-score.js), judges them (lessons.js) and emits a view model.
// Pure helpers are exported; createLessonSession is a shell over injected capabilities.

import { scoreHits, tapErrors, calibrate, hintsFor, beatsToMs } from './lesson-score.js'
import { lessonById, evaluate, emptyProgress, parseProgress, markDone, setCalibration, nextLesson } from './lessons.js'

export const PROGRESS_KEY = 'synth_pads_lessons'
const CAL_TAPS = 16
const UPDATE_MS = 100

/** Pad of the first target occurrence with absolute beat >= beat (wraps into the next loop), or null. */
export function nextTarget(targets, loopBeats, beat) {
  if (!targets?.length || !(loopBeats > 0)) return null
  const k = Math.max(0, Math.floor(beat / loopBeats))
  let best = null
  for (const lap of [k, k + 1]) {
    for (const t of targets) {
      const abs = lap * loopBeats + t.beat
      if (abs >= beat && (!best || abs < best.abs)) best = { abs, pad: t.pad }
    }
    if (best) break
  }
  return best ? best.pad : null
}

/** Is `beat` within `ms` of a bar line? */
export function inBarWindow(beat, bpm, beatsPerBar, ms = 90) {
  if (!(beat >= 0) || !(bpm > 0) || !(beatsPerBar > 0)) return false
  const r = beat % beatsPerBar
  return beatsToMs(Math.min(r, beatsPerBar - r), bpm) <= ms
}

const setsDiffer = (a, b) => a.size !== b.size || [...a].some(x => !b.has(x))

export function createLessonSession({
  storage = null, getPads, getBpm, getLoopBeats, getBeatsPerBar = () => 4, getClipPads,
  applySetup = () => {}, onUpdate = () => {}, now = () => Date.now(), iso = () => new Date().toISOString()
}) {
  let progress = emptyProgress()
  try { progress = parseProgress(storage?.getItem(PROGRESS_KEY)) } catch {}
  const save = () => { try { storage?.setItem(PROGRESS_KEY, JSON.stringify(progress)) } catch {} }

  let lesson = null
  let ctx = null
  let hits = []
  let taps = []
  let run = null          // { first, last } of the current repeat run
  let doneNow = false
  let lastEmit = 0

  const freshCtx = () => ({
    loops: 0, calibration: null, startPads: new Set(getClipPads()), repeatBeats: 0,
    grooveHeard: [], snapHeard: [], mutesInTime: 0
  })
  const uniquePush = (arr, v) => { if (!arr.includes(v)) arr.push(v) }

  function model(beat) {
    if (!lesson) return null
    const pads = getPads()
    const offsetMs = progress.calibration?.offsetMs ?? 0
    const loopBeats = getLoopBeats()
    const score = lesson.targets.length
      ? scoreHits(hits, lesson.targets, { loopBeats, bpm: getBpm(), toBeat: Math.max(0, beat), offsetMs })
      : null
    const full = { ...ctx, score, clipPads: getClipPads(), pads }
    const result = evaluate(lesson, full)
    if (result.done && !doneNow) {
      doneNow = true
      progress = markDone(progress, lesson.id, iso())
      save()
    }
    const hints = [...hintsFor({ hits, score, offsetMs }).map(h => h.text), ...lesson.hints]
    return {
      lesson, result, score, hints, taps: taps.length,
      calibration: ctx.calibration, nextPad: nextTarget(lesson.targets, loopBeats, Math.max(0, beat)),
      marks: score?.marks ?? [], biasMs: score?.biasMs ?? null,
      done: doneNow || !!progress.done[lesson.id], progress
    }
  }

  function emit(beat = 0) {
    lastEmit = now()
    onUpdate(model(beat))
  }

  return {
    start(id) {
      const l = lessonById(id)
      if (!l) return false
      lesson = l
      applySetup(l)
      ctx = freshCtx()
      hits = []; taps = []; run = null
      doneNow = false
      emit(0)
      return true
    },
    stop() {
      lesson = null; ctx = null
      onUpdate(null)
    },
    active: () => lesson,
    restart() { hits = []; taps = []; run = null },
    hit({ pad, beat, velocity, source }) {
      if (!lesson || !(beat >= 0)) return
      if (lesson.pass.type === 'calibration') {
        if (ctx.calibration?.ok) return
        taps.push(beat)
        if (taps.length >= CAL_TAPS) {
          const cal = calibrate(tapErrors(taps, getBpm()))
          if (cal.ok) {
            ctx.calibration = cal
            progress = setCalibration(progress, cal, iso())
          } else taps = []
        }
        emit(beat)
        return
      }
      hits.push({ pad, beat, velocity })
      if (source === 'repeat') {
        if (run && beat - run.last <= 1) run.last = beat
        else run = { first: beat, last: beat }
        ctx.repeatBeats = Math.max(ctx.repeatBeats, run.last - run.first)
      }
    },
    wrap() {
      if (!lesson) return
      ctx.loops++
      const p = getPads()
      uniquePush(ctx.grooveHeard, p.groove)
      uniquePush(ctx.snapHeard, p.snapStrength)
    },
    tick(beat) {
      if (!lesson || now() - lastEmit < UPDATE_MS) return
      emit(beat)
    },
    padsChanged(prev, next, beat) {
      if (!lesson) return
      if (setsDiffer(new Set(prev?.muted ?? []), new Set(next?.muted ?? [])) &&
        inBarWindow(beat, getBpm(), getBeatsPerBar())) ctx.mutesInTime++
    },
    progress: () => progress,
    nextAfter: id => nextLesson(id, progress)
  }
}
