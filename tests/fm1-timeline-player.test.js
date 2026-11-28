import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('../src/renderer/js/audio-engine.js', () => {
  const ctx = { currentTime: 0 }
  return { default: { getContext: () => ctx, getMasterInput: () => ({}) }, _ctx: ctx }
})
vi.mock('../src/renderer/js/utils/wav-encoder.js', () => ({ audioBufferToWAV: vi.fn(() => new ArrayBuffer(44)) }))

const { default: TimelinePlayer, fm1StartOffset } = await import('../src/renderer/js/playback/timeline-player.js')
const { _ctx } = await import('../src/renderer/js/audio-engine.js')

function fakeSessions(status = { state: 'ready' }) {
  const session = { leadSec: 0.08, status: () => status, noteOn: vi.fn(), noteOff: vi.fn(), panic: vi.fn() }
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
    expect(session.noteOn).toHaveBeenCalledWith(60, 64, expect.closeTo(1.11, 9))
    expect(session.noteOff).toHaveBeenCalledWith(60, expect.closeTo(2.11, 9))
  })

  it('a note on beat 0 still reaches the device a full lead ahead (start offset follows the FM-1 lead)', () => {
    const { session, sessions } = fakeSessions()
    session.leadSec = 0.131
    play([track({ clips: [{ type: 'midi', startBeat: 0, notes: [{ pitch: 62, velocity: 1, startBeat: 0, duration: 1 }] }] })], { fm1Sessions: sessions })
    vi.advanceTimersByTime(0)
    expect(session.noteOn).toHaveBeenCalledWith(62, 127, expect.closeTo(0.161, 9))
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
