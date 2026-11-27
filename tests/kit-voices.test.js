import { describe, it, expect, vi } from 'vitest'
import { kitFor } from '../src/renderer/js/pads/kit.js'
import { kitInstrument } from '../src/renderer/js/pads/kit-voices.js'

function makeCtx() {
  const gains = []
  const sources = []
  const param = () => ({ value: 0, setValueAtTime: vi.fn(), setTargetAtTime: vi.fn(), linearRampToValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn(), cancelScheduledValues: vi.fn() })
  const node = (extra = {}) => ({ connect: vi.fn(d => d), disconnect: vi.fn(), ...extra })
  const source = extra => { const s = node({ start: vi.fn(), stop: vi.fn(), ...extra }); sources.push(s); return s }
  return {
    gains, sources,
    currentTime: 0,
    sampleRate: 44100,
    createGain: () => { const g = node({ gain: param() }); gains.push(g); return g },
    createBiquadFilter: () => node({ frequency: param(), Q: param(), gain: param(), detune: param() }),
    createWaveShaper: () => node({}),
    createOscillator: () => source({ frequency: param(), detune: param() }),
    createBufferSource: () => source({ playbackRate: param() }),
    createBuffer: (ch, len) => ({ getChannelData: () => new Float32Array(len) })
  }
}

const kit = kitFor('default-909')

describe('kitInstrument', () => {
  it('a hit starts sources; an unmapped note or zero velocity is silent', () => {
    const ctx = makeCtx()
    const inst = kitInstrument(kit, { ctx, output: ctx.createGain() })
    inst.noteOn(36, 100, 0)
    expect(ctx.sources.length).toBeGreaterThan(0)
    const n = ctx.sources.length
    inst.noteOn(20, 100, 0)
    inst.noteOn(36, 0, 0)
    expect(ctx.sources.length).toBe(n)
  })

  it('noteOff and send are inert (one-shot)', () => {
    const ctx = makeCtx()
    const inst = kitInstrument(kit, { ctx, output: ctx.createGain() })
    expect(() => { inst.noteOff(36); inst.send({ type: 'mod', value: 1 }) }).not.toThrow()
  })

  it('a closed hat ducks the sounding open hat on its own gain, at the hit time', () => {
    const ctx = makeCtx()
    const out = ctx.createGain()
    const inst = kitInstrument(kit, { ctx, output: out })
    const mark = ctx.gains.length
    inst.noteOn(46, 100, 0)
    const openGain = ctx.gains[mark] // the choke gain is made before the voice
    expect(openGain.connect).toHaveBeenCalledWith(out)
    inst.noteOn(42, 100, 0.5)
    expect(openGain.gain.cancelScheduledValues).toHaveBeenCalledWith(0.5)
    expect(openGain.gain.setTargetAtTime).toHaveBeenCalledWith(0, 0.5, expect.any(Number))
  })

  it('pedal hat (44) chokes too; a second closed hat has nothing left to duck', () => {
    const ctx = makeCtx()
    const inst = kitInstrument(kit, { ctx, output: ctx.createGain() })
    const mark = ctx.gains.length
    inst.noteOn(46, 100, 0)
    const openGain = ctx.gains[mark] // the choke gain is made before the voice
    inst.noteOn(44, 100, 0.2)
    inst.noteOn(42, 100, 0.4)
    expect(openGain.gain.setTargetAtTime).toHaveBeenCalledTimes(1)
  })

  it('non-hat hits never touch the open hat', () => {
    const ctx = makeCtx()
    const inst = kitInstrument(kit, { ctx, output: ctx.createGain() })
    const mark = ctx.gains.length
    inst.noteOn(46, 100, 0)
    const openGain = ctx.gains[mark] // the choke gain is made before the voice
    inst.noteOn(36, 100, 0.1)
    inst.noteOn(49, 100, 0.1)
    expect(openGain.gain.setTargetAtTime).not.toHaveBeenCalled()
  })

  it('chokes are per instance: another kit instance keeps its open hat', () => {
    const ctx = makeCtx()
    const a = kitInstrument(kit, { ctx, output: ctx.createGain() })
    const b = kitInstrument(kit, { ctx, output: ctx.createGain() })
    const mark = ctx.gains.length
    a.noteOn(46, 100, 0)
    const openGain = ctx.gains[mark]
    b.noteOn(42, 100, 0.1)
    expect(openGain.gain.setTargetAtTime).not.toHaveBeenCalled()
  })

  it('prewarm builds the ROM buffers once; dispose ducks the open hat', () => {
    const ctx = makeCtx()
    ctx.createBuffer = vi.fn((ch, len) => ({ getChannelData: () => new Float32Array(len) }))
    const inst = kitInstrument(kit, { ctx, output: ctx.createGain() })
    inst.prewarm()
    const built = ctx.createBuffer.mock.calls.length
    expect(built).toBeGreaterThanOrEqual(3)
    const mark = ctx.gains.length
    inst.noteOn(46, 100, 0)
    expect(ctx.createBuffer.mock.calls.length).toBe(built)
    const openGain = ctx.gains[mark]
    inst.dispose()
    expect(openGain.gain.setTargetAtTime).toHaveBeenCalled()
  })
})

describe('kitInstrument override', () => {
  const stops = ctx => ctx.sources.flatMap(s => s.stop.mock.calls.map(c => c[0]))
  const longest = (override, slotPerf) => {
    const ctx = makeCtx()
    const k = slotPerf ? { ...kit, slots: { ...kit.slots, 36: { ...kit.slots[36], perf: slotPerf } } } : kit
    kitInstrument(k, { ctx, output: ctx.createGain() }).noteOn(36, 100, 0, override)
    return Math.max(...stops(ctx))
  }

  it('decayMul shortens the voice; slot perf combines with the per-hit layer', () => {
    expect(longest({ decayMul: 0.5 })).toBeLessThan(longest())
    expect(longest({ decayMul: 0.5 }, { decayMul: 0.5 })).toBeLessThan(longest({ decayMul: 0.5 }))
  })

  it('tuneSt and unknown keys are harmless and never touch the stored tune', () => {
    const ctx = makeCtx()
    const inst = kitInstrument(kit, { ctx, output: ctx.createGain() })
    expect(() => inst.noteOn(36, 100, 0, { tuneSt: 5, bogus: 1, filterMul: 0.5, level: 0.5 })).not.toThrow()
    expect(kit.slots[36].params.tune).toBeUndefined()
  })
})

describe('kitInstrument perfFor', () => {
  it('reads the slot perf layer live, so a knob move needs no rebuild', () => {
    const ctx = makeCtx()
    let perf
    const inst = kitInstrument(kit, { ctx, output: ctx.createGain(), perfFor: () => perf })
    const longest = () => { ctx.sources.length = 0; inst.noteOn(36, 100, 0); return Math.max(...ctx.sources.flatMap(s => s.stop.mock.calls.map(c => c[0]))) }
    const plain = longest()
    perf = { decayMul: 0.5 }
    expect(longest()).toBeLessThan(plain)
  })
})
