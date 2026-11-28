import { describe, it, expect, vi } from 'vitest'
import { instrumentFor, liveInstrumentFor } from '../src/renderer/js/midi/live-instrument.js'

function fakeSessions() {
  const session = { ready: Promise.resolve(), noteOn: vi.fn(), noteOff: vi.fn(), sendMidi: vi.fn(), panic: vi.fn() }
  const sessions = { acquire: vi.fn(() => session), release: vi.fn() }
  return { session, sessions }
}
const ctx = { currentTime: 2 }
const fm1 = { type: 'fm1', firmwareHash: 'sha256:a', deviceChannel: 4, mhz: 100 }

describe('fm1 live adapter', () => {
  it('acquires the track session with the canonical descriptor and mixer output', () => {
    const { sessions } = fakeSessions()
    const output = {}
    instrumentFor({ type: 'fm1', firmwareHash: 'sha256:a' }, { ctx, output, fm1Sessions: sessions, trackId: 't1' })
    expect(sessions.acquire).toHaveBeenCalledWith('t1', { type: 'fm1', firmwareHash: 'sha256:a', deviceChannel: 0, mhz: 120 }, output)
  })

  it('is silent (null) without a session manager', () => {
    expect(instrumentFor(fm1, { ctx })).toBeNull()
  })

  it('plays notes through the session, never in the past', () => {
    const { session, sessions } = fakeSessions()
    const inst = liveInstrumentFor({ instrument: fm1 }, { ctx, fm1Sessions: sessions, trackId: 't1' })
    inst.noteOn(60, 100, 5)
    inst.noteOn(62, 90, 1)
    inst.noteOff(60, 6)
    inst.noteOff(62)
    expect(session.noteOn.mock.calls).toEqual([[60, 100, 5], [62, 90, 2]])
    expect(session.noteOff.mock.calls).toEqual([[60, 6], [62, 2]])
  })

  it('sends bend and mod as raw bytes on the device channel; mod honours modDest off', () => {
    const { session, sessions } = fakeSessions()
    const inst = instrumentFor(fm1, { ctx, fm1Sessions: sessions, trackId: 't1' })
    inst.send({ type: 'pitch-bend', value: 0 })
    inst.send({ type: 'mod', value: 1 })
    expect(session.sendMidi.mock.calls).toEqual([[[0xE4, 0, 64], 2], [[0xB4, 1, 127], 2]])
    const off = instrumentFor({ ...fm1, modDest: 'off' }, { ctx, fm1Sessions: sessions, trackId: 't1' })
    session.sendMidi.mockClear()
    off.send({ type: 'mod', value: 1 })
    expect(session.sendMidi).not.toHaveBeenCalled()
  })

  it('panic silences the device; prewarm and preload wait for ready', async () => {
    const { session, sessions } = fakeSessions()
    const inst = instrumentFor(fm1, { ctx, fm1Sessions: sessions, trackId: 't1' })
    inst.panic()
    expect(session.panic).toHaveBeenCalledOnce()
    await expect(inst.prewarm()).resolves.toBeUndefined()
    await expect(inst.preload()).resolves.toBeUndefined()
  })

  it('dispose is a no-op for a track (the session outlives the cache entry)', () => {
    const { sessions } = fakeSessions()
    const inst = instrumentFor(fm1, { ctx, fm1Sessions: sessions, trackId: 't1' })
    inst.dispose()
    expect(sessions.release).not.toHaveBeenCalled()
  })

  it('an audition (no trackId) uses its own key and releases it on dispose', () => {
    const { sessions } = fakeSessions()
    const inst = instrumentFor(fm1, { ctx, fm1Sessions: sessions })
    expect(sessions.acquire.mock.calls[0][0]).toBe('audition')
    inst.dispose()
    expect(sessions.release).toHaveBeenCalledWith('audition')
  })
})
