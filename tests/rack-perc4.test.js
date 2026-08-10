import { describe, it, expect, vi } from 'vitest'
import perc4, { chokeTargets } from '../src/renderer/js/rack/modules/perc4.js'
import { paramDefaults } from '../src/renderer/js/rack/modules/index.js'

function makeCtx() {
  const created = []
  const param = () => ({
    value: 0,
    setValueAtTime: vi.fn(),
    setTargetAtTime: vi.fn(),
    linearRampToValueAtTime: vi.fn(),
    cancelScheduledValues: vi.fn()
  })
  const node = (kind, extra = {}) => {
    const n = { kind, started: 0, stopped: 0, connect: vi.fn(), disconnect: vi.fn(), ...extra }
    created.push(n)
    return n
  }
  const source = (kind, extra) => node(kind, {
    start: vi.fn(function () { this.started++ }),
    stop: vi.fn(function () { this.stopped++ }),
    ...extra
  })
  return {
    currentTime: 0,
    created,
    createGain: () => node('gain', { gain: param() }),
    createConstantSource: () => source('const', { offset: param() }),
    createAnalyser: () => node('analyser', { fftSize: 2048, getFloatTimeDomainData: buf => buf.fill(0) })
  }
}

describe('chokeTargets', () => {
  it('off never chokes anything', () => {
    expect(chokeTargets('off', 1, 4)).toEqual([])
  })

  it('pairs: an odd channel chokes the even one below it', () => {
    expect(chokeTargets('pairs', 1, 4)).toEqual([0])
    expect(chokeTargets('pairs', 3, 4)).toEqual([2])
    expect(chokeTargets('pairs', 0, 4)).toEqual([])
    expect(chokeTargets('pairs', 2, 4)).toEqual([])
  })

  it('cascade: a channel chokes every lower-numbered channel', () => {
    expect(chokeTargets('cascade', 3, 4)).toEqual([0, 1, 2])
    expect(chokeTargets('cascade', 0, 4)).toEqual([])
  })

  it('never returns the firing channel or an out-of-range index', () => {
    for (const mode of ['off', 'pairs', 'cascade']) {
      for (let ch = 0; ch < 4; ch++) {
        const targets = chokeTargets(mode, ch, 4)
        expect(targets).not.toContain(ch)
        for (const t of targets) expect(t).toBeGreaterThanOrEqual(0)
        for (const t of targets) expect(t).toBeLessThan(4)
      }
    }
  })
})

describe('PERC4 module', () => {
  it('exposes 4 env channels, a single mixed out, and a mono str input', () => {
    const ctx = makeCtx()
    const inst = perc4.create(ctx, { channels: 4, params: paramDefaults('perc4') })
    expect(inst.outputs.env.length).toBe(4)
    expect(inst.outputs.out.length).toBe(1)
    expect(inst.inputs.str.length).toBe(1)
    inst.dispose()
  })

  it('dispose stops every ConstantSource it created', () => {
    const ctx = makeCtx()
    const inst = perc4.create(ctx, { channels: 4, params: paramDefaults('perc4') })
    inst.dispose()
    const leaked = ctx.created.filter(n => n.start && n.started > 0 && n.stopped === 0)
    expect(leaked).toEqual([])
  })

  it('fires a channel on trig without throwing', () => {
    const ctx = makeCtx()
    const inst = perc4.create(ctx, { channels: 4, params: paramDefaults('perc4') })
    expect(() => inst.onEvent('trig', { type: 'trig', time: 1, channel: 1 })).not.toThrow()
    inst.dispose()
  })
})
