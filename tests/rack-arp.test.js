import { describe, it, expect, vi } from 'vitest'
import { arpOrder } from '../src/renderer/js/rack/arp.js'
import arp from '../src/renderer/js/rack/modules/arp.js'
import { midiToPitchCv } from '../src/renderer/js/utils/cv.js'

function makeCtx() {
  const created = []
  const param = () => ({ value: 0, setValueAtTime: vi.fn(), setTargetAtTime: vi.fn(), cancelScheduledValues: vi.fn() })
  const node = (kind, extra = {}) => {
    const n = { kind, connect: vi.fn(), disconnect: vi.fn(function () { n.disconnected++ }), disconnected: 0, ...extra }
    created.push(n)
    return n
  }
  return {
    currentTime: 0,
    created,
    createGain: () => node('gain', { gain: param() }),
    createConstantSource: () => node('const', {
      offset: param(), started: 0, stopped: 0,
      start: vi.fn(function () { this.started++ }), stop: vi.fn(function () { this.stopped++ })
    })
  }
}

const cv = midiToPitchCv
const held = [cv(64), cv(60), cv(67)]   // played E, C, G in that order

describe('arpOrder', () => {
  it('up sorts ascending, down descending, as-played keeps the stack order', () => {
    expect(arpOrder(held, 'up')).toEqual([cv(60), cv(64), cv(67)])
    expect(arpOrder(held, 'down')).toEqual([cv(67), cv(64), cv(60)])
    expect(arpOrder(held, 'as-played')).toEqual(held)
    expect(arpOrder(held, 'random')).toEqual(held)
  })

  it('updown turns around without repeating either endpoint', () => {
    expect(arpOrder(held, 'updown')).toEqual([cv(60), cv(64), cv(67), cv(64)])
    expect(arpOrder([cv(60)], 'updown')).toEqual([cv(60)])
  })

  it('octaves stack copies 0.1 apart', () => {
    const two = arpOrder([cv(60), cv(64)], 'up', 2)
    expect(two).toHaveLength(4)
    expect(two[2]).toBeCloseTo(cv(60) + 0.1, 9)
    expect(two[3]).toBeCloseTo(cv(64) + 0.1, 9)
    expect(arpOrder([cv(60)], 'up', 4)).toHaveLength(4)
  })

  it('clamps octaves and survives an empty or junk stack', () => {
    expect(arpOrder([], 'up')).toEqual([])
    expect(arpOrder(null, 'up')).toEqual([])
    expect(arpOrder([cv(60), undefined, NaN], 'up')).toEqual([cv(60)])
    expect(arpOrder([cv(60)], 'up', 99)).toHaveLength(4)
    expect(arpOrder([cv(60)], 'up', 0)).toHaveLength(1)
  })
})

describe('ARP module', () => {
  const play = (inst, ...notes) => notes.forEach(note => inst.onEvent('note', { type: 'note-on', note, time: 0 }))

  it('walks the held stack one note per clock', () => {
    const ctx = makeCtx()
    const emitEvent = vi.fn()
    const inst = arp.create(ctx, { params: { mode: 'up', octaves: 1, gateLen: 0.5, hold: 'off' }, emitEvent })
    play(inst, 64, 60, 67)

    const source = ctx.created.find(n => n.kind === 'const')
    inst.onEvent('clk', { type: 'trig', time: 1 })
    inst.onEvent('clk', { type: 'trig', time: 1.5 })
    inst.onEvent('clk', { type: 'trig', time: 2 })

    expect(source.offset.setValueAtTime.mock.calls.map(([v]) => v))
      .toEqual([cv(60), cv(64), cv(67)])
    expect(emitEvent).toHaveBeenCalledWith('gate', expect.objectContaining({ type: 'gate-on', time: 1 }))
    inst.dispose()
  })

  it('takes pitch from MIDI IN gate events too, where it arrives as `pitch`', () => {
    const ctx = makeCtx()
    const inst = arp.create(ctx, { params: { mode: 'up' } })
    inst.onEvent('note', { type: 'gate-on', time: 0, pitch: 72, channel: 0 })
    inst.onEvent('clk', { type: 'trig', time: 1 })
    expect(ctx.created.find(n => n.kind === 'const').offset.setValueAtTime)
      .toHaveBeenCalledWith(cv(72), 1)
    inst.dispose()
  })

  it('gate length is a fraction of the measured clock interval', () => {
    const ctx = makeCtx()
    const emitEvent = vi.fn()
    const inst = arp.create(ctx, { params: { mode: 'up', gateLen: 0.5 }, emitEvent })
    play(inst, 60)
    inst.onEvent('clk', { type: 'trig', time: 1 })
    inst.onEvent('clk', { type: 'trig', time: 2 })   // one second apart
    inst.onEvent('clk', { type: 'trig', time: 3 })
    expect(emitEvent).toHaveBeenCalledWith('gate', expect.objectContaining({ type: 'gate-off', time: 3.5 }))
    inst.dispose()
  })

  it('releasing a note drops it from the stack, unless HOLD is on', () => {
    const ctx = makeCtx()
    const inst = arp.create(ctx, { params: { mode: 'up' } })
    play(inst, 60, 64)
    inst.onEvent('note', { type: 'note-off', time: 0, note: 60 })
    const source = ctx.created.find(n => n.kind === 'const')
    inst.onEvent('clk', { type: 'trig', time: 1 })
    inst.onEvent('clk', { type: 'trig', time: 2 })
    expect(source.offset.setValueAtTime.mock.calls.map(([v]) => v)).toEqual([cv(64), cv(64)])

    const holdCtx = makeCtx()
    const holding = arp.create(holdCtx, { params: { mode: 'up', hold: 'on' } })
    play(holding, 60, 64)
    holding.onEvent('note', { type: 'note-off', time: 0, note: 60 })
    holding.onEvent('clk', { type: 'trig', time: 1 })
    holding.onEvent('clk', { type: 'trig', time: 2 })
    expect(holdCtx.created.find(n => n.kind === 'const').offset.setValueAtTime.mock.calls.map(([v]) => v))
      .toEqual([cv(60), cv(64)])

    inst.dispose()
    holding.dispose()
  })

  it('an empty stack emits nothing', () => {
    const ctx = makeCtx()
    const emitEvent = vi.fn()
    const inst = arp.create(ctx, { params: {}, emitEvent })
    inst.onEvent('clk', { type: 'trig', time: 1 })
    expect(emitEvent).not.toHaveBeenCalled()
    inst.dispose()
  })

  it('RST clears the stack and the step cursor', () => {
    const ctx = makeCtx()
    const emitEvent = vi.fn()
    const inst = arp.create(ctx, { params: { mode: 'up' }, emitEvent })
    play(inst, 60, 64)
    inst.onEvent('clk', { type: 'trig', time: 1 })
    inst.onEvent('rst', { type: 'trig', time: 2 })
    emitEvent.mockClear()
    inst.onEvent('clk', { type: 'trig', time: 3 })
    expect(emitEvent).not.toHaveBeenCalled()
    inst.dispose()
  })

  it('random mode picks through opts.random rather than the cursor', () => {
    const ctx = makeCtx()
    const inst = arp.create(ctx, { params: { mode: 'random' }, random: () => 0.99 })
    play(inst, 60, 64, 67)
    inst.onEvent('clk', { type: 'trig', time: 1 })
    // 0.99 of three as-played notes is the last one played.
    expect(ctx.created.find(n => n.kind === 'const').offset.setValueAtTime)
      .toHaveBeenCalledWith(cv(67), 1)
    inst.dispose()
  })

  it('dispose stops the CV source and disconnects', () => {
    const ctx = makeCtx()
    arp.create(ctx, { params: {} }).dispose()
    for (const node of ctx.created) {
      expect(node.disconnected).toBeGreaterThan(0)
      if (node.kind === 'const') expect(node.stopped).toBe(1)
    }
  })
})
