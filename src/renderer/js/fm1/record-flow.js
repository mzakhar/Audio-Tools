// record-flow.js — shell for "Record FM-1 to audio track". Runs the timeline and the
// session's source capture, then commits the take as ONE undo step. All effects come in
// through deps; phases and the maths are record-take.js.
//
// deps: sessions.get(trackId) -> session | null (has ready, startCapture, panic)
//       timeline { prepare?() -> Promise, play({beat,bpm}) -> audible start time of beat, stop({panic}) }
//       store { dispatchBatch(commands, label) }, getTrack(id) -> {id,name,mixerChannelId} | null
//       files { saveRecording(dir, bytes, name), exportWav(bytes, name) }, audioStore { getProjectDir(), loadBuffer(key) }
//       encode(L, R, rate) -> ArrayBuffer, time() -> ctx.currentTime, now() -> Date, bpm() -> number,
//       newId() -> string, notify(msg), commands { AddTrack, AddClip, SetMixerParam }, maxSeconds?
// Capture is armed right after play() in the same tick: play() is synchronous, so no block
// message can interleave and nothing audible before S is missed.

import { MAX_TAKE_SECONDS, takeFileName, clipFields, endTimeFor, nextPhase, isActive } from './record-take.js'

const TICK_MS = 100
const LABEL = 'Record FM-1 to audio track'
const reasonOf = e => e?.message || String(e || 'unknown error')

export function createFm1RecordFlow(deps) {
  const { sessions, timeline, store, files, audioStore, encode, time, now, bpm, newId, notify, commands, getTrack } = deps
  const maxSeconds = deps.maxSeconds ?? MAX_TAKE_SECONDS
  const listeners = new Set()
  let st = { phase: 'idle', trackId: null, elapsed: 0, peak: 0, error: null, notice: null, takeName: null, canRetry: false }
  let run = null        // { session, cap, S, end, tail, tailEnd, opts, bpm, track }
  let pending = null    // { wav, take, name, run }
  let ticker = null

  const emit = patch => { st = { ...st, ...patch }; for (const cb of listeners) cb(st) }
  const go = (event, patch = {}) => emit({ ...patch, phase: nextPhase(st.phase, event) })
  const stopTicker = () => { clearInterval(ticker); ticker = null }

  function tick() {
    if (!run) return
    const t = time()
    emit({ elapsed: Math.max(0, t - run.S), peak: run.cap.peak() })
    if (st.phase === 'recording') {
      if (run.cap.full()) stop('full')
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
    go('start', { trackId, elapsed: 0, peak: 0, error: null, notice: null, takeName: null, canRetry: false })
    const frozenBpm = bpm()
    const session = sessions.get(trackId)
    if (!session) return fail('The FM-1 device is not available.')
    try {
      await session.ready
      await timeline.prepare?.()
    } catch (e) { return fail(`The FM-1 device did not start: ${reasonOf(e)}`) }
    if (st.phase !== 'arming') return false   // cancelled while arming
    let S
    let cap
    try {
      S = timeline.play({ beat: startBeat, bpm: frozenBpm })
      if (!Number.isFinite(S)) throw new Error('playback did not start')
      cap = session.startCapture({ startTime: S, maxSeconds })
    } catch (e) {
      timeline.stop()
      return fail(`Could not start recording: ${reasonOf(e)}`)
    }
    run = { session, cap, S, end: endTimeFor({ startTime: S, bars, bpm: frozenBpm }), tail, opts: { startBeat, mute }, bpm: frozenBpm, track }
    go('armed')
    ticker = setInterval(tick, TICK_MS)
    return true
  }

  function stop(reason = 'user') {
    if (st.phase !== 'recording') return
    // No panic: the device's tail keeps ringing into the take until the tail window ends.
    timeline.stop({ panic: false })
    run.tailEnd = (reason === 'length' ? run.end : time()) + run.tail
    go('stop', reason === 'full' ? { notice: `The take reached ${Math.round(maxSeconds / 60)} minutes and was stopped.` } : {})
    if (time() >= run.tailEnd) finish()
  }

  async function finish() {
    if (st.phase !== 'tail') return
    stopTicker()
    const r = run
    run = null
    r.session.panic()
    go('finish')
    let take
    try { take = await r.cap.finish(r.tailEnd) } catch (e) { return empty(`Recording failed: ${reasonOf(e)}`) }
    if (!take || take.frames === 0) return empty('Nothing was captured.')
    pending = { take, wav: encode(take.L, take.R, take.rate), name: takeFileName(r.track.name, now()), run: r }
    emit({ takeName: pending.name })
    await commit()
  }

  function empty(error) {
    go('empty', { error })
    notify?.(error)
  }

  // saving -> done | pending. Write and decode BEFORE the dispatch: any failure leaves the project untouched.
  async function commit() {
    const { wav, take, name, run: r } = pending
    const dir = audioStore.getProjectDir()
    if (!dir) return hold('No project folder is open.', false)
    try {
      await files.saveRecording(dir, wav, name)
      await audioStore.loadBuffer('recordings/' + name)
    } catch (e) { return hold(reasonOf(e), true) }
    const trackId = 'track-' + newId()
    const label = `${r.track.name} take`
    const batch = [
      commands.AddTrack('audio', label, { trackId, channelId: 'channel-' + newId() }),
      commands.AddClip(trackId, { id: 'clip-' + now().getTime(), type: 'audio', file: 'recordings/' + name, name: label, ...clipFields({ startBeat: r.opts.startBeat, frames: take.frames, rate: take.rate, bpm: r.bpm }) }),
    ]
    if (r.opts.mute && r.track.mixerChannelId) batch.push(commands.SetMixerParam(r.track.mixerChannelId, 'mute', true))
    try { store.dispatchBatch(batch, LABEL) } catch (e) { return hold(reasonOf(e), true) }
    pending = null
    go('saved', { error: null, canRetry: false })
  }

  function hold(reason, canRetry) {
    go('failed', { error: `Couldn't save the take: ${reason}`, canRetry })
  }

  async function retry() {
    if (st.phase !== 'pending' || !audioStore.getProjectDir()) return
    go('retry', { error: null })
    await commit()
  }

  async function saveAs() {
    if (st.phase !== 'pending') return
    try { await files.exportWav(pending.wav, pending.name) } catch (e) { return emit({ error: `Couldn't save the take: ${reasonOf(e)}` }) }
    pending = null
    go('saved', { error: null, canRetry: false })
  }

  // Active: stop + panic, discard. Pending: discard the take. Saving: not interruptible.
  function cancel() {
    if (st.phase === 'pending') { pending = null; return go('discard', { error: null }) }
    if (st.phase === 'saving' || !isActive(st.phase)) return
    stopTicker()
    const r = run
    run = null
    timeline.stop()
    r?.session.panic()
    r?.cap.cancel()
    go('cancel', { elapsed: 0, peak: 0 })
  }

  return {
    start, stop: () => stop('user'), cancel, retry, saveAs,
    state: () => st,
    reset() { go('reset', { error: null, notice: null }) },
    onChange(cb) { listeners.add(cb); return () => listeners.delete(cb) },
  }
}
