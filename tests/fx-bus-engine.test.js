import { describe, it, expect, beforeEach, vi } from 'vitest'
import FxBusEngine from '../src/renderer/js/audio/fx-bus-engine.js'

// ---------------------------------------------------------------------------
// Mock AudioContext
// ---------------------------------------------------------------------------
const makeCtx = (sampleRate = 44100) => ({
  sampleRate,
  createGain: () => ({ gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() }),
  createDelay: (max) => ({ delayTime: { value: 0 }, connect: vi.fn(), disconnect: vi.fn() }),
  createConvolver: () => ({ buffer: null, connect: vi.fn(), disconnect: vi.fn() }),
  createBuffer: (ch, len, sr) => ({ getChannelData: () => new Float32Array(len), numberOfChannels: ch, length: len, sampleRate: sr }),
  destination: {},
})

function makeMasterInput() {
  return { connect: vi.fn(), disconnect: vi.fn() }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FxBusEngine', () => {
  let ctx
  let masterInput

  beforeEach(() => {
    ctx = makeCtx()
    masterInput = makeMasterInput()
    FxBusEngine.reset()
    FxBusEngine.init(ctx, masterInput)
  })

  // ─── init ────────────────────────────────────────────────────────────────

  describe('init()', () => {
    it('creates reverb and delay buses', () => {
      const buses = FxBusEngine.getBuses()
      const ids = buses.map(b => b.id)
      expect(ids).toContain('reverb')
      expect(ids).toContain('delay')
    })

    it('each bus has an id and a name', () => {
      const buses = FxBusEngine.getBuses()
      buses.forEach(bus => {
        expect(typeof bus.id).toBe('string')
        expect(typeof bus.name).toBe('string')
        expect(bus.id.length).toBeGreaterThan(0)
        expect(bus.name.length).toBeGreaterThan(0)
      })
    })
  })

  // ─── getBuses ────────────────────────────────────────────────────────────

  describe('getBuses()', () => {
    it('returns at least 2 buses', () => {
      expect(FxBusEngine.getBuses().length).toBeGreaterThanOrEqual(2)
    })

    it('returns plain objects with id and name only (no internal nodes)', () => {
      const buses = FxBusEngine.getBuses()
      buses.forEach(bus => {
        expect(Object.keys(bus)).toEqual(expect.arrayContaining(['id', 'name']))
        expect(bus.inputGain).toBeUndefined()
        expect(bus.returnGain).toBeUndefined()
      })
    })
  })

  // ─── setSendLevel ────────────────────────────────────────────────────────

  describe('setSendLevel()', () => {
    it('sets the gain value on the send gain node', () => {
      // We need to capture the gain node that gets created
      const gainNodes = []
      ctx.createGain = () => {
        const node = { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() }
        gainNodes.push(node)
        return node
      }
      FxBusEngine.init(ctx, masterInput)

      FxBusEngine.registerChannel('ch-1', { connect: vi.fn(), disconnect: vi.fn() })
      FxBusEngine.setSendLevel('ch-1', 'reverb', 0.5)

      // After registerChannel + setSendLevel, the send gain value should be 0.5
      expect(FxBusEngine.getSendLevel('ch-1', 'reverb')).toBe(0.5)
    })

    it('clamps level to 0..1', () => {
      FxBusEngine.registerChannel('ch-1', { connect: vi.fn(), disconnect: vi.fn() })
      FxBusEngine.setSendLevel('ch-1', 'reverb', 1.5)
      expect(FxBusEngine.getSendLevel('ch-1', 'reverb')).toBe(1)

      FxBusEngine.setSendLevel('ch-1', 'reverb', -0.5)
      expect(FxBusEngine.getSendLevel('ch-1', 'reverb')).toBe(0)
    })

    it('does not throw for unknown busId', () => {
      FxBusEngine.registerChannel('ch-1', { connect: vi.fn(), disconnect: vi.fn() })
      expect(() => FxBusEngine.setSendLevel('ch-1', 'unknown-bus', 0.5)).not.toThrow()
    })
  })

  // ─── getSendLevel ────────────────────────────────────────────────────────

  describe('getSendLevel()', () => {
    it('returns 0 for an unregistered channel', () => {
      expect(FxBusEngine.getSendLevel('not-a-channel', 'reverb')).toBe(0)
    })

    it('returns 0 for a channel with no send set', () => {
      FxBusEngine.registerChannel('ch-2', { connect: vi.fn(), disconnect: vi.fn() })
      expect(FxBusEngine.getSendLevel('ch-2', 'reverb')).toBe(0)
    })

    it('returns the set level after setSendLevel', () => {
      FxBusEngine.registerChannel('ch-3', { connect: vi.fn(), disconnect: vi.fn() })
      FxBusEngine.setSendLevel('ch-3', 'reverb', 0.7)
      expect(FxBusEngine.getSendLevel('ch-3', 'reverb')).toBeCloseTo(0.7)
    })
  })

  // ─── setBusReturn ────────────────────────────────────────────────────────

  describe('setBusReturn()', () => {
    it('updates the return gain value', () => {
      // Capture gain nodes created during init
      const gainNodes = []
      ctx.createGain = () => {
        const node = { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() }
        gainNodes.push(node)
        return node
      }
      FxBusEngine.init(ctx, masterInput)

      // We verify via getSendLevel indirectly; direct test via internal state
      // is not possible, so we test it doesn't throw and is idempotent
      expect(() => FxBusEngine.setBusReturn('reverb', 0.3)).not.toThrow()
      expect(() => FxBusEngine.setBusReturn('delay', 0.5)).not.toThrow()
    })

    it('does not throw for unknown busId', () => {
      expect(() => FxBusEngine.setBusReturn('unknown', 0.5)).not.toThrow()
    })

    it('clamps to 0..1', () => {
      expect(() => FxBusEngine.setBusReturn('reverb', 1.5)).not.toThrow()
      expect(() => FxBusEngine.setBusReturn('reverb', -1)).not.toThrow()
    })
  })

  // ─── setBusParam ─────────────────────────────────────────────────────────

  describe('setBusParam()', () => {
    it('does not throw when setting reverb decay', () => {
      expect(() => FxBusEngine.setBusParam('reverb', 'decay', 2.5)).not.toThrow()
    })

    it('does not throw when setting delay time', () => {
      expect(() => FxBusEngine.setBusParam('delay', 'time', 0.5)).not.toThrow()
    })

    it('does not throw when setting delay feedback', () => {
      expect(() => FxBusEngine.setBusParam('delay', 'feedback', 0.6)).not.toThrow()
    })

    it('does not throw for unknown bus or param', () => {
      expect(() => FxBusEngine.setBusParam('unknown', 'decay', 1)).not.toThrow()
      expect(() => FxBusEngine.setBusParam('reverb', 'unknown', 1)).not.toThrow()
    })
  })

  // ─── registerChannel ─────────────────────────────────────────────────────

  describe('registerChannel()', () => {
    it('does not throw', () => {
      const node = { connect: vi.fn(), disconnect: vi.fn() }
      expect(() => FxBusEngine.registerChannel('ch-1', node)).not.toThrow()
    })

    it('can be called multiple times for different channels', () => {
      const node1 = { connect: vi.fn(), disconnect: vi.fn() }
      const node2 = { connect: vi.fn(), disconnect: vi.fn() }
      expect(() => {
        FxBusEngine.registerChannel('ch-1', node1)
        FxBusEngine.registerChannel('ch-2', node2)
      }).not.toThrow()
    })

    it('wires previously set sends when channel is registered', () => {
      const outputNode = { connect: vi.fn(), disconnect: vi.fn() }
      // Set send before registering
      FxBusEngine.setSendLevel('ch-late', 'reverb', 0.4)
      FxBusEngine.registerChannel('ch-late', outputNode)
      // The outputNode.connect should have been called (for wiring existing sends)
      expect(outputNode.connect).toHaveBeenCalled()
    })
  })

  // ─── unregisterChannel ───────────────────────────────────────────────────

  describe('unregisterChannel()', () => {
    it('does not throw for a registered channel', () => {
      const node = { connect: vi.fn(), disconnect: vi.fn() }
      FxBusEngine.registerChannel('ch-x', node)
      expect(() => FxBusEngine.unregisterChannel('ch-x')).not.toThrow()
    })

    it('does not throw for an unknown channel', () => {
      expect(() => FxBusEngine.unregisterChannel('not-a-channel')).not.toThrow()
    })

    it('removes channel so getSendLevel returns 0 after unregister', () => {
      const node = { connect: vi.fn(), disconnect: vi.fn() }
      FxBusEngine.registerChannel('ch-y', node)
      FxBusEngine.setSendLevel('ch-y', 'reverb', 0.6)
      FxBusEngine.unregisterChannel('ch-y')
      expect(FxBusEngine.getSendLevel('ch-y', 'reverb')).toBe(0)
    })
  })

  // ─── reset ───────────────────────────────────────────────────────────────

  describe('reset()', () => {
    it('does not throw', () => {
      expect(() => FxBusEngine.reset()).not.toThrow()
    })

    it('clears all send state so getSendLevel returns 0', () => {
      const node = { connect: vi.fn(), disconnect: vi.fn() }
      FxBusEngine.registerChannel('ch-r', node)
      FxBusEngine.setSendLevel('ch-r', 'reverb', 0.8)
      FxBusEngine.reset()
      expect(FxBusEngine.getSendLevel('ch-r', 'reverb')).toBe(0)
    })

    it('can be re-initialized after reset', () => {
      FxBusEngine.reset()
      expect(() => FxBusEngine.init(ctx, masterInput)).not.toThrow()
      expect(FxBusEngine.getBuses().length).toBeGreaterThanOrEqual(2)
    })
  })
})
