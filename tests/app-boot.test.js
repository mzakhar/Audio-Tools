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

    it('● is unavailable outside arrange but focusable, with the reason', () => {
      document.querySelector('.tool-btn[data-tool="synth"]').click()
      expect(rec().disabled).toBe(false)
      expect(rec().getAttribute('aria-disabled')).toBe('true')
      expect(rec().getAttribute('aria-description')).toBe('MIDI recording works in Arrange')
      expect(rec().title).toBe('MIDI recording works in Arrange')
      rec().click()
      expect(rec().getAttribute('aria-pressed')).toBe('false')
      expect(document.getElementById('toast').textContent).toBe('MIDI RECORDING WORKS IN ARRANGE')
      expect(rec().getAttribute('aria-label')).toBe('Record MIDI')
      expect(document.getElementById('midi-record-btn')).toBeNull()
    })

    it('keyboard notes during a take become one clip in ONE Record MIDI batch; FM-1 record refuses meanwhile', async () => {
      const { default: ProjectStore } = await import('../src/renderer/js/store/ProjectStore.js')
      const { default: AudioEngine } = await import('../src/renderer/js/audio-engine.js')
      document.querySelector('.tool-btn[data-tool="arrange"]').click()
      expect(rec().getAttribute('aria-disabled')).toBe('false')
      expect(rec().hasAttribute('aria-description')).toBe(false)
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

    it('record-master is disabled with the reason where the recorder worklet is missing', () => {
      const item = document.querySelector('#app-menu [data-cmd="record-master"]')
      expect(item.hidden).toBe(false)
      expect(item.disabled).toBe(true)   // the fake context has no audioWorklet (the LAN http case)
      expect(item.textContent).toContain('Record master to WAV (needs HTTPS)')
    })

    it('record-master (⋯ menu) toggles the master Recorder; it shows while running and transport Stop leaves it', async () => {
      const { default: AudioEngine } = await import('../src/renderer/js/audio-engine.js')
      const { default: Recorder } = await import('../src/renderer/js/recorder.js')
      vi.spyOn(AudioEngine, 'hasRecorder').mockReturnValue(true)
      const start = vi.spyOn(Recorder, 'start').mockImplementation(() => {})
      const stop = vi.spyOn(Recorder, 'stop').mockResolvedValue('take.wav')
      document.querySelector('.tool-btn[data-tool="arrange"]').click()   // re-renders commands
      const item = document.querySelector('#app-menu [data-cmd="record-master"]')
      expect(item.disabled).toBe(false)
      expect(item.textContent).toContain('Record master to WAV…')
      item.click()
      await until(() => start.mock.calls.length > 0)
      expect(start).toHaveBeenCalledTimes(1)
      expect(item.textContent).toContain('Stop master recording')
      const timer = document.getElementById('rec-timer')
      expect(timer.hidden).toBe(false)
      expect(timer.textContent).toContain('REC')
      expect(timer.getAttribute('aria-live')).toBe('polite')
      const menuBtn = document.getElementById('app-menu-btn')
      expect(menuBtn.classList.contains('recording')).toBe(true)
      expect(menuBtn.getAttribute('aria-label')).toContain('master recording')
      document.getElementById('global-stop-btn').click()
      expect(stop).not.toHaveBeenCalled()
      item.click()
      await until(() => stop.mock.calls.length > 0)
      expect(stop).toHaveBeenCalledTimes(1)
      expect(item.textContent).toContain('Record master to WAV…')
      expect(document.getElementById('app-menu-btn').classList.contains('recording')).toBe(false)
      vi.restoreAllMocks()
      expect(errors).toEqual([])
    })

    it('offers the count-in preference in the ⋯ menu as a menuitemcheckbox, off by default', () => {
      const item = document.getElementById('count-in-toggle')
      expect(item.getAttribute('role')).toBe('menuitemcheckbox')
      expect(item.tagName).toBe('BUTTON')   // Space and Enter activate a button
      expect(item.getAttribute('aria-checked')).toBe('false')
      item.click()
      expect(item.getAttribute('aria-checked')).toBe('true')
      expect(localStorage.getItem('synth_count_in')).toBe('1')
      item.click()
      expect(item.getAttribute('aria-checked')).toBe('false')
      expect(localStorage.getItem('synth_count_in')).toBe('0')
    })

    it('PC keys play the piano in Arrange, not in Rack', () => {
      const heard = []
      const onNote = e => heard.push(e.detail.note)
      document.addEventListener('note-on', onNote)
      const press = key => { window.dispatchEvent(new KeyboardEvent('keydown', { key })); window.dispatchEvent(new KeyboardEvent('keyup', { key })) }
      document.querySelector('.tool-btn[data-tool="arrange"]').click()
      press('a')
      expect(heard).toHaveLength(1)
      document.querySelector('.tool-btn[data-tool="rack"]').click()
      press('a')
      expect(heard).toHaveLength(1)
      document.querySelector('.tool-btn[data-tool="arrange"]').click()
      document.removeEventListener('note-on', onNote)
      expect(errors).toEqual([])
    })

    const takeClips = ProjectStore => ProjectStore.getState().tracks.flatMap(track => track.clips).filter(clip => clip.name?.startsWith('Take '))
    const open = () => rec().getAttribute('aria-pressed') === 'true' && document.getElementById('global-play-btn').getAttribute('aria-pressed') === 'true'

    it('while a take is starting Play is ignored; Stop then ● again starts exactly one take', async () => {
      const { default: AudioEngine } = await import('../src/renderer/js/audio-engine.js')
      const { default: TimelinePlayer } = await import('../src/renderer/js/playback/timeline-player.js')
      document.querySelector('.tool-btn[data-tool="arrange"]').click()
      let release
      const gate = new Promise(done => { release = done })
      vi.spyOn(AudioEngine, 'init').mockImplementation(() => gate)
      const play = vi.spyOn(TimelinePlayer, 'play')
      rec().click()                       // start 1 waits in ensureAudio
      expect(rec().getAttribute('aria-pressed')).toBe('true')
      document.getElementById('global-play-btn').click()
      rec().click()                       // cancel start 1
      expect(rec().getAttribute('aria-pressed')).toBe('false')
      rec().click()                       // start 2 also waits
      release()
      await until(open)
      expect(open()).toBe(true)
      await new Promise(done => setTimeout(done, 20))
      expect(play).toHaveBeenCalledTimes(1)
      rec().click()
      expect(TimelinePlayer.isPlaying()).toBe(false)
      vi.restoreAllMocks()
      expect(errors).toEqual([])
    })

    it('tempo is locked while a take is open', async () => {
      const { default: ProjectStore } = await import('../src/renderer/js/store/ProjectStore.js')
      const bpmEl = document.getElementById('global-bpm')
      const before = ProjectStore.getState().bpm
      rec().click()
      await until(open)
      expect(open()).toBe(true)
      expect(bpmEl.disabled).toBe(true)
      bpmEl.value = String(before + 10)
      bpmEl.dispatchEvent(new Event('change'))
      expect(ProjectStore.getState().bpm).toBe(before)
      expect(bpmEl.value).toBe(String(before))
      expect(document.getElementById('toast').textContent).toBe('STOP RECORDING TO CHANGE TEMPO')
      rec().click()
      expect(bpmEl.disabled).toBe(false)
    })

    it('count-in: playback is anchored on the downbeat after the clicks; a note there lands on beat 0', async () => {
      const { default: ProjectStore } = await import('../src/renderer/js/store/ProjectStore.js')
      const { default: AudioEngine } = await import('../src/renderer/js/audio-engine.js')
      const { default: TimelinePlayer } = await import('../src/renderer/js/playback/timeline-player.js')
      const ctx = AudioEngine.getContext()
      ctx.currentTime = 10
      document.getElementById('count-in-toggle').click()   // on
      const before = takeClips(ProjectStore).length
      rec().click()
      await until(open)
      expect(open()).toBe(true)
      const bpm = ProjectStore.getState().bpm
      const downbeat = 10.05 + 4 * 60 / bpm
      expect(TimelinePlayer.startAudioTime).toBeCloseTo(downbeat, 9)
      ctx.currentTime = 10.5   // during the count-in: not recorded
      document.dispatchEvent(new CustomEvent('note-on', { detail: { note: 62 } }))
      document.dispatchEvent(new CustomEvent('note-off', { detail: { note: 62 } }))
      ctx.currentTime = downbeat
      document.dispatchEvent(new CustomEvent('note-on', { detail: { note: 60 } }))
      ctx.currentTime = downbeat + 0.25
      document.dispatchEvent(new CustomEvent('note-off', { detail: { note: 60 } }))
      rec().click()
      document.getElementById('count-in-toggle').click()   // off again
      const clips = takeClips(ProjectStore)
      expect(clips).toHaveLength(before + 1)
      const notes = clips.at(-1).notes
      expect(notes.map(note => note.pitch)).toEqual([60])
      expect(notes[0].startBeat).toBeLessThan(0.02)   // + the 6 ms MIDI slack
      expect(errors).toEqual([])
    })

    it('● while playing restarts from the top and says so', async () => {
      document.getElementById('global-play-btn').click()
      await until(() => document.getElementById('global-play-btn').getAttribute('aria-pressed') === 'true')
      try {
        rec().click()
        await until(() => document.getElementById('toast').textContent === 'Recording from the start')
        expect(document.getElementById('toast').textContent).toBe('Recording from the start')
        await until(open)
        expect(open()).toBe(true)
      } finally { rec().click() }
      expect(rec().getAttribute('aria-pressed')).toBe('false')
    })

    it('a take whose track was deleted meanwhile adds nothing and says so', async () => {
      const { default: ProjectStore, RemoveTrack } = await import('../src/renderer/js/store/ProjectStore.js')
      const { default: AudioEngine } = await import('../src/renderer/js/audio-engine.js')
      const ctx = AudioEngine.getContext()
      rec().click()
      await until(open)
      expect(open()).toBe(true)
      const before = takeClips(ProjectStore).length
      ctx.currentTime += 0.5
      document.dispatchEvent(new CustomEvent('note-on', { detail: { note: 64 } }))
      ctx.currentTime += 0.5
      document.dispatchEvent(new CustomEvent('note-off', { detail: { note: 64 } }))
      for (const track of ProjectStore.getState().tracks.filter(track => track.type === 'midi')) ProjectStore.dispatch(RemoveTrack(track.id))
      rec().click()
      expect(document.getElementById('toast').textContent).toBe('NOTHING RECORDED')
      expect(takeClips(ProjectStore).length).toBeLessThanOrEqual(before)
    })

    it('playback stopping by itself commits the open take', async () => {
      const { default: ProjectStore } = await import('../src/renderer/js/store/ProjectStore.js')
      const { default: AudioEngine } = await import('../src/renderer/js/audio-engine.js')
      const { default: TimelinePlayer } = await import('../src/renderer/js/playback/timeline-player.js')
      const ctx = AudioEngine.getContext()
      rec().click()
      await until(open)
      expect(open()).toBe(true)
      const before = takeClips(ProjectStore).length
      ctx.currentTime += 0.5
      document.dispatchEvent(new CustomEvent('note-on', { detail: { note: 65 } }))
      ctx.currentTime += 0.5
      document.dispatchEvent(new CustomEvent('note-off', { detail: { note: 65 } }))
      expect(TimelinePlayer.isPlaying()).toBe(true)
      TimelinePlayer.stop()
      expect(rec().getAttribute('aria-pressed')).toBe('false')
      expect(takeClips(ProjectStore)).toHaveLength(before + 1)
      expect(document.getElementById('toast').textContent).toBe('TAKE RECORDED')
      expect(errors).toEqual([])
    })
  })
})
