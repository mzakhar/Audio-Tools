/**
 * Regression: AudioEngine.init() must build the master chain even when
 * ctx.audioWorklet is missing (plain-http / non-secure-context deploys).
 * Previously it assigned _ctx before awaiting addModule, so the throw left a
 * live context with a null masterGain — every voice then connected to null
 * (no sound) and the sequencer's scheduler died on the first note.
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('../src/renderer/js/worklets/recorder-processor.js?url', () => ({ default: 'blob:fake' }))

const stubNode = () => ({
  gain: { value: 0, setTargetAtTime: vi.fn() },
  buffer: null,
  threshold: { value: 0 }, knee: { value: 0 }, ratio: { value: 0 },
  attack: { value: 0 }, release: { value: 0 },
  connect: vi.fn(), disconnect: vi.fn()
})

function fakeCtx({ worklet }) {
  return {
    sampleRate: 44100,
    currentTime: 0,
    state: 'running',
    destination: stubNode(),
    audioWorklet: worklet,
    createGain: stubNode,
    createConvolver: stubNode,
    createDynamicsCompressor: stubNode,
    createBuffer: (ch, len) => ({ getChannelData: () => new Float32Array(len) })
  }
}

async function freshEngine(worklet) {
  vi.resetModules()
  window.AudioContext = function () { return fakeCtx({ worklet }) }
  return (await import('../src/renderer/js/audio-engine.js')).default
}

describe('AudioEngine.init', () => {
  it('builds the master chain without an audioWorklet', async () => {
    const engine = await freshEngine(undefined)
    await engine.init()
    expect(engine.getMasterInput()).toBeTruthy()
    expect(engine.getCompressor()).toBeTruthy()
    expect(engine.hasRecorder()).toBe(false)
  })

  it('reports the recorder available when addModule succeeds', async () => {
    const engine = await freshEngine({ addModule: vi.fn(async () => {}) })
    await engine.init()
    expect(engine.getMasterInput()).toBeTruthy()
    expect(engine.hasRecorder()).toBe(true)
  })
})
