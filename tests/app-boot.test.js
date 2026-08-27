/**
 * Boot smoke test. app.js was never exercised by the suite, so the shell rewrite
 * could ship a crash on load and every other test would stay green.
 * Stubs only what the browser provides: audio, MIDI, dialogs, the Electron bridge.
 */
// @vitest-environment jsdom
import { describe, expect, it, beforeAll, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

function stubAudioParam(value = 0) {
  return {
    value,
    setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn(),
    setTargetAtTime: vi.fn(), cancelScheduledValues: vi.fn(), setValueCurveAtTime: vi.fn()
  }
}

function stubNode(extra = {}) {
  return {
    connect: vi.fn(), disconnect: vi.fn(), start: vi.fn(), stop: vi.fn(),
    gain: stubAudioParam(1), frequency: stubAudioParam(440), detune: stubAudioParam(0),
    offset: stubAudioParam(0), Q: stubAudioParam(1), pan: stubAudioParam(0),
    playbackRate: stubAudioParam(1), threshold: stubAudioParam(-24), knee: stubAudioParam(30),
    ratio: stubAudioParam(12), attack: stubAudioParam(0), release: stubAudioParam(0),
    type: 'sine', buffer: null, loop: false, fftSize: 256,
    getFloatTimeDomainData: vi.fn(), getByteFrequencyData: vi.fn(),
    ...extra
  }
}

class FakeAudioContext {
  constructor() {
    this.currentTime = 0
    this.sampleRate = 48000
    this.state = 'running'
    this.destination = stubNode()
    this.audioWorklet = undefined // plain-http parity: no worklet
    this.listener = {}
  }
  createGain() { return stubNode() }
  createOscillator() { return stubNode() }
  createBiquadFilter() { return stubNode() }
  createDynamicsCompressor() { return stubNode() }
  createConvolver() { return stubNode() }
  createDelay() { return stubNode() }
  createWaveShaper() { return stubNode() }
  createStereoPanner() { return stubNode() }
  createAnalyser() { return stubNode() }
  createBufferSource() { return stubNode() }
  createConstantSource() { return stubNode() }
  createChannelMerger() { return stubNode() }
  createChannelSplitter() { return stubNode() }
  createScriptProcessor() { return stubNode() }
  createPeriodicWave() { return {} }
  createBuffer() { return { duration: 1, length: 48000, sampleRate: 48000, numberOfChannels: 2, getChannelData: () => new Float32Array(48000) } }
  decodeAudioData() { return Promise.resolve(this.createBuffer()) }
  resume() { return Promise.resolve() }
  suspend() { return Promise.resolve() }
  close() { return Promise.resolve() }
}

describe('app boots', () => {
  const errors = []

  beforeAll(async () => {
    document.documentElement.innerHTML = readFileSync(resolve(process.cwd(), 'src/renderer/index.html'), 'utf8')
    window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
    // jsdom ships no canvas backend; every drawing call is a no-op here.
    HTMLCanvasElement.prototype.getContext = () => new Proxy({}, {
      get: (target, key) => key in target ? target[key]
        : (target[key] = key === 'canvas' ? null
          : ['measureText'].includes(key) ? (() => ({ width: 0 }))
          : ['createLinearGradient', 'createPattern'].includes(key) ? (() => ({ addColorStop() {} }))
          : (() => {}))
    })
    window.AudioContext = FakeAudioContext
    window.webkitAudioContext = FakeAudioContext
    window.OfflineAudioContext = FakeAudioContext
    window.matchMedia = window.matchMedia || (query => ({ matches: false, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn() }))
    navigator.requestMIDIAccess = undefined
    window.electronFS = undefined
    // jsdom has no dialog behaviour; the dialog kit only needs these to exist.
    for (const dialog of document.querySelectorAll('dialog')) {
      dialog.showModal = function () { this.open = true }
      dialog.close = function () { this.open = false; this.dispatchEvent(new Event('close')) }
    }
    window.addEventListener('error', event => errors.push(event.error || event.message))
    const onError = console.error
    console.error = (...args) => { errors.push(args.join(' ')); onError(...args) }

    await import('../src/renderer/js/app.js')
    document.dispatchEvent(new Event('DOMContentLoaded'))
    await new Promise(done => setTimeout(done, 50))
  })

  it('renders the command bar without throwing', () => {
    expect(errors).toEqual([])
    expect(document.querySelector('#command-bar [data-cmd="play"]')).not.toBeNull()
    expect(document.querySelector('#app-menu').children.length).toBeGreaterThan(0)
  })

  it('renders the synth view: instrument slot, pads, keys', () => {
    expect(document.querySelector('#keyboard').children.length).toBeGreaterThan(0)
    expect(document.querySelectorAll('.drum-pad, .pad').length).toBeGreaterThanOrEqual(8)
  })

  it('switches views by attribute, not inline display', () => {
    for (const view of ['arrange', 'rack', 'tr909', 'synth']) {
      document.querySelector(`.tool-btn[data-tool="${view}"]`).click()
      expect(document.getElementById('main').dataset.view).toBe(view)
    }
    expect(errors).toEqual([])
  })
})
