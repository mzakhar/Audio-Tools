import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock AudioEngine
vi.mock('../src/renderer/js/audio-engine.js', () => ({
  default: {
    getContext: vi.fn(() => ({
      decodeAudioData: vi.fn(async (ab) => ({
        numberOfChannels: 2,
        sampleRate: 44100,
        length: 1024,
        getChannelData: vi.fn(() => new Float32Array(1024))
      })),
      currentTime: 0
    })),
    init: vi.fn()
  }
}))

// Mock FileAdapter
vi.mock('../src/renderer/js/io/FileAdapter.js', () => ({
  default: {
    importAudio: vi.fn(async (fileHandle, dirHandle) => 'audio/test.wav'),
    readProject: vi.fn(),
    writeProject: vi.fn()
  }
}))

// Mock Worker (jsdom doesn't have Worker)
vi.stubGlobal('Worker', class {
  constructor() {}
  postMessage() {}
  terminate() {}
  set onmessage(fn) {}
  set onerror(fn) {}
})

import AudioStore from '../src/renderer/js/audio-store.js'

beforeEach(() => {
  AudioStore.reset()
})

describe('AudioStore project dir', () => {
  it('getProjectDir returns null initially', () => {
    expect(AudioStore.getProjectDir()).toBeNull()
  })

  it('setProjectDir / getProjectDir round-trip', () => {
    const mockHandle = { kind: 'directory' }
    AudioStore.setProjectDir(mockHandle)
    expect(AudioStore.getProjectDir()).toBe(mockHandle)
  })
})

describe('AudioStore buffer access before load', () => {
  it('getBuffer returns null for unknown key', () => {
    expect(AudioStore.getBuffer('audio/foo.wav')).toBeNull()
  })

  it('getLod returns null for unknown key', () => {
    expect(AudioStore.getLod('audio/foo.wav', 64)).toBeNull()
  })

  it('isLodReady returns false before load', () => {
    expect(AudioStore.isLodReady('audio/foo.wav')).toBe(false)
  })
})

describe('AudioStore importFile', () => {
  it('throws if no project dir set', async () => {
    const mockHandle = { getFile: async () => ({}) }
    await expect(AudioStore.importFile(mockHandle)).rejects.toThrow('No project open')
  })
})

describe('AudioStore unload', () => {
  it('unloadBuffer removes the key', async () => {
    AudioStore.setProjectDir({ kind: 'directory' })
    // Manually inject a buffer to test unload
    AudioStore._buffers?.set('audio/test.wav', {}) // access private for testing if needed
    AudioStore.unloadBuffer('audio/test.wav')
    expect(AudioStore.getBuffer('audio/test.wav')).toBeNull()
  })
})
