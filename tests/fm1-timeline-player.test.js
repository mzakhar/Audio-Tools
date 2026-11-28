import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('../src/renderer/js/audio-engine.js', () => {
  const ctx = { currentTime: 0 }
  return { default: { getContext: () => ctx, getMasterInput: () => ({}) }, _ctx: ctx }
})
vi.mock('../src/renderer/js/utils/wav-encoder.js', () => ({ audioBufferToWAV: vi.fn(() => new ArrayBuffer(44)) }))

const { default: TimelinePlayer, fm1StartOffset } = await import('../src/renderer/js/playback/timeline-player.js')
const { _ctx } = await import('../src/renderer/js/audio-engine.js')
const { fm1Descriptor } = await import('../src/renderer/js/fm1/descriptor.js')

function fakeSessions(status = { state: 'ready' }) {
  const session = { leadSec: 0.08, status: () => status, noteOn: vi.fn(), noteOff: vi.fn(), panic: vi.fn(), dropFrom: vi.fn() }
  return { session, sessions: { acquire: vi.fn(() => session), use: vi.fn(() => session), get: vi.fn(() => session) } }
}
const track = (extra = {}) => ({
  id: 't1', name: 'Pluck', type: 'midi', mixerChannelId: 'c1',
  instrument: { type: 'fm1', firmwareHash: 'sha256:a' },
  clips: [{ type: 'midi', startBeat: 0, notes: [{ pitch: 60, velocity: 0.5, startBeat: 1, duration: 1 }] }],
  ...extra
})
const play = (tracks, deps) => TimelinePlayer.play({ beat: 0, bpm: 60, tracks, mixerEngine: { getOutput: () => ({ out: true }) }, ...deps })

describe('timeline player with an FM-1 track', () => {
  beforeEach(() => { vi.useFakeTimers(); _ctx.currentTime = 0 })
  afterEach(() => { TimelinePlayer.stop(); vi.useRealTimers() })

  it('hands notes to the session leadSec + 0.03 early, with the exact audio times', () => {
    const { session, sessions } = fakeSessions()
    play([track()], { fm1Sessions: sessions })
    expect(sessions.acquire).toHaveBeenCalledWith('t1', expect.objectContaining({ type: 'fm1', mhz: 120 }), { out: true })
    // lead 0.08 + 0.03 = 0.11 s moves beat 0 to 0.11, so the note is due at 1.11 and sent at 1.0
    vi.advanceTimersByTime(999)
    expect(session.noteOn).not.toHaveBeenCalled()
    vi.advanceTimersByTime(2)
    expect(session.noteOn).toHaveBeenCalledWith(60, 64, expect.closeTo(1.11, 9), 'timeline')
    expect(session.noteOff).toHaveBeenCalledWith(60, expect.closeTo(2.11, 9), 'timeline')
  })

  it('a note on beat 0 still reaches the device a full lead ahead (start offset follows the FM-1 lead)', () => {
    const { session, sessions } = fakeSessions()
    session.leadSec = 0.131
    play([track({ clips: [{ type: 'midi', startBeat: 0, notes: [{ pitch: 62, velocity: 1, startBeat: 0, duration: 1 }] }] })], { fm1Sessions: sessions })
    vi.advanceTimersByTime(0)
    expect(session.noteOn).toHaveBeenCalledWith(62, 127, expect.closeTo(0.161, 9), 'timeline')
    expect(fm1StartOffset()).toBe(0.05)
    expect(fm1StartOffset(0.01)).toBe(0.05)
    expect(fm1StartOffset(0.131)).toBeCloseTo(0.161, 9)
  })

  it('a session replaced mid-play gets the later notes', () => {
    const { session, sessions } = fakeSessions()
    const next = { ...session, noteOn: vi.fn(), noteOff: vi.fn() }
    play([track()], { fm1Sessions: sessions })
    sessions.use.mockImplementation(() => next)
    vi.advanceTimersByTime(2000)
    expect(session.noteOn).not.toHaveBeenCalled()
    expect(next.noteOn).toHaveBeenCalledOnce()
  })

  it('stop() silences the device and cancels pending notes, without disposing', () => {
    const { session, sessions } = fakeSessions()
    play([track()], { fm1Sessions: sessions })
    TimelinePlayer.stop()
    expect(session.panic).toHaveBeenCalledOnce()
    vi.advanceTimersByTime(5000)
    expect(session.noteOn).not.toHaveBeenCalled()
  })

  it('tells the user once when the device failed or is still starting', () => {
    const notify = vi.fn()
    play([track(), track({ id: 't2', name: 'Pad' })], { fm1Sessions: fakeSessions({ state: 'failed', reason: 'missing-firmware' }).sessions, notify })
    expect(notify).toHaveBeenCalledOnce()
    expect(notify.mock.calls[0][0]).toMatch(/Pluck.*not installed.*Pad.*not installed/)
    TimelinePlayer.stop()
    const again = vi.fn()
    play([track()], { fm1Sessions: fakeSessions({ state: 'booting' }).sessions, notify: again })
    expect(again.mock.calls[0][0]).toMatch(/still starting/)
  })

  it('stays quiet when the device is ready, and reports a missing manager', () => {
    const notify = vi.fn()
    play([track()], { fm1Sessions: fakeSessions().sessions, notify })
    expect(notify).not.toHaveBeenCalled()
    TimelinePlayer.stop()
    play([track()], { notify })
    expect(notify.mock.calls[0][0]).toMatch(/no device/)
  })

  it('bounce refuses FM-1 tracks, naming them, before rendering', async () => {
    await expect(TimelinePlayer.bounce({ bpm: 120, durationBeats: 4, tracks: [track(), track({ id: 't2', name: 'Pad' })] }))
      .rejects.toThrow('FM-1 tracks cannot be bounced yet: Pluck, Pad')
  })
})

describe('timeline player: recording support', () => {
  beforeEach(() => { vi.useFakeTimers(); _ctx.currentTime = 0 })
  afterEach(() => { TimelinePlayer.stop(); vi.useRealTimers() })

  it('play() returns the audible time of its start beat, also as startAudioTime', () => {
    const { sessions } = fakeSessions()
    _ctx.currentTime = 3
    const S = TimelinePlayer.play({ beat: 8, bpm: 60, tracks: [track()], mixerEngine: { getOutput: () => ({}) }, fm1Sessions: sessions })
    expect(S).toBeCloseTo(3 + 0.08 + 0.03, 9)
    expect(TimelinePlayer.startAudioTime).toBe(S)
    expect(TimelinePlayer.getCurrentBeat(60)).toBeCloseTo(8 - 0.11, 9)
  })

  it('stop({ panic: false }) lets the device play out what it has, cancels the rest', () => {
    const { session, sessions } = fakeSessions()
    play([track({ clips: [{ type: 'midi', startBeat: 0, notes: [
      { pitch: 60, velocity: 1, startBeat: 0, duration: 2 }, { pitch: 64, velocity: 1, startBeat: 3, duration: 1 }] }] })], { fm1Sessions: sessions })
    vi.advanceTimersByTime(0)
    expect(session.noteOn).toHaveBeenCalledOnce()
    expect(session.noteOff).toHaveBeenCalledWith(60, expect.closeTo(2.11, 9), 'timeline')   // its off is already queued
    _ctx.currentTime = 0.5
    TimelinePlayer.stop({ panic: false })
    expect(session.panic).not.toHaveBeenCalled()
    expect(session.dropFrom).toHaveBeenCalledWith(0.5)   // what the device queued to start later is dropped
    expect(TimelinePlayer.isPlaying()).toBe(false)
    vi.advanceTimersByTime(5000)
    expect(session.noteOn).toHaveBeenCalledOnce()
    TimelinePlayer.stop()
  })

  it('fm1Lookahead sends FM-1 notes that far ahead; those already inside it go synchronously (no timer)', () => {
    const { session, sessions } = fakeSessions()
    play([track({ clips: [{ type: 'midi', startBeat: 0, notes: [
      { pitch: 60, velocity: 1, startBeat: 0, duration: 1 }, { pitch: 62, velocity: 1, startBeat: 1, duration: 1 },
      { pitch: 64, velocity: 1, startBeat: 3, duration: 1 }] }] })], { fm1Sessions: sessions, fm1Lookahead: 1.5 })
    expect(session.noteOn.mock.calls.map(c => c[0])).toEqual([60, 62])   // beats 0 and 1 (0.11, 1.11 s) are within 1.5 s
    vi.advanceTimersByTime(1590)
    expect(session.noteOn).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(30)                                             // sent at 3.11 - 1.5 = 1.61 s
    expect(session.noteOn).toHaveBeenCalledTimes(3)
  })

  it('endBeat: no note starting at or after it is scheduled; one that starts before keeps its full length', () => {
    const { session, sessions } = fakeSessions()
    play([track({ clips: [{ type: 'midi', startBeat: 0, notes: [
      { pitch: 60, velocity: 1, startBeat: 3, duration: 2 },     // starts before beat 4, ends after it
      { pitch: 64, velocity: 1, startBeat: 4, duration: 1 },     // starts on the end beat: not played
      { pitch: 67, velocity: 1, startBeat: 6, duration: 1 }] }] })], { fm1Sessions: sessions, endBeat: 4 })
    vi.advanceTimersByTime(10000)
    expect(session.noteOn.mock.calls.map(c => c[0])).toEqual([60])
    expect(session.noteOff).toHaveBeenCalledWith(60, expect.closeTo(0.11 + 5, 9), 'timeline')
  })

  it('notes recorded from a MIDI device onto an FM-1 track play back through the session', async () => {
    const { createFm1Sessions } = await import('../src/renderer/js/fm1/session-manager.js')
    const node = () => ({ connect() {}, disconnect() {} })
    Object.assign(_ctx, { sampleRate: 48000, createGain: node,
      createBuffer: (ch, n) => { const d = [new Float32Array(n), new Float32Array(n)]; return { getChannelData: i => d[i] } },
      createBufferSource: () => ({ ...node(), start() {} }) })
    const workers = []
    const sessions = createFm1Sessions({ ctx: _ctx, getModule: async () => ({}), readFirmware: async () => new ArrayBuffer(8),
      preferWorklet: () => false, createWorker: () => { const w = { sent: [], postMessage(m) { this.sent.push(m) }, terminate() {} }; workers.push(w); return w } })
    const t = track({ instrument: { type: 'fm1', firmwareHash: 'sha256:a', deviceChannel: 3 } })
    sessions.acquire('t1', fm1Descriptor(t.instrument), {})
    vi.useRealTimers(); await new Promise(r => setTimeout(r, 0)); vi.useFakeTimers()
    const w = workers[0]
    w.onmessage({ data: { type: 'ready' } })
    w.onmessage({ data: { type: 'block', frame: 0, l: new Float32Array(1024), r: new Float32Array(1024) } })
    // A recorded take's clip shape (midi/take-recorder.js)
    t.clips = [{ id: 'midi-clip-1', type: 'midi', name: 'Rec', startBeat: 0, duration: 4, notes: [
      { id: 'n1', pitch: 60, startBeat: 0.5, duration: 0.25, velocity: 100 / 127 },
      { id: 'n2', pitch: 67, startBeat: 1, duration: 0.0625, velocity: 1 }] }]
    const S = TimelinePlayer.play({ beat: 0, bpm: 120, tracks: [t], mixerEngine: { getOutput: () => ({}) }, fm1Sessions: sessions })
    vi.advanceTimersByTime(1000)
    const frame = time => Math.round((time - 0.02) * 48000)   // anchor: block frame 0 plays at 0.02
    expect(w.sent.filter(m => m.type === 'midi')).toEqual([
      { type: 'midi', bytes: [0x93, 60, 100], frame: frame(S + 0.25), src: 'timeline' },
      { type: 'midi', bytes: [0x83, 60, 0], frame: frame(S + 0.375), src: 'timeline' },
      { type: 'midi', bytes: [0x93, 67, 127], frame: frame(S + 0.5), src: 'timeline' },
      { type: 'midi', bytes: [0x83, 67, 0], frame: frame(S + 0.53125), src: 'timeline' },
    ])
    sessions.disposeAll()
  })
})
