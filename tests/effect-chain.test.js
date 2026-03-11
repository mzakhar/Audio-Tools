import { describe, it, expect, beforeEach, vi } from 'vitest'
import EffectChain from '../src/renderer/js/audio/effect-chain.js'

// ---------------------------------------------------------------------------
// Minimal AudioContext mock
// ---------------------------------------------------------------------------
const makeCtx = () => ({
  createBiquadFilter() {
    return {
      type: '',
      frequency: { value: 0 },
      gain: { value: 0 },
      Q: { value: 0 },
      connect: vi.fn(),
      disconnect: vi.fn()
    }
  },
  createDynamicsCompressor() {
    return {
      threshold: { value: 0 },
      ratio: { value: 0 },
      attack: { value: 0 },
      release: { value: 0 },
      knee: { value: 0 },
      connect: vi.fn(),
      disconnect: vi.fn()
    }
  },
  createGain() {
    return {
      gain: { value: 1 },
      connect: vi.fn(),
      disconnect: vi.fn()
    }
  }
})

// Minimal AudioNode mocks for input/output
function makeNode() {
  return { connect: vi.fn(), disconnect: vi.fn() }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EffectChain', () => {
  let ctx, input, output, chainHandle

  beforeEach(() => {
    ctx = makeCtx()
    input = makeNode()
    output = makeNode()
    chainHandle = EffectChain.create(ctx, input, output)
  })

  // ─── Empty chain ──────────────────────────────────────────────────────────

  describe('empty chain', () => {
    it('connects input directly to output when no effects are added', () => {
      expect(input.connect).toHaveBeenCalledWith(output)
    })
  })

  // ─── eq3 ──────────────────────────────────────────────────────────────────

  describe('eq3 effect', () => {
    it('creating eq3 calls createBiquadFilter 3 times', () => {
      // Use a fresh ctx with vi.fn() so we can count calls
      const spyCtx = makeCtx()
      spyCtx.createBiquadFilter = vi.fn(makeCtx().createBiquadFilter)
      const spyInput = makeNode()
      const spyOutput = makeNode()
      const ch = EffectChain.create(spyCtx, spyInput, spyOutput)
      EffectChain.addEffect(ch, 'eq3')
      expect(spyCtx.createBiquadFilter).toHaveBeenCalledTimes(3)
    })

    it('eq3 low shelf node has type lowshelf and frequency 100', () => {
      // We need to capture the nodes created. Use spies before adding.
      const filters = []
      ctx.createBiquadFilter = vi.fn(() => {
        const node = {
          type: '',
          frequency: { value: 0 },
          gain: { value: 0 },
          Q: { value: 0 },
          connect: vi.fn(),
          disconnect: vi.fn()
        }
        filters.push(node)
        return node
      })

      EffectChain.addEffect(chainHandle, 'eq3', { lowGain: 3, midGain: 0, highGain: -2 })

      expect(filters.length).toBe(3)
      expect(filters[0].type).toBe('lowshelf')
      expect(filters[0].frequency.value).toBe(100)
      expect(filters[0].gain.value).toBe(3)

      expect(filters[1].type).toBe('peaking')
      expect(filters[1].frequency.value).toBe(1000)

      expect(filters[2].type).toBe('highshelf')
      expect(filters[2].frequency.value).toBe(8000)
      expect(filters[2].gain.value).toBe(-2)
    })

    it('setEffectParam updates lowGain on the low shelf node', () => {
      const filters = []
      ctx.createBiquadFilter = vi.fn(() => {
        const node = {
          type: '',
          frequency: { value: 0 },
          gain: { value: 0 },
          Q: { value: 0 },
          connect: vi.fn(),
          disconnect: vi.fn()
        }
        filters.push(node)
        return node
      })

      const effectId = EffectChain.addEffect(chainHandle, 'eq3', {})
      EffectChain.setEffectParam(chainHandle, effectId, 'lowGain', 6)
      expect(filters[0].gain.value).toBe(6)
    })

    it('setEffectParam updates midGain on the peaking node', () => {
      const filters = []
      ctx.createBiquadFilter = vi.fn(() => {
        const node = {
          type: '',
          frequency: { value: 0 },
          gain: { value: 0 },
          Q: { value: 0 },
          connect: vi.fn(),
          disconnect: vi.fn()
        }
        filters.push(node)
        return node
      })

      const effectId = EffectChain.addEffect(chainHandle, 'eq3', {})
      EffectChain.setEffectParam(chainHandle, effectId, 'midGain', -4)
      expect(filters[1].gain.value).toBe(-4)
    })

    it('setEffectParam updates highGain on the high shelf node', () => {
      const filters = []
      ctx.createBiquadFilter = vi.fn(() => {
        const node = {
          type: '',
          frequency: { value: 0 },
          gain: { value: 0 },
          Q: { value: 0 },
          connect: vi.fn(),
          disconnect: vi.fn()
        }
        filters.push(node)
        return node
      })

      const effectId = EffectChain.addEffect(chainHandle, 'eq3', {})
      EffectChain.setEffectParam(chainHandle, effectId, 'highGain', 8)
      expect(filters[2].gain.value).toBe(8)
    })
  })

  // ─── compressor ───────────────────────────────────────────────────────────

  describe('compressor effect', () => {
    it('creating compressor calls createDynamicsCompressor once', () => {
      const spyCtx = makeCtx()
      spyCtx.createDynamicsCompressor = vi.fn(makeCtx().createDynamicsCompressor)
      const spyInput = makeNode()
      const spyOutput = makeNode()
      const ch = EffectChain.create(spyCtx, spyInput, spyOutput)
      EffectChain.addEffect(ch, 'compressor')
      expect(spyCtx.createDynamicsCompressor).toHaveBeenCalledTimes(1)
    })

    it('compressor params are set on the node', () => {
      let compNode = null
      ctx.createDynamicsCompressor = vi.fn(() => {
        compNode = {
          threshold: { value: 0 },
          ratio: { value: 0 },
          attack: { value: 0 },
          release: { value: 0 },
          knee: { value: 0 },
          connect: vi.fn(),
          disconnect: vi.fn()
        }
        return compNode
      })

      EffectChain.addEffect(chainHandle, 'compressor', {
        threshold: -18,
        ratio: 8,
        attack: 0.01,
        release: 0.5,
        knee: 10
      })

      expect(compNode.threshold.value).toBe(-18)
      expect(compNode.ratio.value).toBe(8)
      expect(compNode.attack.value).toBe(0.01)
      expect(compNode.release.value).toBe(0.5)
      expect(compNode.knee.value).toBe(10)
    })

    it('setEffectParam updates threshold on DynamicsCompressorNode', () => {
      let compNode = null
      ctx.createDynamicsCompressor = vi.fn(() => {
        compNode = {
          threshold: { value: 0 },
          ratio: { value: 0 },
          attack: { value: 0 },
          release: { value: 0 },
          knee: { value: 0 },
          connect: vi.fn(),
          disconnect: vi.fn()
        }
        return compNode
      })

      const effectId = EffectChain.addEffect(chainHandle, 'compressor', {})
      EffectChain.setEffectParam(chainHandle, effectId, 'threshold', -30)
      expect(compNode.threshold.value).toBe(-30)
    })
  })

  // ─── gain ─────────────────────────────────────────────────────────────────

  describe('gain effect', () => {
    it('creating gain calls createGain once', () => {
      const spyCtx = makeCtx()
      spyCtx.createGain = vi.fn(makeCtx().createGain)
      const spyInput = makeNode()
      const spyOutput = makeNode()
      const ch = EffectChain.create(spyCtx, spyInput, spyOutput)
      EffectChain.addEffect(ch, 'gain')
      expect(spyCtx.createGain).toHaveBeenCalledTimes(1)
    })

    it('setEffectParam updates gain value on GainNode', () => {
      let gainNode = null
      ctx.createGain = vi.fn(() => {
        gainNode = { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() }
        return gainNode
      })

      const effectId = EffectChain.addEffect(chainHandle, 'gain', { gain: 0.5 })
      EffectChain.setEffectParam(chainHandle, effectId, 'gain', 2)
      expect(gainNode.gain.value).toBe(2)
    })
  })

  // ─── getEffectParams ──────────────────────────────────────────────────────

  describe('getEffectParams', () => {
    it('returns current params for an effect', () => {
      const effectId = EffectChain.addEffect(chainHandle, 'gain', { gain: 0.75 })
      const params = EffectChain.getEffectParams(chainHandle, effectId)
      expect(params.gain).toBe(0.75)
    })

    it('reflects updated param after setEffectParam', () => {
      const effectId = EffectChain.addEffect(chainHandle, 'gain', { gain: 1 })
      EffectChain.setEffectParam(chainHandle, effectId, 'gain', 2)
      const params = EffectChain.getEffectParams(chainHandle, effectId)
      expect(params.gain).toBe(2)
    })
  })

  // ─── Max 4 effects ────────────────────────────────────────────────────────

  describe('effect limit', () => {
    it('adding 4 effects succeeds', () => {
      expect(() => {
        EffectChain.addEffect(chainHandle, 'gain')
        EffectChain.addEffect(chainHandle, 'gain')
        EffectChain.addEffect(chainHandle, 'gain')
        EffectChain.addEffect(chainHandle, 'gain')
      }).not.toThrow()
    })

    it('adding a 5th effect throws an error', () => {
      EffectChain.addEffect(chainHandle, 'gain')
      EffectChain.addEffect(chainHandle, 'gain')
      EffectChain.addEffect(chainHandle, 'gain')
      EffectChain.addEffect(chainHandle, 'gain')
      expect(() => EffectChain.addEffect(chainHandle, 'gain')).toThrow()
    })
  })

  // ─── removeEffect rewiring ────────────────────────────────────────────────

  describe('removeEffect', () => {
    it('removing the only effect re-connects input directly to output', () => {
      // Reset input mock to count fresh
      input.connect.mockClear()
      const effectId = EffectChain.addEffect(chainHandle, 'gain')
      input.connect.mockClear()
      output.connect = vi.fn()

      EffectChain.removeEffect(chainHandle, effectId)

      // After removal, input should connect directly to output
      expect(input.connect).toHaveBeenCalledWith(output)
    })

    it('removes the effect from the chain (no throw on valid id)', () => {
      const effectId = EffectChain.addEffect(chainHandle, 'gain')
      expect(() => EffectChain.removeEffect(chainHandle, effectId)).not.toThrow()
    })

    it('ignores unknown effectId silently', () => {
      expect(() => EffectChain.removeEffect(chainHandle, 'nonexistent-id')).not.toThrow()
    })

    it('rewires correctly when removing middle effect of 3', () => {
      // Add three gain effects, capture their nodes
      const gainNodes = []
      ctx.createGain = vi.fn(() => {
        const node = { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() }
        gainNodes.push(node)
        return node
      })

      const id0 = EffectChain.addEffect(chainHandle, 'gain')
      const id1 = EffectChain.addEffect(chainHandle, 'gain')
      const id2 = EffectChain.addEffect(chainHandle, 'gain')

      // Clear mocks to only watch post-removal connections
      gainNodes.forEach(n => { n.connect.mockClear(); n.disconnect.mockClear() })
      input.connect.mockClear()

      EffectChain.removeEffect(chainHandle, id1)

      // After removing middle: input → node0 → node2 → output
      expect(input.connect).toHaveBeenCalledWith(gainNodes[0])
      expect(gainNodes[0].connect).toHaveBeenCalledWith(gainNodes[2])
      expect(gainNodes[2].connect).toHaveBeenCalledWith(output)
    })
  })

  // ─── destroy ──────────────────────────────────────────────────────────────

  describe('destroy', () => {
    it('disconnects input node on destroy', () => {
      EffectChain.destroy(chainHandle)
      expect(input.disconnect).toHaveBeenCalled()
    })

    it('disconnects all effect nodes on destroy', () => {
      const gainNodes = []
      ctx.createGain = vi.fn(() => {
        const node = { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() }
        gainNodes.push(node)
        return node
      })

      EffectChain.addEffect(chainHandle, 'gain')
      EffectChain.addEffect(chainHandle, 'gain')
      EffectChain.destroy(chainHandle)

      gainNodes.forEach(node => {
        expect(node.disconnect).toHaveBeenCalled()
      })
    })

    it('does nothing if chain handle is unknown', () => {
      expect(() => EffectChain.destroy('unknown-chain-id')).not.toThrow()
    })
  })
})
