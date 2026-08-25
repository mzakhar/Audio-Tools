import { describe, expect, it } from 'vitest'
import { applyChannelMidi, DEFAULT_CHANNEL_PROGRAM } from '../src/renderer/js/instruments/channel-program.js'

const pc = (channel, program) => ({ kind: 'program-change', channel, program })
const cc = (channel, controller, value) => ({ kind: 'cc', channel, controller, value })
const apply = (state, event, resolvePatch = (...address) => address.join(':')) => applyChannelMidi(state, event, resolvePatch)

describe('channel program latch', () => {
  it('starts every channel at GM bank 0:0 and resolves the initial PC', () => {
    const result = apply(undefined, pc(0, 5))
    expect(result.stateByChannel).toHaveLength(16)
    expect(result.change).toEqual({ channel: 0, bankMsb: 0, bankLsb: 0, program: 5, patch: '0:0:5:0' })
  })

  it('latches CC0 then CC32 only when the program change arrives', () => {
    let state
    for (const event of [cc(0, 0, 3), cc(0, 32, 4)]) {
      const result = apply(state, event)
      state = result.stateByChannel
      expect(result.change).toBeNull()
    }
    expect(apply(state, pc(0, 12)).change).toMatchObject({ bankMsb: 3, bankLsb: 4, program: 12 })
  })

  it('accepts bank controllers in reverse order and individually', () => {
    let state = apply(undefined, cc(0, 32, 2)).stateByChannel
    state = apply(state, cc(0, 0, 1)).stateByChannel
    expect(apply(state, pc(0, 6)).change).toMatchObject({ bankMsb: 1, bankLsb: 2 })
    expect(apply(undefined, cc(0, 0, 7)).change).toBeNull()
    expect(apply(undefined, cc(0, 32, 7)).change).toBeNull()
  })

  it('preserves a prior bank for later program changes', () => {
    let state = apply(undefined, cc(0, 0, 3)).stateByChannel
    state = apply(state, pc(0, 12)).stateByChannel
    expect(apply(state, pc(0, 13)).change).toMatchObject({ bankMsb: 3, bankLsb: 0, program: 13 })
  })

  it('keeps all sixteen channels isolated', () => {
    let state
    for (let channel = 0; channel < 16; channel++) state = apply(state, cc(channel, 0, channel)).stateByChannel
    for (let channel = 0; channel < 16; channel++) expect(apply(state, pc(channel, channel)).change).toMatchObject({ channel, bankMsb: channel, program: channel })
  })

  it('rejects invalid input and never resolves before a valid program change', () => {
    const state = apply(undefined, cc(0, 0, 1)).stateByChannel
    for (const event of [pc(-1, 1), pc(16, 1), pc(0, 128), cc(0, 0, -1), cc(0, 1, 1)]) {
      const result = apply(state, event, () => { throw new Error('should not resolve') })
      expect(result.change).toBeNull()
    }
    expect(DEFAULT_CHANNEL_PROGRAM).toEqual({ bankMsb: 0, bankLsb: 0, program: 0 })
  })
})
