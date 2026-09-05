import { describe, it, expect } from 'vitest'
import { holdReducer } from '../src/renderer/js/midi/midi-hold.js'

const pedalDown = channel => ({ kind: 'cc', channel, controller: 64, value: 127 })
const pedalUp = channel => ({ kind: 'cc', channel, controller: 64, value: 0 })
const noteOff = (channel, pitch) => ({ kind: 'note-off', channel, pitch })
const noteOn = (channel, pitch, velocity = 100) => ({ kind: 'note-on', channel, pitch, velocity })

describe('holdReducer', () => {
  it('is undefined-safe on first call', () => {
    const { emit } = holdReducer(undefined, pedalDown(0))
    expect(emit).toEqual([])
  })

  it('defers a note-off while held, flushes exactly once on pedal-up, and a second pedal-up flushes nothing', () => {
    let s = holdReducer(undefined, pedalDown(0)).state
    expect(holdReducer(s, pedalDown(0)).emit).toEqual([])
    let r = holdReducer(s, noteOff(0, 60))
    s = r.state
    expect(r.emit).toEqual([])

    r = holdReducer(s, pedalUp(0))
    s = r.state
    expect(r.emit).toEqual([noteOff(0, 60)])

    r = holdReducer(s, pedalUp(0))
    expect(r.emit).toEqual([])
  })

  it('flushes deferred note-offs in the order they were deferred', () => {
    let s = holdReducer(undefined, pedalDown(0)).state
    s = holdReducer(s, noteOff(0, 60)).state
    s = holdReducer(s, noteOff(0, 64)).state
    const { emit } = holdReducer(s, pedalUp(0))
    expect(emit).toEqual([noteOff(0, 60), noteOff(0, 64)])
  })

  it('retrigger while held emits note-off then note-on, and stops being deferred', () => {
    let s = holdReducer(undefined, pedalDown(0)).state
    s = holdReducer(s, noteOff(0, 60)).state
    const on = noteOn(0, 60)
    const r = holdReducer(s, on)
    expect(r.emit).toEqual([noteOff(0, 60), on])

    // pitch 60 no longer deferred: pedal-up should not re-emit it
    const flush = holdReducer(r.state, pedalUp(0))
    expect(flush.emit).toEqual([])
  })

  it('does not let two channels interfere', () => {
    let s = holdReducer(undefined, pedalDown(0)).state
    s = holdReducer(s, noteOff(0, 60)).state
    s = holdReducer(s, noteOff(1, 61)).state

    const r0 = holdReducer(s, pedalUp(0))
    expect(r0.emit).toEqual([noteOff(0, 60)])
    // channel 1 was never held, so its note-off passed through immediately
    expect(holdReducer(s, pedalUp(1)).emit).toEqual([])
  })

  it('passes unrelated CCs through unchanged', () => {
    const event = { kind: 'cc', channel: 0, controller: 7, value: 100 }
    expect(holdReducer(undefined, event).emit).toEqual([event])
  })

  it('passes a note-off through when no pedal is held', () => {
    const event = noteOff(0, 60)
    expect(holdReducer(undefined, event).emit).toEqual([event])
  })

  it('a channel that was never held passes a note-off through even after another channel holds', () => {
    const s = holdReducer(undefined, pedalDown(0)).state
    const event = noteOff(1, 61)
    expect(holdReducer(s, event).emit).toEqual([event])
  })

  it('a message that changes nothing returns the identical state object, no allocation', () => {
    const s = holdReducer(undefined, pedalDown(0)).state
    const event = { kind: 'poly-aftertouch', channel: 0, pitch: 60, pressure: 80 }
    expect(holdReducer(s, event).state).toBe(s)
  })
})
