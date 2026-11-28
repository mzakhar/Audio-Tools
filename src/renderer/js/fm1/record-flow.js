// record-flow.js — shell for "Record FM-1 to audio track". Runs the timeline and the
// session's source capture, then commits the take as ONE undo step. All effects come in
// through deps; phases and the maths are record-take.js.
//
// deps: sessions.get(trackId) -> session | null (has ready, status(), startCapture, panic)
//       timeline { prepare?() -> Promise, play({beat,bpm,endBeat?}) -> audible start time of beat, stop({panic}) }
//       store { dispatchBatch(commands, label) }, getTrack(id) -> {id,name,mixerChannelId} | null
//       files { saveRecording(dir, bytes, name), exportWav(bytes, name) -> null when cancelled }, audioStore { getProjectDir(), loadBuffer(key) }
//       encode(L, R, rate) -> ArrayBuffer, time() -> ctx.currentTime, now() -> Date, bpm() -> number,
//       beatsPerBar?() -> number, newId() -> string, notify(msg), commands { AddTrack, AddClip, SetMixerParam }, maxSeconds?
// Capture is armed right after play() in the same tick: play() is synchronous, so no block
// message can interleave and nothing audible before S is missed.
//
// While recording the flow watches its source: the session failing or being disposed (track
// deleted, instrument changed, project New/Open) cancels the recording with a message, nothing kept.
// abort(message) is the explicit form of that for the app (project switch).

import { MAX_TAKE_SECONDS, takeFileName, clipFields, endTimeFor, lengthBeats, nextPhase, isActive } from './record-take.js'

const TICK_MS = 100
const LABEL = 'Record FM-1 to audio track'
const reasonOf = e => e?.message || String(e || 'unknown error')
const isAbort = e => e?.name === 'AbortError'

export function createFm1RecordFlow(deps) {
  const { sessions, timeline, store, files, audioStore, encode, time, now, bpm, newId, notify, commands, getTrack } = deps
  const beatsPerBar = deps.beatsPerBar ?? (() => 4)
  const maxSeconds = deps.maxSeconds ?? MAX_TAKE_SECONDS
  const listeners = new Set()
  let st = { phase: 'idle', trackId: null, elapsed: 0, peak: 0, error: null, notice: null, takeName: null, canRetry: false }
  let run = null        // { session, cap, S, end, tail, tailEnd, opts, bpm, track }
  let pending = null    // { wav, frames, rate, name, run } (the samples are dropped once encoded)
  let ticker = null
  let gen = 0           // bumped by cancel/abort: a start() still awaiting checks it
  let stale = null      // set by abort() while saving: the commit must not land in another project

  const emit = patch => { st = { ...st, ...patch }; for (const cb of listeners) cb(st) }
  const go = (event, patch = {}) => emit({ ...patch, phase: nextPhase(st.phase, event) })
  const stopTicker = () => { clearInterval(ticker); ticker = null }

  function tick() {
    if (!run) return
    const t = time()
    const state = run.session.status?.().state
    if (state === 'failed' || state === 'disposed') return abort('The FM-1 device stopped, so the recording was cancelled.')
    emit({ elapsed: Math.max(0, t - run.S), peak: run.cap.peak() })
    if (st.phase === 'recording') {
      // stop early enough that the tail still fits in the cap; full() is the safety net
      if (run.cap.full() || t >= run.S + maxSeconds - run.tail) stop('full')
      else if (run.end != null && t >= run.end) stop('length')
    } else if (st.phase === 'tail' && t >= run.tailEnd) finish()
  }

  function fail(error) {
    go('fail', { error })
    notify?.(error)
    return false
  }

  async function start({ trackId, startBeat = 0, bars = null, tail = 2, mute = false }) {
    if ((st.phase !== 'idle' && st.phase !== 'done') || pending) return false
    const track = getTrack(trackId)
    if (!track) return fail('That track is gone.')
    const mine = ++gen
    stale = null
    go('start', { trackId, elapsed: 0, peak: 0, error: null, notice: null, takeName: null, canRetry: false })
    const frozenBpm = bpm()
    const beats = lengthBeats(bars, beatsPerBar())
    const session = sessions.get(trackId)
    if (!session) return fail('The FM-1 device is not available.')
    try {
      await session.ready
      if (mine !== gen) return false   // cancelled while the device booted
      await timeline.prepare?.()
    } catch (e) { return mine === gen ? fail(`The FM-1 device did not start: ${reasonOf(e)}`) : false }
    if (mine !== gen || st.phase !== 'arming') return false   // cancelled while arming
    let S
    let cap
    try {
      S = timeline.play({ beat: startBeat, bpm: frozenBpm, ...(beats == null ? {} : { endBeat: startBeat + beats }) })
      if (!Number.isFinite(S)) throw new Error('playback did not start')
      cap = session.startCapture({ startTime: S, maxSeconds })
    } catch (e) {
      timeline.stop()
      return fail(`Could not start recording: ${reasonOf(e)}`)
    }
    run = { session, cap, S, end: endTimeFor({ startTime: S, bars, bpm: frozenBpm, beatsPerBar: beatsPerBar() }), tail, opts: { startBeat, mute }, bpm: frozenBpm, track }
    go('armed')
    ticker = setInterval(tick, TICK_MS)
    return true
  }

  function stop(reason = 'user') {
    if (st.phase !== 'recording') return
    // No panic: the device's tail keeps ringing into the take until the tail window ends. A
    // length take needs no stop here: play() got endBeat, so nothing after the end was scheduled,
    // and a late timer cannot cut the last note; the timeline stops with the tail.
    if (reason !== 'length') timeline.stop({ panic: false })
    const at = reason === 'length' ? run.end : time()
    run.tailEnd = Math.min(at + run.tail, run.S + maxSeconds)
    go('stop', reason === 'full' ? { notice: `The take reached ${Math.round(maxSeconds / 60)} minutes and was stopped.` } : {})
    if (time() >= run.tailEnd) finish()
  }

  async function finish() {
    if (st.phase !== 'tail') return
    stopTicker()
    const r = run
    run = null
    timeline.stop({ panic: false })
    r.session.panic()
    go('finish')
    let take
    try { take = await r.cap.finish(r.tailEnd) } catch (e) { return empty(`Recording failed: ${reasonOf(e)}`) }
    r.cap = null   // the capture holds the take's buffers; only the encoded WAV is kept from here
    if (!take || take.frames === 0) return empty('Nothing was captured.')
    let wav
    try { wav = encode(take.L, take.R, take.rate) } catch (e) { return empty(`Recording failed: ${reasonOf(e)}`) }
    pending = { wav, frames: take.frames, rate: take.rate, name: takeFileName(r.track.name, now()), run: r }
    take = null
    emit({ takeName: pending.name })
    await commit()
  }

  function empty(error) {
    go('empty', { error })
    notify?.(error)
  }

  // saving -> done | pending. Write and decode BEFORE the dispatch: any failure (a throw anywhere
  // here, too) leaves the project untouched and keeps the take pending with the reason.
  async function commit() {
    try {
      const { wav, frames, rate, name, run: r } = pending
      if (stale) return hold(stale, false)
      const dir = audioStore.getProjectDir()
      if (!dir) return hold('No project folder is open.', false)
      await files.saveRecording(dir, wav, name)
      await audioStore.loadBuffer('recordings/' + name)
      if (stale) return hold(stale, false)
      const trackId = 'track-' + newId()
      const label = `${r.track.name} take`
      const batch = [
        commands.AddTrack('audio', label, { trackId, channelId: 'channel-' + newId() }),
        commands.AddClip(trackId, { id: 'clip-' + newId(), type: 'audio', file: 'recordings/' + name, name: label, ...clipFields({ startBeat: r.opts.startBeat, frames, rate, bpm: r.bpm }) }),
      ]
      const source = getTrack(r.track.id)   // the source may be gone by now: then there is nothing to mute
      if (r.opts.mute && source?.mixerChannelId) batch.push(commands.SetMixerParam(source.mixerChannelId, 'mute', true))
      store.dispatchBatch(batch, LABEL)
      pending = null
      go('saved', { error: null, canRetry: false })
    } catch (e) { hold(reasonOf(e), true) }
  }

  function hold(reason, canRetry) {
    go('failed', { error: `Couldn't save the take: ${reason}`, canRetry })
  }

  async function retry() {
    if (st.phase !== 'pending' || !st.canRetry || !audioStore.getProjectDir()) return
    go('retry', { error: null })
    await commit()
  }

  async function saveAs() {
    if (st.phase !== 'pending') return
    let saved
    try { saved = await files.exportWav(pending.wav, pending.name) } catch (e) {
      if (isAbort(e)) return   // the user closed the save dialog: still pending
      return emit({ error: `Couldn't save the take: ${reasonOf(e)}` })
    }
    if (saved === null) return  // Electron: the save dialog was cancelled
    const name = pending.name
    pending = null
    go('saved', { error: null, canRetry: false, notice: `Saved as WAV (${name}). No track was added.` })
  }

  // Active: stop + panic, discard. Pending: discard the take. Saving: not interruptible.
  function cancel(error = null) {
    if (st.phase === 'pending') { pending = null; return go('discard', { error }) }
    if (st.phase === 'saving' || !isActive(st.phase)) return
    gen++
    stopTicker()
    const r = run
    run = null
    if (r) {
      timeline.stop()
      r.session.panic()
      r.cap.cancel()
    }
    go('cancel', { elapsed: 0, peak: 0, error })
    if (error) notify?.(error)
  }

  // The source went away (project switch, device failure): cancel with a message. A take already
  // being saved is kept pending (Save as WAV) rather than added to whatever project is open now.
  function abort(message) {
    if (st.phase === 'saving') { stale = message; return }
    if (st.phase === 'pending') { stale = message; return emit({ error: `Couldn't save the take: ${message}`, canRetry: false }) }
    cancel(message)
  }

  return {
    start, stop: () => stop('user'), cancel: () => cancel(), abort, retry, saveAs,
    state: () => st,
    reset() { go('reset', { error: null, notice: null }) },
    onChange(cb) { listeners.add(cb); return () => listeners.delete(cb) },
  }
}
