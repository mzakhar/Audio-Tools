import { describe, it, expect } from 'vitest'
import { SMC_PAD } from '../src/renderer/js/pads/profiles/smc-pad.js'
import { resolve, knobDelta, learnKey, bankOf, padOf } from '../src/renderer/js/pads/profile.js'

const cc = (controller, value, channel = 0) => ({ kind: 'cc', channel, controller, value })
const on = (pitch, velocity = 90, channel = 9) => ({ kind: 'note-on', channel, pitch, velocity })

describe('smc-pad profile', () => {
  it('matches device name', () => {
    expect(SMC_PAD.match('SMC-PAD')).toBe(true)
    expect(SMC_PAD.match('Other')).toBe(false)
  })
  it('knob order map', () => {
    expect(resolve(cc(36, 10), SMC_PAD)).toEqual({ kind: 'knob', index: 0, value: 10 })
    expect(resolve(cc(30, 5), SMC_PAD)).toEqual({ kind: 'knob', index: 6, value: 5 })
    expect(resolve(cc(31, 5), SMC_PAD).index).toBe(7)
  })
  it('buttons press/release', () => {
    expect(resolve(cc(25, 127), SMC_PAD)).toEqual({ kind: 'button', action: 'play', pressed: true })
    expect(resolve(cc(29, 0), SMC_PAD)).toEqual({ kind: 'button', action: 'full', pressed: false })
  })
  it('overrides win', () => {
    expect(resolve(cc(25, 127), SMC_PAD, { 'cc:0:25': 'layer' }).action).toBe('layer')
    expect(resolve(cc(36, 0), SMC_PAD, { 'cc:0:36': 'wipe' })).toEqual({ kind: 'button', action: 'wipe', pressed: false })
  })
  it('wrong channel -> null', () => {
    expect(resolve(cc(25, 127, 3), SMC_PAD)).toBeNull()
    expect(resolve(on(40, 90, 0), SMC_PAD)).toBeNull()
    expect(resolve(cc(99, 1), SMC_PAD)).toBeNull()
  })
  it('bank math', () => {
    expect(resolve(on(52), SMC_PAD)).toEqual({ kind: 'pad', note: 52, bank: 1, pad: 0, velocity: 90 })
    expect(resolve(on(99), SMC_PAD)).toMatchObject({ bank: 3, pad: 15 })
    expect(resolve(on(35), SMC_PAD)).toBeNull()
    expect(resolve(on(100), SMC_PAD)).toBeNull()
    expect(bankOf(36)).toBe(0)
    expect(padOf(51)).toBe(15)
    expect(bankOf(100)).toBeNull()
  })
  it('note-off', () => {
    expect(resolve({ kind: 'note-off', channel: 9, pitch: 37, velocity: 64 }, SMC_PAD)).toEqual({ kind: 'pad-off', note: 37, bank: 0, pad: 1 })
    expect(resolve(on(37, 0), SMC_PAD).kind).toBe('pad-off')
  })
  it('aftertouch', () => {
    expect(resolve({ kind: 'channel-aftertouch', channel: 9, pressure: 40 }, SMC_PAD)).toEqual({ kind: 'pressure', value: 40 })
    expect(resolve({ kind: 'channel-aftertouch', channel: 0, pressure: 40 }, SMC_PAD)).toBeNull()
  })
  it('knobDelta and learnKey', () => {
    expect(knobDelta(undefined, 50)).toBe(0)
    expect(knobDelta(50, 51)).toBe(1)
    expect(knobDelta(1, 0)).toBe(-1)
    expect(learnKey(cc(25, 1))).toBe('cc:0:25')
    expect(learnKey(on(36))).toBe('note:9:36')
    expect(learnKey({ kind: 'channel-aftertouch', channel: 9, pressure: 1 })).toBeNull()
  })
})

describe('learned knob override', () => {
  it('resolves a cc override of knob:N as a knob', async () => {
    const { resolve } = await import('../src/renderer/js/pads/profile.js')
    const { SMC_PAD } = await import('../src/renderer/js/pads/profiles/smc-pad.js')
    expect(resolve({ kind: 'cc', channel: 3, controller: 70, value: 64 }, SMC_PAD, { 'cc:3:70': 'knob:2' }))
      .toEqual({ kind: 'knob', index: 2, value: 64 })
  })
})
