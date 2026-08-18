import { describe, it, expect, vi } from 'vitest'
import midiIn, { allocateVoice } from '../src/renderer/js/rack/modules/midi-in.js'

function makeCtx() {
  const param = () => ({ value: 0, setValueAtTime: vi.fn(), setTargetAtTime: vi.fn(), cancelScheduledValues: vi.fn() })
  return {
    currentTime: 0,
    createConstantSource: () => ({
      offset: param(),
      connect: vi.fn(),
      disconnect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn()
    })
  }
}

describe('MIDI IN allocation', () => {
  it('rotates through voices and steals at the cursor', () => {
    let state = { voices: 2, allocation: 'rotate', active: [], next: 0 }
    ;({ state } = allocateVoice(state, 60))
    expect(state.active[0].note).toBe(60)
    ;({ state } = allocateVoice(state, 62))
    expect(state.active[1].note).toBe(62)
    const picked = allocateVoice(state, 64)
    expect(picked.channel).toBe(0)
    expect(picked.state.active[0].note).toBe(64)
  })

  it('reuses an active matching note', () => {
    const state = { voices: 2, allocation: 'reuse', active: [{ note: 60 }], next: 1 }
    expect(allocateVoice(state, 60).channel).toBe(0)
  })

  it('resets to the first free voice', () => {
    const state = { voices: 2, allocation: 'reset', active: [null, { note: 62 }], next: 1 }
    expect(allocateVoice(state, 64).channel).toBe(0)
  })

  it('is registered as the polyphonic native source', () => {
    expect(midiIn.polySource({ params: { voices: 3 } })).toBe(3)
  })
})

describe('MIDI IN mod + pitch bend', () => {
  it('writes a mod event to every mod output', () => {
    const inst = midiIn.create(makeCtx(), { channels: 3, params: {} })
    inst.onEvent('note', { type: 'mod', value: 0.5, time: 0 })
    for (const node of inst.outputs.mod) {
      expect(node.offset.setValueAtTime).toHaveBeenCalledWith(0.5, 0)
    }
  })

  it('scales pitch bend by bendRange / 24', () => {
    const inst = midiIn.create(makeCtx(), { channels: 2, params: { bendRange: 2 } })
    inst.onEvent('note', { type: 'pitch-bend', value: 1, time: 0 })
    for (const node of inst.outputs.pb) {
      expect(node.offset.setValueAtTime).toHaveBeenCalledWith(2 / 24, 0)
    }
  })
})
