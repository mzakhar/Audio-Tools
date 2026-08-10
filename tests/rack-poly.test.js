import { describe, it, expect } from 'vitest'
import { resolveChannels, cableChannels, isMixdown } from '../src/renderer/js/rack/poly.js'

const registry = {
  'midi-in': { poly: true, polySource: m => m.params.voices },
  vco: { poly: true },
  vcf: { poly: true },
  vca: { poly: true },
  lfo: { poly: false },
  out: { poly: false },
  merge: { poly: true, polySource: (m, rack) => rack.cables.filter(c => c.to.moduleId === m.id).length },
  split: { poly: false }
}

function rack(modules, cables, overrides = {}) {
  return { id: 'r1', name: 'Rack', rails: 1, railHp: 104, polyLimit: 8, modules, cables, ...overrides }
}

function cable(id, fromId, fromPort, toId, toPort) {
  return { id, from: { moduleId: fromId, port: fromPort }, to: { moduleId: toId, port: toPort } }
}

describe('resolveChannels', () => {
  it('lone module = 1 channel', () => {
    const r = rack([{ id: 'm1', type: 'vco', rail: 0, hp: 0, params: {} }], [])
    expect(resolveChannels(r, registry).get('m1')).toBe(1)
  })

  it('MIDI IN voices propagates through a VCO/VCF/VCA chain', () => {
    const r = rack(
      [
        { id: 'midi', type: 'midi-in', rail: 0, hp: 0, params: { voices: 4 } },
        { id: 'vco', type: 'vco', rail: 0, hp: 8, params: {} },
        { id: 'vcf', type: 'vcf', rail: 0, hp: 16, params: {} },
        { id: 'vca', type: 'vca', rail: 0, hp: 24, params: {} }
      ],
      [
        cable('c1', 'midi', 'v_oct', 'vco', 'v_oct'),
        cable('c2', 'vco', 'out', 'vcf', 'in'),
        cable('c3', 'vcf', 'out', 'vca', 'in')
      ]
    )
    const ch = resolveChannels(r, registry)
    expect(ch.get('midi')).toBe(4)
    expect(ch.get('vco')).toBe(4)
    expect(ch.get('vcf')).toBe(4)
    expect(ch.get('vca')).toBe(4)
  })

  it('a poly:false module fed by a poly cable stays 1, and resets everything downstream', () => {
    const r = rack(
      [
        { id: 'midi', type: 'midi-in', rail: 0, hp: 0, params: { voices: 4 } },
        { id: 'lfo', type: 'lfo', rail: 0, hp: 8, params: {} },
        { id: 'vco', type: 'vco', rail: 0, hp: 16, params: {} }
      ],
      [
        cable('c1', 'midi', 'v_oct', 'lfo', 'sync'),
        cable('c2', 'lfo', 'out', 'vco', 'fm')
      ]
    )
    const ch = resolveChannels(r, registry)
    expect(ch.get('lfo')).toBe(1)
    expect(ch.get('vco')).toBe(1)
  })

  it('MERGE-style polySource counts connected inputs', () => {
    const r = rack(
      [
        { id: 'v1', type: 'vco', rail: 0, hp: 0, params: {} },
        { id: 'v2', type: 'vco', rail: 0, hp: 8, params: {} },
        { id: 'v3', type: 'vco', rail: 0, hp: 16, params: {} },
        { id: 'merge', type: 'merge', rail: 0, hp: 24, params: {} }
      ],
      [
        cable('c1', 'v1', 'out', 'merge', 'in1'),
        cable('c2', 'v2', 'out', 'merge', 'in2'),
        cable('c3', 'v3', 'out', 'merge', 'in3')
      ]
    )
    expect(resolveChannels(r, registry).get('merge')).toBe(3)
  })

  it('SPLIT-style poly:false module fed poly stays 1', () => {
    const r = rack(
      [
        { id: 'midi', type: 'midi-in', rail: 0, hp: 0, params: { voices: 4 } },
        { id: 'split', type: 'split', rail: 0, hp: 8, params: {} }
      ],
      [cable('c1', 'midi', 'v_oct', 'split', 'in')]
    )
    expect(resolveChannels(r, registry).get('split')).toBe(1)
  })

  it('clamps to polyLimit', () => {
    const r = rack(
      [{ id: 'midi', type: 'midi-in', rail: 0, hp: 0, params: { voices: 16 } }],
      [],
      { polyLimit: 8 }
    )
    expect(resolveChannels(r, registry).get('midi')).toBe(8)
  })

  it('unknown module type resolves to 1, no throw', () => {
    const r = rack([{ id: 'm1', type: 'nope', rail: 0, hp: 0, params: {} }], [])
    expect(() => resolveChannels(r, registry)).not.toThrow()
    expect(resolveChannels(r, registry).get('m1')).toBe(1)
  })

  it('a cycle terminates and returns finite numbers', () => {
    const r = rack(
      [
        { id: 'a', type: 'vco', rail: 0, hp: 0, params: {} },
        { id: 'b', type: 'vcf', rail: 0, hp: 8, params: {} }
      ],
      [
        cable('c1', 'a', 'out', 'b', 'in'),
        cable('c2', 'b', 'out', 'a', 'fm')
      ]
    )
    const ch = resolveChannels(r, registry)
    expect(Number.isFinite(ch.get('a'))).toBe(true)
    expect(Number.isFinite(ch.get('b'))).toBe(true)
  })

  it('two poly sources feeding one module: max wins', () => {
    const r = rack(
      [
        { id: 'midi1', type: 'midi-in', rail: 0, hp: 0, params: { voices: 2 } },
        { id: 'midi2', type: 'midi-in', rail: 0, hp: 8, params: { voices: 6 } },
        { id: 'vco', type: 'vco', rail: 0, hp: 16, params: {} }
      ],
      [
        cable('c1', 'midi1', 'v_oct', 'vco', 'v_oct'),
        cable('c2', 'midi2', 'v_oct', 'vco', 'sync')
      ]
    )
    expect(resolveChannels(r, registry).get('vco')).toBe(6)
  })
})

describe('cableChannels / isMixdown', () => {
  it('reports source channel count per cable and flags a poly→mono mixdown', () => {
    const r = rack(
      [
        { id: 'midi', type: 'midi-in', rail: 0, hp: 0, params: { voices: 4 } },
        { id: 'vco', type: 'vco', rail: 0, hp: 8, params: {} },
        { id: 'out', type: 'out', rail: 0, hp: 16, params: {} }
      ],
      [
        cable('c1', 'midi', 'v_oct', 'vco', 'v_oct'),
        cable('c2', 'vco', 'out', 'out', 'in')
      ]
    )
    const cc = cableChannels(r, registry)
    expect(cc.get('c1')).toBe(4)
    expect(cc.get('c2')).toBe(4)

    const outCable = { id: 'c2', from: { moduleId: 'vco', port: 'out' }, to: { moduleId: 'out', port: 'in' } }
    expect(isMixdown(r, registry, outCable)).toBe(true)

    const inCable = { id: 'c1', from: { moduleId: 'midi', port: 'v_oct' }, to: { moduleId: 'vco', port: 'v_oct' } }
    expect(isMixdown(r, registry, inCable)).toBe(false)
  })
})
