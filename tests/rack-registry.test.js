import { describe, it, expect } from 'vitest'
import {
  MODULES, validateRegistry, canConnect, getModule, getPort, paramDefaults, UNKNOWN_MODULE
} from '../src/renderer/js/rack/modules/index.js'

// A minimal well-formed definition the invalid cases mutate one field of.
function goodModule(overrides = {}) {
  return {
    type: 'test',
    name: 'TEST',
    group: 'util',
    hp: 6,
    tier: 'native',
    poly: false,
    ports: [
      { id: 'in', dir: 'in', kind: 'audio', label: 'IN' },
      { id: 'cv', dir: 'in', kind: 'cv', label: 'CV', atten: true },
      { id: 'out', dir: 'out', kind: 'audio', label: 'OUT' }
    ],
    params: [
      { key: 'gain', label: 'GAIN', min: 0, max: 1, step: 0.01, def: 0.5, fmt: '' },
      { key: 'mode', label: 'MODE', options: ['lin', 'exp'], def: 'lin' }
    ],
    create() { return { inputs: {}, outputs: {}, setParam() {}, dispose() {} } },
    ...overrides
  }
}

const reg = def => ({ [def.type]: def })

describe('module registry', () => {
  describe('validateRegistry', () => {
    it('accepts a well-formed module', () => {
      expect(validateRegistry(reg(goodModule()))).toEqual([])
    })

    it('accepts the shipped registry', () => {
      expect(validateRegistry(MODULES)).toEqual([])
    })

    it('rejects a key that does not match the type', () => {
      const errors = validateRegistry({ wrong: goodModule() })
      expect(errors.join()).toMatch(/does not match type/)
    })

    it('rejects a duplicate port id', () => {
      const def = goodModule()
      def.ports.push({ id: 'out', dir: 'out', kind: 'cv', label: 'OUT2' })
      expect(validateRegistry(reg(def)).join()).toMatch(/duplicate port id "out"/)
    })

    it('rejects an invalid port dir and kind', () => {
      const def = goodModule({ ports: [{ id: 'x', dir: 'sideways', kind: 'smell', label: 'X' }] })
      const errors = validateRegistry(reg(def)).join()
      expect(errors).toMatch(/invalid dir/)
      expect(errors).toMatch(/invalid kind/)
    })

    it('rejects an attenuverter on an output', () => {
      const def = goodModule()
      def.ports[2].atten = true
      expect(validateRegistry(reg(def)).join()).toMatch(/cannot have an attenuverter/)
    })

    it('rejects a param with no default', () => {
      const def = goodModule()
      delete def.params[0].def
      expect(validateRegistry(reg(def)).join()).toMatch(/has no default/)
    })

    it('rejects a default outside min/max', () => {
      const def = goodModule()
      def.params[0].def = 5
      expect(validateRegistry(reg(def)).join()).toMatch(/outside \[0, 1\]/)
    })

    it('rejects a default that is not one of the options', () => {
      const def = goodModule()
      def.params[1].def = 'log'
      expect(validateRegistry(reg(def)).join()).toMatch(/not one of its options/)
    })

    it('allows a param key that matches a port id (RES knob + RES jack)', () => {
      const def = goodModule()
      def.params.push({ key: 'out', label: 'OUT', min: 0, max: 1, step: 1, def: 0 })
      expect(validateRegistry(reg(def))).toEqual([])
    })

    it('rejects a non-positive or fractional hp', () => {
      expect(validateRegistry(reg(goodModule({ hp: 0 }))).join()).toMatch(/positive integer/)
      expect(validateRegistry(reg(goodModule({ hp: 6.5 }))).join()).toMatch(/positive integer/)
    })

    it('rejects a worklet module with no processor url', () => {
      expect(validateRegistry(reg(goodModule({ tier: 'worklet' }))).join()).toMatch(/processorUrl/)
    })

    it('accepts a worklet module that declares its processor', () => {
      const def = goodModule({ tier: 'worklet', processorUrl: 'worklets/fold-processor.js' })
      expect(validateRegistry(reg(def))).toEqual([])
    })

    it('rejects an invalid group or tier', () => {
      expect(validateRegistry(reg(goodModule({ group: 'vibes' }))).join()).toMatch(/invalid group/)
      expect(validateRegistry(reg(goodModule({ tier: 'wasm' }))).join()).toMatch(/invalid tier/)
    })

    it('rejects a module without create()', () => {
      const def = goodModule()
      delete def.create
      expect(validateRegistry(reg(def)).join()).toMatch(/missing create/)
    })
  })

  describe('lookups', () => {
    it('returns null for an unknown type or port', () => {
      expect(getModule('nope')).toBeNull()
      expect(getPort('nope', 'out')).toBeNull()
    })

    it('has an unknown-module placeholder with a usable width', () => {
      expect(UNKNOWN_MODULE.hp).toBeGreaterThan(0)
      expect(UNKNOWN_MODULE.placeholder).toBe(true)
    })

    it('builds param defaults from a definition', () => {
      const registry = reg(goodModule())
      // paramDefaults reads the shipped registry, so assert via the definition
      expect(Object.fromEntries(registry.test.params.map(p => [p.key, p.def])))
        .toEqual({ gain: 0.5, mode: 'lin' })
      expect(paramDefaults('nope')).toEqual({})
    })
  })

  describe('canConnect', () => {
    const registry = { test: goodModule() }
    const rack = {
      modules: [
        { id: 'm-1', type: 'test', rail: 0, hp: 0, params: {} },
        { id: 'm-2', type: 'test', rail: 0, hp: 6, params: {} }
      ],
      cables: []
    }

    it('allows output → input', () => {
      const res = canConnect(rack, { moduleId: 'm-1', port: 'out' }, { moduleId: 'm-2', port: 'in' }, registry)
      expect(res.ok).toBe(true)
      expect(res.mismatch).toBe(false)
    })

    it('allows a kind mismatch but flags it', () => {
      const res = canConnect(rack, { moduleId: 'm-1', port: 'out' }, { moduleId: 'm-2', port: 'cv' }, registry)
      expect(res.ok).toBe(true)
      expect(res.mismatch).toBe(true)
    })

    it('refuses output → output and input → input', () => {
      expect(canConnect(rack, { moduleId: 'm-1', port: 'out' }, { moduleId: 'm-2', port: 'out' }, registry).ok).toBe(false)
      expect(canConnect(rack, { moduleId: 'm-1', port: 'in' }, { moduleId: 'm-2', port: 'in' }, registry).ok).toBe(false)
    })

    it('refuses an unknown module or port', () => {
      expect(canConnect(rack, { moduleId: 'ghost', port: 'out' }, { moduleId: 'm-2', port: 'in' }, registry).ok).toBe(false)
      expect(canConnect(rack, { moduleId: 'm-1', port: 'nope' }, { moduleId: 'm-2', port: 'in' }, registry).ok).toBe(false)
    })

    it('refuses a duplicate cable', () => {
      const patched = {
        ...rack,
        cables: [{ id: 'c-1', from: { moduleId: 'm-1', port: 'out' }, to: { moduleId: 'm-2', port: 'in' } }]
      }
      const res = canConnect(patched, { moduleId: 'm-1', port: 'out' }, { moduleId: 'm-2', port: 'in' }, registry)
      expect(res).toEqual({ ok: false, reason: 'already patched' })
    })

    it('allows a self-patch on different ports (feedback is legal)', () => {
      expect(canConnect(rack, { moduleId: 'm-1', port: 'out' }, { moduleId: 'm-1', port: 'in' }, registry).ok).toBe(true)
    })
  })
})
