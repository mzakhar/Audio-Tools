import { describe, it, expect, vi } from 'vitest'
import Palettes from '../src/renderer/js/palettes.js'

// Minimal fake BaseAudioContext covering every node the melodic palettes build.
function makeCtx() {
  const param = () => ({
    value: 0,
    setValueAtTime: vi.fn(),
    linearRampToValueAtTime: vi.fn(),
    cancelScheduledValues: vi.fn()
  })
  const node = extra => ({ connect: vi.fn(), disconnect: vi.fn(), ...extra })
  const source = extra => node({ start: vi.fn(), stop: vi.fn(), onended: null, ...extra })
  return {
    currentTime: 0,
    sampleRate: 44100,
    createGain: () => node({ gain: param() }),
    createBiquadFilter: () => node({ type: 'lowpass', frequency: param(), Q: param() }),
    createOscillator: () => source({ type: 'sine', frequency: param(), detune: param() }),
    createBuffer: (ch, len) => ({ numberOfChannels: ch, length: len, getChannelData: () => new Float32Array(len) }),
    createBufferSource: () => source({ buffer: null, playbackRate: param() })
  }
}

describe.each(['classic', 'fm', 'pad'])('%s palette createVoice', key => {
  it('returns callable stop/setBend/setMod and they do not throw', () => {
    const ctx = makeCtx()
    const output = ctx.createGain()
    const voice = Palettes[key].createVoice(ctx, output, 440, 1, 0)
    expect(typeof voice.stop).toBe('function')
    expect(typeof voice.setBend).toBe('function')
    expect(typeof voice.setMod).toBe('function')
    expect(() => voice.setBend(2)).not.toThrow()
    expect(() => voice.setMod(0.5)).not.toThrow()
    expect(() => voice.stop(0)).not.toThrow()
  })
})
