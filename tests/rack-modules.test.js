import { describe, it, expect, beforeEach, vi } from 'vitest'
import MODULES, { validateRegistry, paramDefaults } from '../src/renderer/js/rack/modules/index.js'
import RackEngine from '../src/renderer/js/rack/rack-engine.js'
import clock from '../src/renderer/js/rack/modules/clock.js'
import keys from '../src/renderer/js/rack/modules/keys.js'
import drum from '../src/renderer/js/rack/modules/drum.js'

// ---------------------------------------------------------------------------
// Fuller BaseAudioContext fake — every node type the P0 module set builds.
// ---------------------------------------------------------------------------
function makeCtx() {
  const created = []
  const param = () => ({
    value: 0,
    setValueAtTime: vi.fn(),
    setTargetAtTime: vi.fn(),
    linearRampToValueAtTime: vi.fn(),
    exponentialRampToValueAtTime: vi.fn(),
    cancelScheduledValues: vi.fn()
  })
  const node = (kind, extra = {}) => {
    const n = {
      kind,
      started: 0,
      stopped: 0,
      disconnected: 0,
      connect: vi.fn(dst => dst),
      disconnect: vi.fn(function () { n.disconnected++ }),
      ...extra
    }
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
    sampleRate: 44100,
    created,
    counts: kind => created.filter(n => n.kind === kind).length,
    createGain: () => node('gain', { gain: param() }),
    createDelay: () => node('delay', { delayTime: param() }),
    createBiquadFilter: () => node('biquad', { type: 'lowpass', frequency: param(), detune: param(), Q: param(), gain: param() }),
    createWaveShaper: () => node('shaper', { curve: null, oversample: 'none' }),
    createConvolver: () => node('convolver', { buffer: null }),
    createDynamicsCompressor: () => node('comp', { threshold: param(), knee: param(), ratio: param(), attack: param(), release: param(), reduction: 0 }),
    createAnalyser: () => node('analyser', { fftSize: 2048 }),
    createChannelMerger: () => node('merger'),
    createChannelSplitter: () => node('splitter'),
    createStereoPanner: () => node('panner', { pan: param() }),
    createOscillator: () => source('osc', { type: 'sine', frequency: param(), detune: param() }),
    createConstantSource: () => source('const', { offset: param() }),
    createBufferSource: () => source('bufsrc', { buffer: null, loop: false, playbackRate: param() }),
    createBuffer: (ch, len) => ({
      numberOfChannels: ch,
      length: len,
      getChannelData: () => new Float32Array(len)
    })
  }
}

// A starter-patch-shaped rack over whatever the registry actually ships.
function starterRack() {
  const modules = Object.keys(MODULES).map((type, i) => ({
    id: `m-${i}`, type, rail: 0, hp: i * 4, params: {}, atten: {}, bypassed: false
  }))
  const byType = Object.fromEntries(modules.map(m => [m.type, m.id]))
  const cables = []
  let n = 0
  const patch = (fromType, fromPort, toType, toPort) => {
    if (!byType[fromType] || !byType[toType]) return
    cables.push({
      id: `c-${++n}`,
      from: { moduleId: byType[fromType], port: fromPort },
      to: { moduleId: byType[toType], port: toPort },
      color: null
    })
  }
  patch('vco', 'out', 'vcf', 'in')
  patch('vcf', 'out', 'vca', 'in')
  patch('vca', 'out', 'out', 'in')
  patch('adsr', 'env', 'vca', 'cv')
  patch('lfo', 'bi', 'vcf', 'cut')
  patch('noise', 'wht', 'vcf', 'in')
  return { id: 'rack-1', name: 'Starter', rails: 3, railHp: 104, polyLimit: 8, modules, cables }
}

describe('shipped module registry', () => {
  let ctx

  beforeEach(() => { ctx = makeCtx() })

  it('validates', () => {
    expect(validateRegistry(MODULES)).toEqual([])
  })

  it('ships the P0 basic-voice set, all native tier', () => {
    for (const type of ['vco', 'vcf', 'vca', 'adsr', 'lfo', 'noise', 'mix', 'att', 'out']) {
      expect(MODULES[type], `missing module: ${type}`).toBeTruthy()
      expect(MODULES[type].tier, `${type} must not be worklet tier`).toBe('native')
    }
  })

  it('ships Phase 3 native event modules', () => {
    for (const type of ['clock', 'seq8', 'clkdiv', 'ad', 'rnd', 'euclid', 'quant']) {
      expect(MODULES[type], `missing module: ${type}`).toBeTruthy()
      expect(MODULES[type].tier).toBe('native')
    }
  })

  // QUANT's IN jack used to be a landing pad nothing read, so a plain trigger
  // quantized 0 and the jack was a trap — which is how Generative Euclid ended
  // up with a quantizer stuck at one note.
  describe('QUANT reads the pitch it is given', () => {
    const build = () => {
      const jobs = new Set()
      const poll = { add: j => { jobs.add(j); return () => jobs.delete(j) } }
      const inst = MODULES.quant.create(ctx, { channels: 1, params: paramDefaults('quant'), poll })
      return { inst, runPoll: () => jobs.forEach(j => j()) }
    }

    it('prefers a value carried on the trigger event', () => {
      const { inst } = build()
      inst.onEvent('trig', { type: 'trig', time: 1, cv: 0.1 })
      const held = ctx.created.filter(n => n.kind === 'const').at(-1)
      expect(held.offset.setValueAtTime).toHaveBeenCalledWith(0.1, 1)
    })

    it('falls back to the IN jack when the event carries nothing', () => {
      const { inst, runPoll } = build()
      const analyser = inst.inputs.in[0]
      analyser.getFloatTimeDomainData = buf => { buf[0] = 0.1 }
      runPoll()
      inst.onEvent('trig', { type: 'trig', time: 2 })
      const held = ctx.created.filter(n => n.kind === 'const').at(-1)
      expect(held.offset.setValueAtTime).toHaveBeenCalledWith(0.1, 2)
    })
  })

  it('RND hands its drawn value to whatever it triggers', () => {
    const emitted = []
    const inst = MODULES.rnd.create(ctx, {
      params: { ...paramDefaults('rnd'), range: 1, bipolar: 'off', probability: 1 },
      emitEvent: (port, ev) => emitted.push([port, ev]),
      random: () => 0.5
    })
    inst.onEvent('trig', { type: 'trig', time: 3 })
    const gate = emitted.find(([port]) => port === 'gate')
    expect(gate?.[1].cv).toBe(0.5)
    inst.dispose()
  })

  it('ships every Phase 6 module, with worklet-only DSP explicitly marked', () => {
    for (const type of ['fmop', 'drum', 'drive', 'fold', 'slew', 's&h', 'math', 'mult', 'sum', 'comp', 'reverb', 'chorus', 'ringmod', 'scope', 'cv-mon', 'tuner', 'delay', 'split', 'merge']) expect(MODULES[type], `missing module: ${type}`).toBeTruthy()
    // FOLD stopped being a placeholder in E4 — it is a real WaveShaper now.
    for (const type of ['slew', 's&h', 'comp']) expect(MODULES[type].tier).toBe('worklet')
    expect(MODULES.fold.tier).toBe('native')
  })

  it('every module builds, exposes each declared port, and disposes clean', () => {
    for (const [type, def] of Object.entries(MODULES)) {
      const inst = def.create(ctx, { channels: 2, params: paramDefaults(type) })
      for (const port of def.ports) {
        const bag = port.dir === 'in' ? inst.inputs : inst.outputs
        expect(bag[port.id], `${type}.${port.id} missing`).toBeTruthy()
        expect(bag[port.id].length, `${type}.${port.id} has no channels`).toBeGreaterThan(0)
        if (def.poly === false) expect(bag[port.id].length, `${type} is mono`).toBe(1)
      }
      expect(() => inst.dispose()).not.toThrow()
    }
  })

  it('every param setter runs at both ends of its range', () => {
    for (const [type, def] of Object.entries(MODULES)) {
      const inst = def.create(ctx, { channels: 1, params: paramDefaults(type) })
      for (const p of def.params) {
        const values = p.options ? p.options : [p.min, p.max]
        for (const value of values) {
          expect(() => inst.setParam(p.key, value, 0), `${type}.${p.key} = ${value}`).not.toThrow()
        }
      }
      inst.dispose()
    }
  })

  it('mounts a starter patch and unmounts without leaving sources running', () => {
    const output = ctx.createGain()
    const handle = RackEngine.mount(ctx, starterRack(), { output })
    expect(handle.mods.size).toBe(Object.keys(MODULES).length)
    for (const [, link] of handle.cables) expect(link.links.length).toBeGreaterThan(0)

    RackEngine.unmount(handle)
    const leaked = ctx.created.filter(n => n.start && n.started > 0 && n.stopped === 0)
    expect(leaked.map(n => n.kind)).toEqual([])
  })

  it('survives 100 graph updates without leaking running sources', () => {
    const output = ctx.createGain(), state = starterRack(), handle = RackEngine.mount(ctx, state, { output })
    for (let i = 0; i < 100; i++) { const next = structuredClone(state); next.modules[0].hp = i % 40; RackEngine.update(handle, next) }
    RackEngine.unmount(handle)
    expect(ctx.created.filter(n => n.start && n.started > 0 && n.stopped === 0)).toEqual([])
  })

  it('an ADSR gate event schedules a ramp at the event time', () => {
    const handle = RackEngine.mount(ctx, starterRack(), { output: ctx.createGain() })
    const adsrId = handle.rack.modules.find(m => m.type === 'adsr')?.id
    const inst = RackEngine.getInstance(handle, adsrId)
    const envSource = ctx.created.find(n => n.kind === 'const' && n.offset.linearRampToValueAtTime)
    inst.onEvent('gate', { type: 'gate-on', time: 2.5, channel: 0 })
    const ramped = ctx.created.some(n => n.kind === 'const' && n.offset.linearRampToValueAtTime.mock.calls.length > 0)
    expect(envSource).toBeTruthy()
    expect(ramped).toBe(true)
    RackEngine.unmount(handle)
  })

  it('KEYS mounts as a poly note source and disposes clean, like MIDI IN', () => {
    const inst = keys.create(ctx, { channels: 4, params: paramDefaults('keys') })
    expect(inst.outputs.v_oct.length).toBe(4)
    expect(inst.outputs.gate.length).toBe(4)
    expect(inst.outputs.vel.length).toBe(4)
    inst.onEvent('note', { type: 'note-on', note: 60 })
    inst.dispose()
    const leaked = ctx.created.filter(n => n.start && n.started > 0 && n.stopped === 0)
    expect(leaked).toEqual([])
  })

  it('DRUM builds a voice with real kit params, not NaN', () => {
    const inst = drum.create(ctx, { params: paramDefaults('drum') })
    // createTr909Voice indexes the kit itself; handing it an already-indexed
    // entry made every param undefined and every AudioParam call non-finite.
    expect(() => inst.onEvent('trig', { type: 'trig', time: 1 })).not.toThrow()
    const nonFinite = ctx.created.flatMap(n =>
      [n.frequency, n.gain, n.offset, n.detune].filter(Boolean)
        .flatMap(p => (p.setValueAtTime?.mock?.calls || []).map(([value]) => value))
    ).filter(v => !Number.isFinite(v))
    expect(nonFinite).toEqual([])
    inst.dispose()
  })

  it('VC builds 4 inputs, 4 outs plus MIX, one channel', () => {
    const vc = MODULES.vc
    const inst = vc.create(ctx, { channels: 1, params: paramDefaults('vc') })
    for (const port of ['a', 'b', 'c', 'd']) expect(inst.inputs[port].length).toBe(1)
    for (const port of ['outa', 'outb', 'outc', 'outd']) expect(inst.outputs[port].length).toBe(1)
    // No MIX jack: D is the mix, because A cascades into B into C into D.
    expect(inst.outputs.mix).toBeUndefined()
    inst.dispose()
  })

  it('VC drops and restores its normal cleanly and leaves no source running after dispose', () => {
    const vc = MODULES.vc
    const inst = vc.create(ctx, { channels: 1, params: paramDefaults('vc') })
    inst.setPortPatched('a', true)
    inst.setPortPatched('a', false)
    inst.dispose()
    const leaked = ctx.created.filter(n => n.start && n.started > 0 && n.stopped === 0)
    expect(leaked).toEqual([])
  })

  it('VC cascades each strip into the next, and a patched output lifts it back out', () => {
    const vc = MODULES.vc
    const inst = vc.create(ctx, { channels: 1, params: paramDefaults('vc') })
    const sumA = inst.outputs.outa[0], sumB = inst.outputs.outb[0]
    // Built cascading: A already feeds B.
    expect(sumA.connect.mock.calls.some(([dst]) => dst === sumB)).toBe(true)

    // Patching A's output takes A out of B's sub-mix...
    inst.setPortPatched('outa', true)
    expect(sumA.disconnect).toHaveBeenCalledWith(sumB)
    // ...and unpatching puts it back, once.
    sumA.connect.mockClear()
    inst.setPortPatched('outa', false)
    expect(sumA.connect.mock.calls.filter(([dst]) => dst === sumB)).toHaveLength(1)
    inst.setPortPatched('outa', false)
    expect(sumA.connect.mock.calls.filter(([dst]) => dst === sumB)).toHaveLength(1)

    // D has nothing to its right, so patching it rewires nothing.
    const before = sumA.disconnect.mock.calls.length
    inst.setPortPatched('outd', true)
    expect(sumA.disconnect.mock.calls.length).toBe(before)
    inst.dispose()
  })

  it('BUS fans each of its two independent inputs out to its own four outputs', () => {
    const inst = MODULES.bus.create(ctx, { channels: 1, params: paramDefaults('bus') })
    expect(inst.inputs.in1.length).toBe(1)
    expect(inst.inputs.in2.length).toBe(1)
    for (const port of ['a1', 'b1', 'c1', 'd1', 'a2', 'b2', 'c2', 'd2']) expect(inst.outputs[port].length).toBe(1)
    const outs1 = ['a1', 'b1', 'c1', 'd1'].map(p => inst.outputs[p][0])
    const outs2 = ['a2', 'b2', 'c2', 'd2'].map(p => inst.outputs[p][0])
    // Every node bus1 touches is disjoint from every node bus2 touches.
    expect(outs1.some(n => outs2.includes(n))).toBe(false)
    expect(inst.inputs.in1[0].connect.mock.calls.map(c => c[0])).toEqual(outs1)
    expect(inst.inputs.in2[0].connect.mock.calls.map(c => c[0])).toEqual(outs2)
    inst.dispose()
  })

  it('CLOCK turns transport PPQN into quarter-note gates', () => {
    const emitEvent = vi.fn()
    const inst = clock.create(ctx, { params: { source: 'transport' }, emitEvent })

    for (let tick = 0; tick < 48; tick++) inst.onEvent('ext', { type: 'ppqn', tick, time: tick / 48 })

    expect(emitEvent.mock.calls.filter(([port, event]) => port === 'out' && event.type === 'gate-on')).toHaveLength(2)
    expect(emitEvent.mock.calls.filter(([port, event]) => port === 'div2' && event.type === 'gate-on')).toHaveLength(1)
    inst.dispose()
  })
})
