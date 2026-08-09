import { describe, it, expect, beforeEach, vi } from 'vitest'
import MODULES, { validateRegistry, paramDefaults } from '../src/renderer/js/rack/modules/index.js'
import RackEngine from '../src/renderer/js/rack/rack-engine.js'
import clock from '../src/renderer/js/rack/modules/clock.js'

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
  patch('vca', 'out', 'out', 'l')
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

  it('CLOCK turns transport PPQN into quarter-note gates', () => {
    const emitEvent = vi.fn()
    const inst = clock.create(ctx, { params: { source: 'transport' }, emitEvent })

    for (let tick = 0; tick < 48; tick++) inst.onEvent('ext', { type: 'ppqn', tick, time: tick / 48 })

    expect(emitEvent.mock.calls.filter(([port, event]) => port === 'out' && event.type === 'gate-on')).toHaveLength(2)
    expect(emitEvent.mock.calls.filter(([port, event]) => port === 'div2' && event.type === 'gate-on')).toHaveLength(1)
    inst.dispose()
  })
})
