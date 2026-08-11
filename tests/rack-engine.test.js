import { describe, it, expect, beforeEach, vi } from 'vitest'
import RackEngine, { findCycleCables } from '../src/renderer/js/rack/rack-engine.js'

// ---------------------------------------------------------------------------
// Minimal BaseAudioContext fake — counts creations, connections and stops so
// the tests can assert node churn and disposal without a real audio device.
// ---------------------------------------------------------------------------
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
    const n = {
      kind,
      connections: [],
      disconnected: 0,
      connect: vi.fn(function (dst) { n.connections.push(dst); return dst }),
      disconnect: vi.fn(function () { n.disconnected++ }),
      ...extra
    }
    created.push(n)
    return n
  }
  return {
    currentTime: 0,
    sampleRate: 44100,
    created,
    counts: kind => created.filter(n => n.kind === kind).length,
    createGain: () => node('gain', { gain: param() }),
    createDelay: () => node('delay', { delayTime: param() }),
    createOscillator: () => node('osc', {
      type: 'sine', frequency: param(), detune: param(), start: vi.fn(), stop: vi.fn()
    }),
    createConstantSource: () => node('const', { offset: param(), start: vi.fn(), stop: vi.fn() })
  }
}

// ---------------------------------------------------------------------------
// Fixture modules — deterministic, independent of the shipped registry.
// ---------------------------------------------------------------------------
function makeRegistry() {
  const src = {
    type: 'src', name: 'SRC', group: 'source', hp: 4, tier: 'native', poly: true,
    ports: [{ id: 'in', dir: 'in', kind: 'audio', label: 'IN' },
            { id: 'out', dir: 'out', kind: 'audio', label: 'OUT' }],
    params: [{ key: 'level', label: 'LVL', min: 0, max: 1, step: 0.01, def: 0.5, fmt: '' }],
    create: vi.fn((ctx, { channels = 1, params }) => {
      const nodes = Array.from({ length: channels }, () => ctx.createOscillator())
      const setParam = vi.fn()
      return {
        inputs: { in: nodes }, outputs: { out: nodes },
        params, setParam, dispose: vi.fn(() => nodes.forEach(n => { n.stop(); n.disconnect() }))
      }
    })
  }
  const dst = {
    type: 'dst', name: 'DST', group: 'io', hp: 4, tier: 'native', poly: false, terminal: true,
    ports: [{ id: 'in', dir: 'in', kind: 'audio', label: 'IN' },
            { id: 'cv', dir: 'in', kind: 'cv', label: 'CV', atten: true }],
    params: [],
    create: vi.fn((ctx) => {
      const g = ctx.createGain()
      return {
        inputs: { in: [g], cv: [g.gain] }, outputs: {}, output: g,
        setParam: vi.fn(), setInputPatched: vi.fn(), dispose: vi.fn(() => g.disconnect())
      }
    })
  }
  const voices = {
    type: 'voices', name: 'VOICES', group: 'io', hp: 4, tier: 'native', poly: true,
    polySource: mod => mod.params.voices ?? 1,
    ports: [{ id: 'out', dir: 'out', kind: 'cv', label: 'OUT' }],
    params: [{ key: 'voices', label: 'V', min: 1, max: 8, step: 1, def: 1, fmt: '' }],
    create: vi.fn((ctx, { channels }) => {
      const nodes = Array.from({ length: channels }, () => ctx.createConstantSource())
      return { inputs: {}, outputs: { out: nodes }, setParam: vi.fn(), dispose: vi.fn() }
    })
  }
  const fold = {
    type: 'fold', name: 'FOLD', group: 'fx', hp: 6, tier: 'worklet', processorUrl: 'x.js', poly: false,
    ports: [{ id: 'in', dir: 'in', kind: 'audio', label: 'IN' },
            { id: 'out', dir: 'out', kind: 'audio', label: 'OUT' }],
    params: [],
    create: vi.fn()
  }
  return { src, dst, voices, fold }
}

const rack = (modules, cables = [], extra = {}) =>
  ({ id: 'rack-1', name: 'R', rails: 3, railHp: 104, polyLimit: 8, modules, cables, ...extra })

const mod = (id, type, params = {}, extra = {}) =>
  ({ id, type, rail: 0, hp: 0, params, atten: {}, bypassed: false, ...extra })

const cable = (id, fromId, fromPort, toId, toPort) =>
  ({ id, from: { moduleId: fromId, port: fromPort }, to: { moduleId: toId, port: toPort }, color: null })

describe('RackEngine', () => {
  let ctx, registry, output

  beforeEach(() => {
    ctx = makeCtx()
    registry = makeRegistry()
    output = ctx.createGain()
  })

  const mount = (state) => RackEngine.mount(ctx, state, { output, registry })

  describe('mount', () => {
    it('creates one instance per module', () => {
      mount(rack([mod('m-1', 'src'), mod('m-2', 'dst')]))
      expect(registry.src.create).toHaveBeenCalledTimes(1)
      expect(registry.dst.create).toHaveBeenCalledTimes(1)
    })

    it('passes the context in, never a global', () => {
      mount(rack([mod('m-1', 'src')]))
      expect(registry.src.create.mock.calls[0][0]).toBe(ctx)
    })

    it('connects a cable from output port to input port', () => {
      const handle = mount(rack(
        [mod('m-1', 'src'), mod('m-2', 'dst')],
        [cable('c-1', 'm-1', 'out', 'm-2', 'in')]
      ))
      const srcNode = RackEngine.getInstance(handle, 'm-1').outputs.out[0]
      const dstNode = RackEngine.getInstance(handle, 'm-2').inputs.in[0]
      expect(srcNode.connections).toContain(dstNode)
    })

    it('connects a terminal module to the rack output', () => {
      const handle = mount(rack([mod('m-2', 'dst')]))
      expect(RackEngine.getInstance(handle, 'm-2').output.connections).toContain(output)
    })

    it('inserts an attenuverter gain in front of an atten input', () => {
      const before = ctx.counts('gain')
      const handle = mount(rack(
        [mod('m-1', 'src'), mod('m-2', 'dst', {}, { atten: { cv: 0.5 } })],
        [cable('c-1', 'm-1', 'out', 'm-2', 'cv')]
      ))
      expect(ctx.counts('gain')).toBe(before + 2)   // dst's own gain + the attenuverter
      const atten = handle.atten.get('m-2:cv:0')
      expect(atten.gain.value).toBe(0.5)
    })

    it('skips a cable whose port does not exist without throwing', () => {
      const handle = mount(rack(
        [mod('m-1', 'src'), mod('m-2', 'dst')],
        [cable('c-1', 'm-1', 'nope', 'm-2', 'in')]
      ))
      expect(handle.cables.get('c-1').links).toEqual([])
    })
  })

  describe('placeholders', () => {
    it('keeps an unknown module type as a silent placeholder', () => {
      const handle = mount(rack([mod('m-1', 'mystery')], []))
      expect(RackEngine.getInstance(handle, 'm-1').placeholder).toBe(true)
    })

    it('makes a worklet-tier module a placeholder when the host has no worklet', () => {
      const handle = RackEngine.mount(ctx, rack([mod('m-1', 'fold')]), { output, registry, hasWorklet: false })
      expect(RackEngine.getInstance(handle, 'm-1').placeholder).toBe(true)
      expect(registry.fold.create).not.toHaveBeenCalled()
    })
  })

  describe('polyphony', () => {
    it('builds one subgraph per channel from a poly source', () => {
      const handle = mount(rack([mod('m-1', 'voices', { voices: 4 })]))
      expect(RackEngine.getChannels(handle, 'm-1')).toBe(4)
      expect(RackEngine.getInstance(handle, 'm-1').outputs.out).toHaveLength(4)
    })

    it('sums a poly source into a mono destination', () => {
      const handle = mount(rack(
        [mod('m-1', 'voices', { voices: 4 }), mod('m-2', 'dst')],
        [cable('c-1', 'm-1', 'out', 'm-2', 'in')]
      ))
      expect(handle.cables.get('c-1').links).toHaveLength(4)
    })

    it('rebuilds a module when its channel count changes', () => {
      const state = rack(
        [mod('m-1', 'voices', { voices: 2 }), mod('m-2', 'src')],
        [cable('c-1', 'm-1', 'out', 'm-2', 'in')]
      )
      const handle = mount(state)
      expect(RackEngine.getChannels(handle, 'm-2')).toBe(2)
      const next = JSON.parse(JSON.stringify(state))
      next.modules[0].params.voices = 4
      RackEngine.update(handle, next)
      expect(RackEngine.getChannels(handle, 'm-2')).toBe(4)
      expect(registry.src.create).toHaveBeenCalledTimes(2)
    })
  })

  describe('update — no churn', () => {
    it('moving a module does not restart its oscillator', () => {
      const state = rack([mod('m-1', 'src'), mod('m-2', 'dst')], [cable('c-1', 'm-1', 'out', 'm-2', 'in')])
      const handle = mount(state)
      const inst = RackEngine.getInstance(handle, 'm-1')
      const oscCount = ctx.counts('osc')

      const next = JSON.parse(JSON.stringify(state))
      next.modules[0].rail = 2
      next.modules[0].hp = 40
      next.name = 'renamed'
      next.cables[0].color = '#ff0055'
      RackEngine.update(handle, next)

      expect(RackEngine.getInstance(handle, 'm-1')).toBe(inst)
      expect(ctx.counts('osc')).toBe(oscCount)
      expect(registry.src.create).toHaveBeenCalledTimes(1)
      expect(inst.dispose).not.toHaveBeenCalled()
    })

    it('a param change calls setParam instead of rebuilding', () => {
      const state = rack([mod('m-1', 'src', { level: 0.5 })])
      const handle = mount(state)
      const inst = RackEngine.getInstance(handle, 'm-1')
      const next = JSON.parse(JSON.stringify(state))
      next.modules[0].params.level = 0.9
      RackEngine.update(handle, next)
      expect(inst.setParam).toHaveBeenCalledWith('level', 0.9, 0)
      expect(registry.src.create).toHaveBeenCalledTimes(1)
    })

    it('an attenuverter change retargets the existing gain node', () => {
      const state = rack(
        [mod('m-1', 'src'), mod('m-2', 'dst', {}, { atten: { cv: 0 } })],
        [cable('c-1', 'm-1', 'out', 'm-2', 'cv')]
      )
      const handle = mount(state)
      const atten = handle.atten.get('m-2:cv:0')
      const next = JSON.parse(JSON.stringify(state))
      next.modules[1].atten.cv = -0.75
      RackEngine.update(handle, next)
      expect(handle.atten.get('m-2:cv:0')).toBe(atten)
      expect(atten.gain.setTargetAtTime).toHaveBeenCalledWith(-0.75, 0, 0.01)
    })
  })

  describe('update — add and remove', () => {
    it('adds a module and its cable', () => {
      const state = rack([mod('m-1', 'src')])
      const handle = mount(state)
      const next = rack([mod('m-1', 'src'), mod('m-2', 'dst')], [cable('c-1', 'm-1', 'out', 'm-2', 'in')])
      RackEngine.update(handle, next)
      expect(handle.mods.size).toBe(2)
      expect(handle.cables.get('c-1').links).toHaveLength(1)
    })

    it('removing a module disposes it and drops its cable links', () => {
      const state = rack([mod('m-1', 'src'), mod('m-2', 'dst')], [cable('c-1', 'm-1', 'out', 'm-2', 'in')])
      const handle = mount(state)
      const inst = RackEngine.getInstance(handle, 'm-1')
      RackEngine.update(handle, rack([mod('m-2', 'dst')]))
      expect(inst.dispose).toHaveBeenCalled()
      expect(handle.mods.has('m-1')).toBe(false)
      expect(handle.cables.size).toBe(0)
    })

    it('removing a cable disconnects it', () => {
      const state = rack([mod('m-1', 'src'), mod('m-2', 'dst')], [cable('c-1', 'm-1', 'out', 'm-2', 'in')])
      const handle = mount(state)
      const srcNode = RackEngine.getInstance(handle, 'm-1').outputs.out[0]
      RackEngine.update(handle, rack([mod('m-1', 'src'), mod('m-2', 'dst')], []))
      expect(srcNode.disconnect).toHaveBeenCalled()
      expect(handle.cables.size).toBe(0)
    })
  })

  describe('cycles', () => {
    it('finds the cable that closes a cycle', () => {
      const state = rack(
        [mod('m-1', 'src'), mod('m-2', 'src')],
        [cable('c-1', 'm-1', 'out', 'm-2', 'in'), cable('c-2', 'm-2', 'out', 'm-1', 'in')]
      )
      expect([...findCycleCables(state)]).toEqual(['c-2'])
    })

    it('finds no cycle in a plain chain', () => {
      const state = rack(
        [mod('m-1', 'src'), mod('m-2', 'src'), mod('m-3', 'dst')],
        [cable('c-1', 'm-1', 'out', 'm-2', 'in'), cable('c-2', 'm-2', 'out', 'm-3', 'in')]
      )
      expect(findCycleCables(state).size).toBe(0)
    })

    it('inserts a DelayNode on the cycle-closing cable', () => {
      const state = rack(
        [mod('m-1', 'src'), mod('m-2', 'src')],
        [cable('c-1', 'm-1', 'out', 'm-2', 'in'), cable('c-2', 'm-2', 'out', 'm-1', 'in')]
      )
      const handle = mount(state)
      expect(ctx.counts('delay')).toBe(1)
      expect(handle.cables.get('c-2').nodes).toHaveLength(1)
      expect(handle.cables.get('c-1').nodes).toHaveLength(0)
    })
  })

  describe('events', () => {
    it('delivers an event along a cable to the destination port', () => {
      const state = rack([mod('m-1', 'src'), mod('m-2', 'dst')], [cable('c-1', 'm-1', 'out', 'm-2', 'in')])
      const handle = mount(state)
      const inst = RackEngine.getInstance(handle, 'm-2')
      inst.onEvent = vi.fn()
      const evt = { type: 'gate-on', time: 1.5, channel: 0 }
      RackEngine.emitEvent(handle, 'm-1', 'out', evt)
      expect(inst.onEvent).toHaveBeenCalledWith('in', evt)
    })

    it('does not deliver events down a port that is not patched', () => {
      const handle = mount(rack([mod('m-1', 'src'), mod('m-2', 'dst')], []))
      const inst = RackEngine.getInstance(handle, 'm-2')
      inst.onEvent = vi.fn()
      RackEngine.emitEvent(handle, 'm-1', 'out', { type: 'trig', time: 0 })
      expect(inst.onEvent).not.toHaveBeenCalled()
    })

    // Patching a module's own trigger output back into its trigger input is a
    // normal thing to try (a self-retriggering AD is a classic Krell patch) and
    // dispatch is synchronous, so without a depth guard it is a stack overflow.
    it('drops a patched event cycle instead of recursing', () => {
      const state = rack([mod('m-1', 'src')], [cable('c-1', 'm-1', 'out', 'm-1', 'in')])
      const handle = mount(state)
      const inst = RackEngine.getInstance(handle, 'm-1')
      let depth = 0
      inst.onEvent = () => { depth++; RackEngine.emitEvent(handle, 'm-1', 'out', { type: 'trig', time: 0 }) }
      expect(() => RackEngine.emitEvent(handle, 'm-1', 'out', { type: 'trig', time: 0 })).not.toThrow()
      expect(depth).toBeGreaterThan(1)
      expect(depth).toBeLessThan(200)
    })
  })

  describe('attenuverters', () => {
    it('passes an attenuated input at unity when the rack stores no value', () => {
      const handle = mount(rack(
        [mod('m-1', 'src'), mod('m-2', 'dst')],
        [cable('c-1', 'm-1', 'out', 'm-2', 'cv')]
      ))
      // A 0 default would silently swallow every cable into an attenuated input.
      expect(handle.atten.get('m-2:cv:0').gain.value).toBe(1)
    })

    it('still honours an explicitly stored zero', () => {
      const handle = mount(rack(
        [mod('m-1', 'src'), mod('m-2', 'dst', {}, { atten: { cv: 0 } })],
        [cable('c-1', 'm-1', 'out', 'm-2', 'cv')]
      ))
      expect(handle.atten.get('m-2:cv:0').gain.value).toBe(0)
    })
  })

  describe('normalled inputs', () => {
    it('tells a module which of its inputs a cable landed on', () => {
      const handle = mount(rack(
        [mod('m-1', 'src'), mod('m-2', 'dst')],
        [cable('c-1', 'm-1', 'out', 'm-2', 'cv')]
      ))
      const calls = RackEngine.getInstance(handle, 'm-2').setInputPatched.mock.calls
      expect(calls).toContainEqual(['cv', true])
      expect(calls).toContainEqual(['in', false])
    })

    it('restores the normal when the cable is pulled', () => {
      const patched = rack([mod('m-1', 'src'), mod('m-2', 'dst')], [cable('c-1', 'm-1', 'out', 'm-2', 'cv')])
      const handle = mount(patched)
      const inst = RackEngine.getInstance(handle, 'm-2')
      inst.setInputPatched.mockClear()

      RackEngine.update(handle, rack([mod('m-1', 'src'), mod('m-2', 'dst')], []))
      expect(inst.setInputPatched.mock.calls).toContainEqual(['cv', false])
    })
  })

  describe('setParamLive', () => {
    it('drives the instance directly without touching state', () => {
      const handle = mount(rack([mod('m-1', 'src', { level: 0.5 })]))
      RackEngine.setParamLive(handle, 'm-1', 'level', 0.2)
      expect(RackEngine.getInstance(handle, 'm-1').setParam).toHaveBeenCalledWith('level', 0.2, 0)
      expect(handle.rack.modules[0].params.level).toBe(0.5)
    })
  })

  describe('unmount', () => {
    it('disposes every module and leaves no live cable', () => {
      const state = rack(
        [mod('m-1', 'src'), mod('m-2', 'dst')],
        [cable('c-1', 'm-1', 'out', 'm-2', 'in')]
      )
      const handle = mount(state)
      const insts = ['m-1', 'm-2'].map(id => RackEngine.getInstance(handle, id))
      RackEngine.unmount(handle)
      insts.forEach(inst => expect(inst.dispose).toHaveBeenCalled())
      expect(handle.mods.size).toBe(0)
      expect(handle.cables.size).toBe(0)
    })

    it('survives 100 random edits and ends with nothing mounted', () => {
      let state = rack([mod('m-1', 'src'), mod('m-2', 'dst')], [cable('c-1', 'm-1', 'out', 'm-2', 'in')])
      const handle = mount(state)
      for (let i = 0; i < 100; i++) {
        const next = JSON.parse(JSON.stringify(state))
        if (i % 3 === 0) next.modules.push(mod(`x-${i}`, 'src'))
        if (i % 3 === 1 && next.modules.length > 2) next.modules.pop()
        if (i % 3 === 2) next.modules[0].hp = i
        next.cables = next.cables.filter(c => next.modules.some(m => m.id === c.to.moduleId))
        RackEngine.update(handle, next)
        state = next
      }
      RackEngine.unmount(handle)
      expect(handle.mods.size).toBe(0)
      expect(handle.cables.size).toBe(0)
      expect(handle.atten.size).toBe(0)
    })
  })
})
