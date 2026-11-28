import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createFm1RecordFlow } from '../src/renderer/js/fm1/record-flow.js'
import { AddTrack, AddClip, SetMixerParam } from '../src/renderer/js/store/ProjectStore.js'

const RATE = 48000
const FILE = 'fm1-Lead-20261128-090507-000.wav'
let clock, calls, deps, session, sessionState, cap, files, audioStore, store, take, projectDir

function setup() {
  clock = 100
  calls = []
  projectDir = 'proj'
  take = { L: new Float32Array(RATE), R: new Float32Array(RATE), rate: RATE, frames: RATE }
  cap = {
    peak: () => 0.5, full: vi.fn(() => false),
    finish: vi.fn(async end => { calls.push(['finish', end]); return take }),
    cancel: vi.fn(() => calls.push(['cap.cancel']))
  }
  sessionState = 'ready'
  session = { ready: Promise.resolve(), status: () => ({ state: sessionState }), startCapture: vi.fn(o => { calls.push(['startCapture', o]); return cap }), panic: vi.fn(() => calls.push(['panic'])) }
  files = { saveRecording: vi.fn(async () => {}), exportWav: vi.fn(async () => {}) }
  audioStore = { getProjectDir: () => projectDir, loadBuffer: vi.fn(async () => {}) }
  store = { dispatchBatch: vi.fn() }
  let n = 0
  deps = {
    sessions: { get: () => session },
    timeline: { play: vi.fn(o => { calls.push(['play', o]); return clock + 0.2 }), stop: vi.fn(o => calls.push(['stop', o])) },
    store, files, audioStore,
    getTrack: id => id === 't1' ? { id, name: 'Lead', mixerChannelId: 'ch1' } : null,
    encode: vi.fn(() => new ArrayBuffer(8)),
    time: () => clock, now: () => new Date(2026, 10, 28, 9, 5, 7), bpm: () => 120,
    newId: () => String(++n), notify: vi.fn(),
    commands: { AddTrack, AddClip, SetMixerParam }
  }
  return createFm1RecordFlow(deps)
}
const advance = async ms => { clock += ms / 1000; await vi.advanceTimersByTimeAsync(ms) }
const labels = batch => batch.map(c => c.label)
const stopAndSettle = async flow => { flow.stop(); await advance(100) }

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('record flow', () => {
  it('happy path: plays from the start beat, captures from S, ONE batch with AddTrack audio + AddClip', async () => {
    const flow = setup()
    await flow.start({ trackId: 't1', startBeat: 4, tail: 1 })
    expect(flow.state().phase).toBe('recording')
    expect(calls[0]).toEqual(['play', { beat: 4, bpm: 120 }])
    expect(calls[1]).toEqual(['startCapture', { startTime: 100.2, maxSeconds: 600 }])
    await advance(500)
    expect(flow.state().peak).toBe(0.5)
    flow.stop()
    expect(flow.state().phase).toBe('tail')
    await advance(1100)
    expect(flow.state().phase).toBe('done')
    expect(store.dispatchBatch).toHaveBeenCalledTimes(1)
    const [batch, label] = store.dispatchBatch.mock.calls[0]
    expect(label).toBe('Record FM-1 to audio track')
    expect(labels(batch)).toEqual(['Add track "Lead take"', 'Add clip to track'])
    const state = batch[0].execute({ tracks: [], mixer: { channels: [] } })
    expect(state.tracks[0]).toMatchObject({ type: 'audio', id: 'track-1', mixerChannelId: 'channel-2' })
    const clip = batch[1].execute({ tracks: [{ id: 'track-1', clips: [] }] }).tracks[0].clips[0]
    expect(clip).toMatchObject({ type: 'audio', startBeat: 4, offset: 0, duration: 2, file: 'recordings/' + FILE })
    expect(files.saveRecording).toHaveBeenCalledWith('proj', expect.any(ArrayBuffer), FILE)
    expect(audioStore.loadBuffer).toHaveBeenCalledWith('recordings/' + FILE)
    // write + load happen before the dispatch
    expect(files.saveRecording.mock.invocationCallOrder[0]).toBeLessThan(audioStore.loadBuffer.mock.invocationCallOrder[0])
    expect(audioStore.loadBuffer.mock.invocationCallOrder[0]).toBeLessThan(store.dispatchBatch.mock.invocationCallOrder[0])
  })

  it('stops the timeline WITHOUT panic, captures the tail, then panics and finishes at stop + tail', async () => {
    const flow = setup()
    await flow.start({ trackId: 't1', tail: 2 })
    await advance(1000)   // clock 101
    flow.stop()
    expect(calls.filter(c => c[0] === 'stop')).toEqual([['stop', { panic: false }]])
    expect(session.panic).not.toHaveBeenCalled()
    await advance(1900)
    expect(session.panic).not.toHaveBeenCalled()   // still inside the tail
    await advance(200)
    const order = calls.map(c => c[0])
    expect(order.indexOf('panic')).toBeGreaterThan(order.indexOf('stop'))
    expect(cap.finish).toHaveBeenCalledWith(103)
  })

  it('length reached auto-stops at S + bars, not at the poll time', async () => {
    const flow = setup()
    await flow.start({ trackId: 't1', bars: 1, tail: 0 })   // 1 bar @120 = 2 s; S = 100.2
    await advance(2000)
    expect(flow.state().phase).toBe('recording')
    await advance(300)
    expect(flow.state().phase).toBe('done')
    expect(cap.finish).toHaveBeenCalledWith(100.2 + 2)
    expect(calls.find(c => c[0] === 'stop')[1]).toEqual({ panic: false })
  })

  it('stops at the 10 minute cap and says so', async () => {
    const flow = setup()
    await flow.start({ trackId: 't1', tail: 0 })
    cap.full.mockReturnValue(true)
    await advance(100)
    expect(flow.state().notice).toMatch(/10 minutes/)
    expect(flow.state().phase).toBe('done')
  })

  it('mute option adds the mute command in the same batch', async () => {
    const flow = setup()
    await flow.start({ trackId: 't1', tail: 0, mute: true })
    await stopAndSettle(flow)
    const [batch] = store.dispatchBatch.mock.calls[0]
    expect(labels(batch)).toEqual(['Add track "Lead take"', 'Add clip to track', 'Set mixer mute'])
    expect(batch[2].execute({ mixer: { channels: [{ id: 'ch1', mute: false }] } }).mixer.channels[0].mute).toBe(true)
  })

  it('no mute command by default', async () => {
    const flow = setup()
    await flow.start({ trackId: 't1', tail: 0 })
    await stopAndSettle(flow)
    expect(store.dispatchBatch.mock.calls[0][0]).toHaveLength(2)
  })

  it('write failure -> pending, project untouched, Retry succeeds', async () => {
    const flow = setup()
    files.saveRecording.mockRejectedValueOnce(new Error('disk full'))
    await flow.start({ trackId: 't1', tail: 0 })
    await stopAndSettle(flow)
    expect(flow.state().phase).toBe('pending')
    expect(flow.state().error).toBe("Couldn't save the take: disk full")
    expect(flow.state().canRetry).toBe(true)
    expect(store.dispatchBatch).not.toHaveBeenCalled()
    expect(await flow.start({ trackId: 't1' })).toBe(false)   // one pending take at a time
    await flow.retry()
    expect(flow.state().phase).toBe('done')
    expect(store.dispatchBatch).toHaveBeenCalledTimes(1)
  })

  it('load failure also leaves the project untouched', async () => {
    const flow = setup()
    audioStore.loadBuffer.mockRejectedValueOnce(new Error('bad wav'))
    await flow.start({ trackId: 't1', tail: 0 })
    await stopAndSettle(flow)
    expect(flow.state().phase).toBe('pending')
    expect(store.dispatchBatch).not.toHaveBeenCalled()
  })

  it('no project dir -> pending, nothing written, Retry unavailable, Save as WAV works', async () => {
    const flow = setup()
    projectDir = null
    await flow.start({ trackId: 't1', tail: 0 })
    await stopAndSettle(flow)
    expect(flow.state().phase).toBe('pending')
    expect(flow.state().canRetry).toBe(false)
    expect(files.saveRecording).not.toHaveBeenCalled()
    await flow.retry()
    expect(flow.state().phase).toBe('pending')
    await flow.saveAs()
    expect(files.exportWav).toHaveBeenCalledWith(expect.any(ArrayBuffer), FILE)
    expect(flow.state().phase).toBe('done')
    expect(store.dispatchBatch).not.toHaveBeenCalled()
  })

  it('Save as failure keeps the take pending', async () => {
    const flow = setup()
    projectDir = null
    files.exportWav.mockRejectedValueOnce(new Error('denied'))
    await flow.start({ trackId: 't1', tail: 0 })
    await stopAndSettle(flow)
    await flow.saveAs()
    expect(flow.state().phase).toBe('pending')
    expect(flow.state().error).toMatch(/denied/)
  })

  it('cancel while recording: stop + panic, discard, nothing written, project untouched', async () => {
    const flow = setup()
    await flow.start({ trackId: 't1' })
    flow.cancel()
    expect(flow.state().phase).toBe('idle')
    expect(calls).toContainEqual(['stop', undefined])   // default stop = panics
    expect(session.panic).toHaveBeenCalled()
    expect(cap.cancel).toHaveBeenCalled()
    await advance(5000)
    expect(files.saveRecording).not.toHaveBeenCalled()
    expect(store.dispatchBatch).not.toHaveBeenCalled()
  })

  it('cancel during the tail also discards', async () => {
    const flow = setup()
    await flow.start({ trackId: 't1', tail: 5 })
    flow.stop()
    flow.cancel()
    await advance(6000)
    expect(flow.state().phase).toBe('idle')
    expect(cap.finish).not.toHaveBeenCalled()
    expect(store.dispatchBatch).not.toHaveBeenCalled()
  })

  it('discarding a pending take lets a new recording start', async () => {
    const flow = setup()
    projectDir = null
    await flow.start({ trackId: 't1', tail: 0 })
    await stopAndSettle(flow)
    flow.cancel()
    expect(flow.state().phase).toBe('idle')
    expect(await flow.start({ trackId: 't1', tail: 0 })).toBe(true)
  })

  it('session that never gets ready -> message, no playback', async () => {
    const flow = setup()
    session.ready = Promise.reject(new Error('boom'))
    await flow.start({ trackId: 't1' })
    expect(flow.state().phase).toBe('idle')
    expect(deps.notify).toHaveBeenCalledWith(expect.stringContaining('boom'))
    expect(deps.timeline.play).not.toHaveBeenCalled()
  })

  it('empty capture writes nothing', async () => {
    const flow = setup()
    take = { L: new Float32Array(0), R: new Float32Array(0), rate: RATE, frames: 0 }
    await flow.start({ trackId: 't1', tail: 0 })
    await stopAndSettle(flow)
    expect(flow.state().phase).toBe('idle')
    expect(flow.state().error).toBe('Nothing was captured.')
    expect(files.saveRecording).not.toHaveBeenCalled()
  })

  it('missing track refuses', async () => {
    const flow = setup()
    expect(await flow.start({ trackId: 'nope' })).toBe(false)
    expect(flow.state().phase).toBe('idle')
  })
})

describe('record flow fixes (phase 3 smoke + review)', () => {
  it('S3: a throw anywhere in the commit (e.g. no crypto.randomUUID on http) keeps the take pending with the reason', async () => {
    setup()
    const flow = createFm1RecordFlow({ ...deps, newId: () => { throw new TypeError('crypto.randomUUID is not a function') } })
    await flow.start({ trackId: 't1', tail: 0 })
    await stopAndSettle(flow)
    expect(flow.state().phase).toBe('pending')
    expect(flow.state().error).toMatch(/randomUUID/)
    expect(store.dispatchBatch).not.toHaveBeenCalled()
  })

  it('R1: Save as WAV cancelled (Electron null, browser AbortError) keeps the take pending; success says so, adds no track', async () => {
    const flow = setup()
    projectDir = null
    await flow.start({ trackId: 't1', tail: 0 })
    await stopAndSettle(flow)
    files.exportWav.mockResolvedValueOnce(null)
    await flow.saveAs()
    expect(flow.state().phase).toBe('pending')
    files.exportWav.mockRejectedValueOnce(Object.assign(new Error('The user aborted a request.'), { name: 'AbortError' }))
    await flow.saveAs()
    expect(flow.state().phase).toBe('pending')
    expect(flow.state().error).toBe("Couldn't save the take: No project folder is open.")
    files.exportWav.mockResolvedValueOnce('C:/x/take.wav')
    await flow.saveAs()
    expect(flow.state().phase).toBe('done')
    expect(flow.state().notice).toMatch(/^Saved as WAV/)
    expect(store.dispatchBatch).not.toHaveBeenCalled()
  })

  it('R3 + R4: length uses the time signature and the timeline gets an end beat', async () => {
    const flow = setup()
    deps.beatsPerBar = () => 3
    const f = createFm1RecordFlow(deps)
    await f.start({ trackId: 't1', startBeat: 2, bars: 2, tail: 0 })   // 6 beats @120 = 3 s; S = 100.2
    expect(calls[0]).toEqual(['play', { beat: 2, bpm: 120, endBeat: 8 }])
    await advance(2900)
    expect(f.state().phase).toBe('recording')
    await advance(400)
    expect(cap.finish).toHaveBeenCalledWith(100.2 + 3)
    expect(flow.state().phase).toBe('idle')
  })

  it('R4: a length take keeps the timeline running through the tail (no timer cuts the last note), stops it then', async () => {
    const flow = setup()
    await flow.start({ trackId: 't1', bars: 1, tail: 1 })   // S = 100.2, end 102.2, tail end 103.2
    await advance(2300)
    expect(flow.state().phase).toBe('tail')
    expect(deps.timeline.stop).not.toHaveBeenCalled()
    await advance(1000)
    expect(calls.map(c => c[0]).slice(-3)).toEqual(['stop', 'panic', 'finish'])
    expect(calls.find(c => c[0] === 'stop')[1]).toEqual({ panic: false })
    expect(cap.finish).toHaveBeenCalledWith(100.2 + 3)
  })

  it('R5: a start cancelled while the device boots does not play when the boot finishes; a second start while arming is refused', async () => {
    const flow = setup()
    let boot
    session.ready = new Promise(r => { boot = r })
    const first = flow.start({ trackId: 't1' })
    expect(await flow.start({ trackId: 't1' })).toBe(false)   // still arming
    flow.cancel()
    session.ready = Promise.resolve()
    const second = flow.start({ trackId: 't1', tail: 0 })
    boot()
    expect(await first).toBe(false)
    expect(await second).toBe(true)
    expect(deps.timeline.play).toHaveBeenCalledTimes(1)
    expect(session.startCapture).toHaveBeenCalledTimes(1)
  })

  it('R6: the device going away mid-take (track deleted, instrument changed, project switch) cancels with a message', async () => {
    const flow = setup()
    await flow.start({ trackId: 't1' })
    sessionState = 'disposed'
    await advance(100)
    expect(flow.state().phase).toBe('idle')
    expect(flow.state().error).toMatch(/cancelled/)
    expect(deps.notify).toHaveBeenCalledWith(flow.state().error)
    expect(cap.cancel).toHaveBeenCalled()
    await advance(5000)
    expect(files.saveRecording).not.toHaveBeenCalled()
  })

  it('R6: abort while saving keeps the take pending (Save as WAV only) instead of adding it to another project', async () => {
    const flow = setup()
    let release
    files.saveRecording.mockImplementationOnce(() => new Promise(r => { release = r }))
    await flow.start({ trackId: 't1', tail: 0 })
    flow.stop()
    await vi.advanceTimersByTimeAsync(0)
    expect(flow.state().phase).toBe('saving')
    flow.abort('The project changed.')
    release()
    await vi.advanceTimersByTimeAsync(0)
    expect(flow.state().phase).toBe('pending')
    expect(flow.state().canRetry).toBe(false)
    expect(store.dispatchBatch).not.toHaveBeenCalled()
  })

  it('R6: a source track gone by commit time adds the take without the mute', async () => {
    setup()
    let gone = false
    const flow = createFm1RecordFlow({ ...deps, getTrack: id => (gone ? null : deps.getTrack(id)) })
    await flow.start({ trackId: 't1', tail: 0, mute: true })
    gone = true
    await stopAndSettle(flow)
    expect(store.dispatchBatch.mock.calls[0][0]).toHaveLength(2)
  })

  it('R8: the 10-minute cap stops by audible time early enough for the tail', async () => {
    const flow = setup()
    const f = createFm1RecordFlow({ ...deps, maxSeconds: 10 })
    await f.start({ trackId: 't1', tail: 2 })   // S = 100.2
    await advance(7700)                          // t = 107.7 < S + 8
    expect(f.state().phase).toBe('recording')
    await advance(600)                           // t >= S + 10 - 2
    expect(f.state().phase).not.toBe('recording')
    expect(f.state().notice).toMatch(/minutes/)
    await advance(2500)
    expect(cap.finish.mock.calls[0][0]).toBeLessThanOrEqual(100.2 + 10)
    expect(flow.state().phase).toBe('idle')
  })
})
