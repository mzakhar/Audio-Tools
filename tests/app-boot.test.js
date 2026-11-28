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
  const pagehide = []

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

    const addListener = window.addEventListener.bind(window)
    window.addEventListener = (type, ...rest) => { if (type === 'pagehide') pagehide.push(rest[0]); return addListener(type, ...rest) }
    await import('../src/renderer/js/app.js')
    window.addEventListener = addListener
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
    for (const view of ['arrange', 'rack', 'tr909', 'pads', 'synth']) {
      document.querySelector(`.tool-btn[data-tool="${view}"]`).click()
      expect(document.getElementById('main').dataset.view).toBe(view)
    }
    expect(errors).toEqual([])
  })

  it('ends every FM-1 device when the page goes away (pagehide)', () => {
    expect(pagehide).toHaveLength(1)
    expect(() => window.dispatchEvent(new Event('pagehide'))).not.toThrow()
    expect(errors).toEqual([])
  })

  it('F5 opens the pads view', () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'F5' }))
    expect(document.getElementById('main').dataset.view).toBe('pads')
    expect(document.querySelectorAll('#pads-view .pads-pad')).toHaveLength(16)
    document.querySelector('.tool-btn[data-tool="synth"]').click()
    expect(errors).toEqual([])
  })

  describe('Arrange MIDI recording', () => {
    const until = async cond => { for (let i = 0; i < 200 && !cond(); i++) await new Promise(done => setTimeout(done, 5)) }
    const rec = () => document.getElementById('rec-btn')

    it('● is disabled outside arrange, with the reason', () => {
      document.querySelector('.tool-btn[data-tool="synth"]').click()
      expect(rec().disabled).toBe(true)
      expect(rec().title).toBe('MIDI recording works in Arrange')
      expect(rec().getAttribute('aria-label')).toBe('Record MIDI')
      expect(document.getElementById('midi-record-btn')).toBeNull()
    })

    it('keyboard notes during a take become one clip in ONE Record MIDI batch; FM-1 record refuses meanwhile', async () => {
      const { default: ProjectStore } = await import('../src/renderer/js/store/ProjectStore.js')
      const { default: AudioEngine } = await import('../src/renderer/js/audio-engine.js')
      document.querySelector('.tool-btn[data-tool="arrange"]').click()
      expect(rec().disabled).toBe(false)
      const batch = vi.spyOn(ProjectStore, 'dispatchBatch')
      rec().click()
      await until(() => rec().getAttribute('aria-pressed') === 'true' && document.getElementById('global-play-btn').getAttribute('aria-pressed') === 'true')
      expect(rec().getAttribute('aria-pressed')).toBe('true')

      const ctx = AudioEngine.getContext()
      ctx.currentTime = 1
      document.dispatchEvent(new CustomEvent('note-on', { detail: { note: 60 } }))
      ctx.currentTime = 1.5
      document.dispatchEvent(new CustomEvent('note-off', { detail: { note: 60 } }))

      // Only one recording owns the transport.
      const fm1 = document.querySelector('#app-menu [data-cmd="fm1-record"]')
      fm1.disabled = false
      fm1.click()
      await until(() => document.getElementById('toast').textContent === 'STOP MIDI RECORDING FIRST')
      expect(document.getElementById('toast').textContent).toBe('STOP MIDI RECORDING FIRST')

      ctx.currentTime = 2
      rec().click()
      expect(rec().getAttribute('aria-pressed')).toBe('false')
      expect(batch).toHaveBeenCalledTimes(1)
      const [commands, label] = batch.mock.calls[0]
      expect(label).toBe('Record MIDI')
      expect(commands).toHaveLength(1)
      const clips = ProjectStore.getState().tracks.flatMap(track => track.clips).filter(clip => clip.name?.startsWith('Take '))
      expect(clips).toHaveLength(1)
      expect(clips[0]).toMatchObject({ type: 'midi', startBeat: 0, duration: 4 })
      expect(clips[0].notes).toHaveLength(1)
      expect(clips[0].notes[0].pitch).toBe(60)
      batch.mockRestore()
      expect(errors).toEqual([])
    })

    it('record-master (⋯ menu) toggles the master Recorder and its label', async () => {
      const { default: AudioEngine } = await import('../src/renderer/js/audio-engine.js')
      const { default: Recorder } = await import('../src/renderer/js/recorder.js')
      vi.spyOn(AudioEngine, 'hasRecorder').mockReturnValue(true)
      const start = vi.spyOn(Recorder, 'start').mockImplementation(() => {})
      const stop = vi.spyOn(Recorder, 'stop').mockResolvedValue('take.wav')
      const item = document.querySelector('#app-menu [data-cmd="record-master"]')
      expect(item.textContent).toContain('Record master to WAV…')
      item.click()
      await until(() => start.mock.calls.length > 0)
      expect(start).toHaveBeenCalledTimes(1)
      expect(item.textContent).toContain('Stop master recording')
      expect(document.getElementById('rec-timer').hidden).toBe(false)
      item.click()
      await until(() => stop.mock.calls.length > 0)
      expect(stop).toHaveBeenCalledTimes(1)
      expect(item.textContent).toContain('Record master to WAV…')
      vi.restoreAllMocks()
      expect(errors).toEqual([])
    })

    it('offers the count-in preference in the ⋯ menu, off by default', () => {
      const box = document.getElementById('count-in-toggle')
      expect(box.checked).toBe(false)
      box.click()
      expect(localStorage.getItem('synth_count_in')).toBe('1')
      box.click()
      expect(localStorage.getItem('synth_count_in')).toBe('0')
    })
  })
})
