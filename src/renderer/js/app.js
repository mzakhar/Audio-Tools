/**
 * app.js
 * Entry point. Wires AudioEngine, Palettes, Keyboard, and Sequencer together.
 * Handles palette switching, knob panel, and transport controls.
 */
import AudioEngine from './audio-engine.js'
import Palettes from './palettes.js'
import Keyboard from './keyboard.js'
import Sequencer from './sequencer.js'
import Recorder from './recorder.js'
import ProjectStore, { AddTrack, AddClip, SetMixerParam, SetBpm, RemoveTrack, SetTrackInstrumentProgram } from './store/ProjectStore.js'
import RackEngine from './rack/rack-engine.js'
import { routeChannel } from './midi/midi-routing.js'
import { liveInstrumentFor } from './midi/live-instrument.js'
import FileAdapter from './io/FileAdapter.js'
import { pickAudioFile } from './io/audio-picker.js'
import AudioStore from './audio-store.js'
import { ArrangementView } from './components/arrangement-view.js'
import { MixerStrip } from './components/mixer-strip.js'
import MixerEngine from './audio/mixer-engine.js'
import TimelinePlayer from './playback/timeline-player.js'
import MidiController from './midi/MidiController.js'
import { PianoRoll } from './components/piano-roll.js'
import { Tr909View } from './components/tr909-view.js'
import { RackView } from './components/rack-view.js'
import { InstrumentInspector } from './components/instrument-inspector.js'
import ShortcutManager from './shortcuts.js'
import { applyTheme, savedTheme } from './theme.js'
import { applyChannelMidi } from './instruments/channel-program.js'
import { compilePackManifest, resolvePatch } from './instruments/pack-registry.js'
import { createSampleStore } from './instruments/sample-store.js'

// ─── Per-type directory memory ────────────────────────────────────────────────
const DIR_KEY_PROJECT = 'synth_lastProjectDir'
const DIR_KEY_AUDIO   = 'synth_lastAudioDir'
function getLastDir(key)       { return localStorage.getItem(key) || undefined }
function setLastDir(key, path) { if (path) localStorage.setItem(key, path) }

let currentPaletteKey = 'classic'
let currentPalette = Palettes.classic
const activeVoices = {} // midi note → voice object
const _liveInstruments = new Map() // trackId → { sig, inst }
let _packCatalog = []
let _channelPrograms = null
const _sampleStores = new WeakMap()

function packFor(packId, version) {
  return _packCatalog.find(pack => pack.id === packId && pack.version === version) || null
}

function sampleStoreFor(pack, ctx) {
  if (!window.electronFS?.readInstrumentSample) return null
  let stores = _sampleStores.get(ctx)
  if (!stores) _sampleStores.set(ctx, stores = new Map())
  const key = `${pack.id}@${pack.version}`
  if (!stores.has(key)) stores.set(key, createSampleStore({ ctx, load: sampleId => window.electronFS.readInstrumentSample(pack.id, pack.version, sampleId) }))
  return stores.get(key)
}

async function auditionTrack(track) {
  await ensureAudio()
  const ctx = AudioEngine.getContext()
  if (!track || !ctx) return
  const output = MixerEngine.getOutput(track.mixerChannelId) || AudioEngine.getMasterInput()
  const instrument = liveInstrumentFor(track, { palettes: Palettes, ctx, output, racks: ProjectStore.getState().racks, packFor, sampleStoreFor, mountRack: rack => RackEngine.mount(ctx, rack, { output }) })
  if (!instrument) throw new Error('Selected instrument is unavailable')
  // Audition must stay lazy: a preset may reference hundreds of samples.
  await instrument.preload?.(60, 100)
  instrument.noteOn(60, 100)
  setTimeout(() => { instrument.noteOff(60); instrument.dispose() }, 600)
}

async function refreshPackCatalog() {
  if (!window.electronFS?.listInstrumentPacks) return
  _packCatalog = (await window.electronFS.listInstrumentPacks()).map(entry => compilePackManifest(entry.manifest))
  _arrangementView?.render()
  _instrumentInspector?.render()
}

/** Tear down every live MIDI instrument — the old project's tracks are gone. */
function disposeLiveInstruments() {
  for (const entry of _liveInstruments.values()) {
    try { entry.inst.dispose() } catch (err) {}
  }
  _liveInstruments.clear()
}

let _arrangementView = null
let _pianoRoll = null
let _tr909View = null
let _rackView = null
let _instrumentInspector = null
let _mixerStrips = new Map()  // channelId → MixerStrip
let _currentMode = 'synth'    // 'synth' | 'arrange' | 'rack'
let _selectedArrangeTrackId = null
let _rafId = null
let _midiRecording = false
let _midiTargetTrackId = null  // track to write recorded MIDI into
let _midiTargetClipId = null

const DRUM_DEFS = [
  { label: 'KICK',   key: '1', color: '#ff4444' },
  { label: 'SNARE',  key: '2', color: '#ffaa00' },
  { label: 'HI-HAT', key: '3', color: '#39ff14' },
  { label: 'CLAP',   key: '4', color: '#ff00aa' },
]
const drumPadEls = [] // indexed by drumIndex

// ─── Audio init on first gesture ──────────────────────────────────────────
async function ensureAudio() {
  await AudioEngine.init()
}

// ─── Palette switching ─────────────────────────────────────────────────────
function switchPalette(key) {
  if (key !== 'tr909') _tr909View?.stop()

  // Stop any held notes
  Object.keys(activeVoices).forEach(note => {
    try { activeVoices[note].stop(AudioEngine.getContext()?.currentTime || 0) } catch (e) {}
    delete activeVoices[note]
  })
  document.querySelectorAll('.key-white.active, .key-black.active')
    .forEach(el => el.classList.remove('active'))

  currentPaletteKey = key
  currentPalette = Palettes[key]
  renderKnobPanel()

  // Apply this palette's default reverb
  if (AudioEngine.getContext()) {
    AudioEngine.setReverb(currentPalette.params.reverb || 0.2)
  }

  document.querySelectorAll('.tab').forEach(t => {
    const isActive = t.dataset.palette === key
    t.classList.toggle('active', isActive)
    t.setAttribute('aria-selected', isActive ? 'true' : 'false')
  })

  const isDrum = key === 'drum'
  const is909 = key === 'tr909'
  document.getElementById('knob-panel').style.display = is909 ? 'none' : ''
  document.getElementById('keyboard-section').style.display = is909 ? 'none' : ''
  document.getElementById('sequencer-section').style.display = is909 ? 'none' : ''
  document.getElementById('tr909-view').style.display = is909 ? 'block' : 'none'
  document.getElementById('keyboard-wrap').style.display = isDrum ? 'none' : ''
  document.getElementById('keyboard-hint').style.display = isDrum ? 'none' : ''
  document.getElementById('drum-pads').style.display    = isDrum ? 'flex' : 'none'
  document.getElementById('drum-hint').style.display    = isDrum ? '' : 'none'

  updateGlobalPlayAvailability()
}

// The 909 has its own Bar/Chain transport, so the shared Play is meaningless
// while it is on screen. Derived from both mode and palette and called from
// both switches — keying it off the palette alone left Play stuck disabled
// after leaving the 909 for arrange or rack, which never re-run switchPalette.
function updateGlobalPlayAvailability() {
  const btn = document.getElementById('global-play-btn')
  if (!btn) return
  const on909 = _currentMode === 'synth' && currentPaletteKey === 'tr909'
  btn.disabled = on909
  btn.title = on909 ? '909 uses its own Bar/Chain transport' : ''
}

// ─── Drum pads ─────────────────────────────────────────────────────────────
function triggerDrumPad(drumIndex) {
  ensureAudio()
  const ctx = AudioEngine.getContext()
  if (!ctx) return
  Palettes.drum.createDrumVoice(ctx, AudioEngine.getMasterInput(), drumIndex, 0.9, ctx.currentTime)

  const pad = drumPadEls[drumIndex]
  if (!pad) return
  pad.classList.add('active')
  setTimeout(() => pad.classList.remove('active'), 120)
}

function renderDrumPads() {
  const container = document.getElementById('drum-pads')
  if (!container) return
  container.style.display = 'none' // hidden until drum tab selected

  DRUM_DEFS.forEach((def, i) => {
    const pad = document.createElement('div')
    pad.className = 'drum-pad'
    pad.style.setProperty('--pad-color', def.color)

    const label = document.createElement('div')
    label.className = 'drum-pad-label'
    label.textContent = def.label

    const kbd = document.createElement('div')
    kbd.className = 'drum-pad-key'
    kbd.textContent = def.key

    pad.appendChild(label)
    pad.appendChild(kbd)

    pad.addEventListener('mousedown', (e) => { e.preventDefault(); triggerDrumPad(i) })
    pad.addEventListener('touchstart', (e) => { e.preventDefault(); triggerDrumPad(i) }, { passive: false })

    container.appendChild(pad)
    drumPadEls[i] = pad
  })
}

// PC keyboard 1–4 for drum pads (kept outside ShortcutManager to preserve
// synth-mode context without conflicting with note-playing keyboard shortcuts)
document.addEventListener('keydown', (e) => {
  if (currentPaletteKey !== 'drum') return
  if (_currentMode !== 'synth') return
  if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return
  const tag = document.activeElement?.tagName
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return
  const idx = ['1','2','3','4'].indexOf(e.key)
  if (idx !== -1) triggerDrumPad(idx)
})

document.addEventListener('keydown', (e) => {
  if (currentPaletteKey !== 'tr909') return
  if (_currentMode !== 'synth') return
  if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return
  const tag = document.activeElement?.tagName
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return
  const idx = ['1','2','3','4','5','6','7','8','9','0','-'].indexOf(e.key)
  if (idx === -1) return
  const inst = ['bd','sd','lt','mt','ht','rs','cp','ch','oh','cr','rd'][idx]
  _tr909View?.trigger(inst, 0.9)
})

// ─── Knob panel ────────────────────────────────────────────────────────────
function renderKnobPanel() {
  const panel = document.getElementById('knob-panel')
  if (!panel) return
  panel.innerHTML = ''

  const p = currentPalette

  // Selectors (waveform picker etc.)
  if (p.selectors && p.selectors.length) {
    p.selectors.forEach(def => {
      const group = document.createElement('div')
      group.className = 'knob-select-group'

      const lbl = document.createElement('label')
      lbl.className = 'knob-label'
      lbl.textContent = def.label

      const sel = document.createElement('select')
      sel.className = 'knob-select'
      def.options.forEach(opt => {
        const o = document.createElement('option')
        o.value = opt
        o.textContent = opt.toUpperCase()
        if (p.params[def.key] === opt) o.selected = true
        sel.appendChild(o)
      })
      sel.addEventListener('change', () => {
        p.params[def.key] = sel.value
      })

      group.appendChild(lbl)
      group.appendChild(sel)
      panel.appendChild(group)
      addDivider(panel)
    })
  }

  // Knobs (range sliders)
  p.knobs.forEach((def, i) => {
    const group = document.createElement('div')
    group.className = 'knob-group'

    const knobId = `knob-${currentPaletteKey}-${def.key}`
    const lbl = document.createElement('label')
    lbl.className = 'knob-label'
    lbl.textContent = def.label
    lbl.setAttribute('for', knobId)

    const rawVal = p.params[def.key]
    const slider = document.createElement('input')
    slider.type = 'range'
    slider.id = knobId
    slider.className = 'filled'
    slider.min = def.min
    slider.max = def.max
    slider.step = def.step
    slider.value = rawVal

    const valSpan = document.createElement('span')
    valSpan.className = 'knob-val'

    function formatVal(v) {
      const fmt = def.fmt || ''
      if (fmt === 's') return parseFloat(v).toFixed(2) + 's'
      if (fmt === 'Hz') return v >= 1000 ? (v/1000).toFixed(1) + 'k' : Math.round(v) + ''
      if (fmt === 'c') return Math.round(v) + 'c'
      return parseFloat(v).toFixed(2)
    }

    function updateFill() {
      const pct = (slider.value - slider.min) / (slider.max - slider.min) * 100
      slider.style.setProperty('--fill', pct + '%')
      valSpan.textContent = formatVal(slider.value)
    }

    slider.addEventListener('input', () => {
      const v = parseFloat(slider.value)
      p.params[def.key] = v
      updateFill()

      if (def.key === 'reverb') {
        AudioEngine.setReverb(v)
      }
    })

    updateFill()
    group.appendChild(lbl)
    group.appendChild(slider)
    group.appendChild(valSpan)
    panel.appendChild(group)

    // Divider after every knob except last
    if (i < p.knobs.length - 1) addDivider(panel)
  })
}

function addDivider(panel) {
  const div = document.createElement('div')
  div.className = 'knob-divider'
  panel.appendChild(div)
}

// ─── Global header: BPM, master volume, transport ──────────────────────────
function initGlobalHeader() {
  // Master volume
  const volSlider = document.getElementById('master-vol')
  const volDisp   = document.getElementById('master-vol-display')
  if (volSlider) {
    function updateVol() {
      const v = parseFloat(volSlider.value)
      const pct = v * 100
      volSlider.style.setProperty('--fill', pct + '%')
      volSlider.classList.add('filled')
      if (volDisp) volDisp.textContent = Math.round(pct)
      AudioEngine.setMasterVolume(v)
    }
    volSlider.addEventListener('input', updateVol)
    updateVol()
  }

  // BPM
  const bpmEl = document.getElementById('global-bpm')
  bpmEl?.addEventListener('change', (e) => {
    const bpm = parseInt(e.target.value) || 120
    ProjectStore.dispatch(SetBpm(bpm))
  })
  // Store is the source of truth; push into Sequencer's copy and keep the
  // input in sync (e.g. after project open).
  ProjectStore.subscribe(() => {
    const bpm = ProjectStore.getState().bpm
    if (bpmEl) bpmEl.value = bpm
    Sequencer.setBPM(bpm)
  })

  // Transport — mode-aware: drives Sequencer in synth mode, TimelinePlayer in arrange mode
  document.getElementById('global-play-btn')?.addEventListener('click', () => {
    ensureAudio()
    if (_currentMode === 'arrange') {
      const state = ProjectStore.getState()
      TimelinePlayer.play({
        beat: 0,
        bpm: state.bpm,
        tracks: state.tracks,
        audioStore: AudioStore,
        mixerEngine: MixerEngine,
        palettes: Palettes,
        racks: ProjectStore.getState().racks,
        packFor,
        sampleStoreFor,
        rackHandles: [_rackView?.getEngineHandle()].filter(Boolean)
      })
    } else {
      Sequencer.play()
    }
  })
  document.getElementById('global-stop-btn')?.addEventListener('click', () => {
    if (_currentMode === 'arrange') {
      TimelinePlayer.stop()
    } else {
      Sequencer.stop()
    }
  })
}

// ─── Note events (from Keyboard) ───────────────────────────────────────────
document.addEventListener('note-on', (e) => {
  ensureAudio()
  const ctx = AudioEngine.getContext()
  if (!ctx) return
  const note = e.detail.note
  if (activeVoices[note]) return

  const freq = 440 * Math.pow(2, (note - 69) / 12)
  try {
    const voice = currentPalette.createVoice(ctx, AudioEngine.getMasterInput(), freq, 0.85, ctx.currentTime)
    activeVoices[note] = voice
  } catch (err) { console.error('createVoice error', err) }
})

document.addEventListener('note-off', (e) => {
  const note = e.detail.note
  if (activeVoices[note]) {
    const ctx = AudioEngine.getContext()
    try { activeVoices[note].stop(ctx ? ctx.currentTime : 0) } catch (err) {}
    delete activeVoices[note]
  }
})

// ─── Transport buttons ──────────────────────────────────────────────────────
function initTransport() {
  document.getElementById('clear-btn')?.addEventListener('click', () => {
    Sequencer.clear()
  })
  document.getElementById('add-track-btn')?.addEventListener('click', () => {
    ensureAudio()
    Sequencer.addTrack()
  })
}

// ─── Palette tabs ───────────────────────────────────────────────────────────
function initTabs() {
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      ensureAudio()
      switchPalette(tab.dataset.palette)
    })
  })
}

// ─── Recorder ───────────────────────────────────────────────────────────────
function pad(n) { return String(n).padStart(2, '0') }

function initRecorder() {
  const btn    = document.getElementById('rec-btn')
  const timer  = document.getElementById('rec-timer')
  const status = document.getElementById('rec-status')
  if (!btn) return

  let recording = false, interval = null, elapsed = 0

  btn.addEventListener('click', async () => {
    await ensureAudio()
    if (!recording) {
      if (!AudioEngine.hasRecorder()) {
        status.textContent = 'REC NEEDS HTTPS'
        return
      }
      recording = true
      elapsed = 0
      btn.textContent = '■ STOP & SAVE'
      btn.classList.add('recording')
      btn.setAttribute('aria-pressed', 'true')
      status.textContent = '● RECORDING'
      Recorder.start(AudioEngine.getContext(), AudioEngine.getCompressor())
      interval = setInterval(() => {
        elapsed++
        timer.textContent = pad(Math.floor(elapsed / 60)) + ':' + pad(elapsed % 60)
      }, 1000)
    } else {
      recording = false
      clearInterval(interval)
      btn.textContent = '● REC'
      btn.classList.remove('recording')
      btn.setAttribute('aria-pressed', 'false')
      status.textContent = ''
      timer.textContent = '00:00'
      const ts = new Date().toISOString().replace('T', '-').replace(/:/g, '-').slice(0, 19)
      Recorder.stop('synth-' + ts + '.wav')
    }
  })
}

// ─── Mode switching ──────────────────────────────────────────────────────────
function switchMode(mode) {
  _currentMode = mode
  updateGlobalPlayAvailability()
  const appEl     = document.getElementById('app')
  const arrangeEl = document.getElementById('arrange-view')
  const rackEl = document.getElementById('rack-view')
  document.querySelectorAll('.tool-btn').forEach(btn => {
    const isActive = btn.dataset.tool === mode
    btn.classList.toggle('active', isActive)
    btn.setAttribute('aria-pressed', isActive ? 'true' : 'false')
  })
  if (mode === 'arrange') {
    _tr909View?.stop()
    appEl.style.display = 'none'
    // The rack is a sibling of #arrange-view, both flex: 1 — leaving it visible
    // stacks the two views and keeps RackPoll's interval running.
    rackEl.style.display = 'none'
    _rackView?.hide()
    arrangeEl.style.display = 'flex'
    startArrangeLoop()
    // Canvas may still be 0×0 if ResizeObserver hasn't fired since the element was hidden.
    // Force a size update on the next frame once the element is laid out.
    requestAnimationFrame(() => {
      if (_arrangementView) _arrangementView._onResize()
    })
  } else if (mode === 'rack') {
    _tr909View?.stop()
    appEl.style.display = 'none'
    arrangeEl.style.display = 'none'
    stopArrangeLoop()
    _rackView?.show()
  } else {
    appEl.style.display = ''
    arrangeEl.style.display = 'none'
    rackEl.style.display = 'none'
    _rackView?.hide()
    stopArrangeLoop()
  }
}

function startArrangeLoop() {
  if (_rafId) return
  function loop() {
    if (_arrangementView) {
      _arrangementView.setPlayheadBeat(TimelinePlayer.getCurrentBeat(ProjectStore.getState().bpm))
      _arrangementView.render()
    }
    _rafId = requestAnimationFrame(loop)
  }
  _rafId = requestAnimationFrame(loop)
}

function stopArrangeLoop() {
  if (_rafId) { cancelAnimationFrame(_rafId); _rafId = null }
}

// ─── Mixer strip sync ────────────────────────────────────────────────────────
function syncMixerStrips(state) {
  const bar = document.getElementById('mixer-bar')
  if (!bar) return
  const channelIds = new Set(state.mixer.channels.map(ch => ch.id))

  // Remove strips for deleted channels
  _mixerStrips.forEach((strip, id) => {
    if (!channelIds.has(id)) { strip.destroy(); _mixerStrips.delete(id) }
  })

  // Add/update strips
  state.mixer.channels.forEach(channel => {
    const track = state.tracks.find(t => t.mixerChannelId === channel.id)
    if (_mixerStrips.has(channel.id)) {
      _mixerStrips.get(channel.id).update(channel, track)
    } else {
      const strip = new MixerStrip(bar, {
        channel, track,
        onParam: (channelId, param, value) => {
          document.dispatchEvent(new CustomEvent('mixer-param', { detail: { channelId, param, value } }))
        }
      })
      _mixerStrips.set(channel.id, strip)
    }
    // Ensure mixer engine channel exists
    try { MixerEngine.ensureChannel(channel.id) } catch(e) {}
  })
}

// ─── Project management ──────────────────────────────────────────────────────
function setProjectOpen(name) {
  document.getElementById('project-name').textContent = name || 'Untitled'
  document.getElementById('save-project-btn').disabled = false
  document.getElementById('import-audio-btn').disabled = false
  document.getElementById('add-midi-track-btn').disabled = false
  document.getElementById('bounce-btn').disabled = false
}

function initProjectBar() {
  const themeSelect = document.getElementById('theme-select')
  if (themeSelect) {
    themeSelect.value = savedTheme()
    themeSelect.addEventListener('change', () => applyTheme(themeSelect.value))
  }

  document.getElementById('new-project-btn')?.addEventListener('click', async () => {
    await ensureAudio()
    const handle = await FileAdapter.createProjectFolder(getLastDir(DIR_KEY_PROJECT))
    if (handle) setLastDir(DIR_KEY_PROJECT, typeof handle === 'string' ? handle : null)
    if (!handle) return
    disposeLiveInstruments()
    ProjectStore.reset()
    AudioStore.reset()
    AudioStore.setProjectDir(handle)
    await FileAdapter.writeProject(handle, ProjectStore.getState())
    const name = typeof handle === 'string' ? handle.split(/[\\/]/).pop() : (handle.name ?? 'Project')
    setProjectOpen(name)
    syncMixerStrips(ProjectStore.getState())
    if (_arrangementView) _arrangementView.render()
  })

  document.getElementById('open-project-btn')?.addEventListener('click', async () => {
    await ensureAudio()
    const handle = await FileAdapter.openProjectFolder(getLastDir(DIR_KEY_PROJECT))
    if (handle) setLastDir(DIR_KEY_PROJECT, typeof handle === 'string' ? handle : null)
    if (!handle) return
    let state
    try {
      ;({ state } = await FileAdapter.readProject(handle))
    } catch (e) {
      console.warn('[open-project] Could not read project.json:', e)
      // Clear the stale stored path so we don't hit this again next time
      localStorage.removeItem(DIR_KEY_PROJECT)
      alert(`Could not open project:\n${e.message}`)
      return
    }
    disposeLiveInstruments()
    ProjectStore.load(state)
    AudioStore.reset()
    AudioStore.setProjectDir(handle)
    // Load all referenced audio files
    for (const track of state.tracks) {
      for (const clip of track.clips) {
        if (clip.type === 'audio' && clip.file) {
          AudioStore.loadBuffer(clip.file).catch(e => console.warn('Could not load', clip.file, e))
        }
      }
    }
    const name = typeof handle === 'string' ? handle.split(/[\\/]/).pop() : (handle.name ?? 'Project')
    setProjectOpen(name)
    syncMixerStrips(state)
    if (_arrangementView) _arrangementView.render()
  })

  document.getElementById('save-project-btn')?.addEventListener('click', async () => {
    const handle = AudioStore.getProjectDir()
    if (!handle) return
    await FileAdapter.writeProject(handle, ProjectStore.getState())
  })

  // Shared audio import helper — picks a file and adds it to targetTrackId (or creates a new track)
  async function importAudioToTrack(targetTrackId) {
    if (!AudioStore.getProjectDir()) return
    let fileHandle
    try {
      fileHandle = await pickAudioFile({
        getLastDir: () => getLastDir(DIR_KEY_AUDIO),
        setLastDir: dir => setLastDir(DIR_KEY_AUDIO, dir)
      })
    } catch (err) {
      // A picker that cannot run at all (no secure context) must say so rather
      // than leaving the button looking dead.
      console.warn('Audio import unavailable:', err?.message || err)
      return
    }
    if (!fileHandle) return
    await ensureAudio()
    const fileKey = await AudioStore.importFile(fileHandle)
    const state = ProjectStore.getState()
    const bpm = state.bpm
    const buf = AudioStore.getBuffer(fileKey)
    const duration = buf ? buf.duration / (60 / bpm) : 4

    let trackId = targetTrackId
    if (!trackId || !state.tracks.find(t => t.id === trackId)) {
      // Create a new track
      const trackName = fileKey.split('/').pop().replace(/\.[^.]+$/, '')
      ProjectStore.dispatch(AddTrack('audio', trackName))
      trackId = ProjectStore.getState().tracks.at(-1).id
      syncMixerStrips(ProjectStore.getState())
    }

    // Find the first free beat position (after last clip on this track)
    const track = ProjectStore.getState().tracks.find(t => t.id === trackId)
    const startBeat = track
      ? Math.max(0, ...track.clips.map(c => c.startBeat + (c.duration || 0)))
      : 0

    ProjectStore.dispatch(AddClip(trackId, {
      id: `clip-${Date.now()}`,
      type: 'audio',
      file: fileKey,
      startBeat,
      duration,
      offset: 0,
      fadeIn: 0,
      fadeOut: 0
    }))
    // Switch to arrange view so the user can immediately see the new track
    switchMode('arrange')
  }

  document.getElementById('import-audio-btn')?.addEventListener('click', () => {
    importAudioToTrack(_selectedArrangeTrackId)
  })

  document.getElementById('import-pack-btn')?.addEventListener('click', async () => {
    if (!window.electronFS?.importSf2Pack) return
    try {
      const pack = await window.electronFS.importSf2Pack()
      if (pack) await refreshPackCatalog()
    } catch (error) {
      alert(`Could not import SoundFont:\n${error.message}`)
    }
  })

  document.addEventListener('add-sample-to-track', (e) => {
    importAudioToTrack(e.detail.trackId)
  })

  document.getElementById('bounce-btn')?.addEventListener('click', async () => {
    if (!AudioStore.getProjectDir()) return
    await ensureAudio()
    const state = ProjectStore.getState()
    // Determine project length from rightmost clip end
    let durationBeats = 16
    state.tracks.forEach(t => t.clips.forEach(c => {
      durationBeats = Math.max(durationBeats, c.startBeat + c.duration)
    }))
    const wav = await TimelinePlayer.bounce({
      bpm: state.bpm,
      tracks: state.tracks,
      audioStore: AudioStore,
      durationBeats,
      racks: state.racks,
      packFor,
      sampleStoreFor,
      sampleRate: state.sampleRate
    })
    await FileAdapter.exportWav(wav, `bounce-${Date.now()}.wav`)
  })
}

// ─── Sidebar mode buttons ────────────────────────────────────────────────────
function initSidebarModes() {
  document.querySelectorAll('.tool-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      ensureAudio()
      switchMode(btn.dataset.tool)
    })
  })
  document.addEventListener('track-selected', (e) => {
    _selectedArrangeTrackId = e.detail.trackId
  })
}

// ─── Mixer param bus ─────────────────────────────────────────────────────────
// Single handler for all mute/solo/volume/pan changes from any source
// (mixer strips, arrangement track headers, etc.)
function initMixerParamBus() {
  document.addEventListener('mixer-param', (e) => {
    const { channelId, param, value } = e.detail
    ProjectStore.dispatch(SetMixerParam(channelId, param, value))
    // Mute and solo are mutually exclusive
    if (param === 'mute' && value) ProjectStore.dispatch(SetMixerParam(channelId, 'solo', false))
    if (param === 'solo' && value) ProjectStore.dispatch(SetMixerParam(channelId, 'mute', false))
    if (param === 'volume') MixerEngine.setVolume(channelId, value)
    if (param === 'pan')    MixerEngine.setPan(channelId, value)
    if (param === 'mute')   MixerEngine.setMute(channelId, value)
    if (param === 'solo') {
      const allIds = ProjectStore.getState().mixer.channels.map(c => c.id)
      MixerEngine.setSolo(channelId, value, allIds)
    }
  })
}

// ─── Arrange toolbar (non-transport wiring; transport lives in the global header) ──
function initArrangeToolbar() {
  // Add Track button in arrange toolbar
  document.getElementById('arr-add-track-btn')?.addEventListener('click', () => {
    ProjectStore.dispatch(AddTrack('audio', 'Track'))
    syncMixerStrips(ProjectStore.getState())
  })

  // Add Track from arrangement context menu
  document.addEventListener('add-audio-track', () => {
    ProjectStore.dispatch(AddTrack('audio', 'Track'))
    syncMixerStrips(ProjectStore.getState())
  })
  document.addEventListener('add-midi-track', () => {
    ProjectStore.dispatch(AddTrack('midi', 'MIDI'))
    syncMixerStrips(ProjectStore.getState())
  })
}

// ─── MIDI ───────────────────────────────────────────────────────────────────
function updateMidiDeviceSelect(inputs) {
  const sel = document.getElementById('midi-device-select')
  if (!sel) return
  const current = sel.value
  while (sel.options.length > 1) sel.remove(1)
  inputs.forEach(({ id, name }) => {
    const opt = document.createElement('option')
    opt.value = id; opt.textContent = name
    sel.appendChild(opt)
  })
  if (inputs.find(i => i.id === current)) sel.value = current
  else if (inputs.length) sel.value = inputs[0].id
  MidiController.selectInput(sel.value)
}

function initMidi() {
  const enableBtn  = document.getElementById('midi-enable-btn')
  const statusEl   = document.getElementById('midi-status')
  const deviceSel  = document.getElementById('midi-device-select')
  const recBtn     = document.getElementById('midi-record-btn')
  const addMidiBtn = document.getElementById('add-midi-track-btn')

  if (!enableBtn) return

  const enableMidi = async () => {
    const { granted, inputs, error } = await MidiController.requestAccess()
    if (!granted) {
      statusEl.textContent = 'MIDI: ' + (error || 'denied')
      return
    }
    statusEl.textContent = 'MIDI ON'
    statusEl.classList.add('granted')
    enableBtn.style.display = 'none'
    deviceSel.style.display = ''
    recBtn.style.display = ''
    updateMidiDeviceSelect(inputs)
  }

  enableBtn.addEventListener('click', enableMidi)
  // Electron resets Web MIDI access with every renderer restart. Reconnect a
  // previously-approved device so restarting the app cannot silently disable it.
  enableMidi()

  deviceSel?.addEventListener('change', () => {
    MidiController.selectInput(deviceSel.value)
    if (recBtn) recBtn.disabled = !deviceSel.value
  })

  recBtn?.addEventListener('click', () => {
    if (!MidiController.isGranted()) return
    if (!_midiRecording) {
      // Find or create a MIDI target track
      let state = ProjectStore.getState()
      let midiTrack = _midiTargetTrackId
        ? state.tracks.find(t => t.id === _midiTargetTrackId)
        : state.tracks.find(t => t.type === 'midi')

      if (!midiTrack) {
        ProjectStore.dispatch(AddTrack('midi', 'MIDI'))
        state = ProjectStore.getState()
        midiTrack = state.tracks[state.tracks.length - 1]
        syncMixerStrips(state)
      }
      _midiTargetTrackId = midiTrack.id

      // Create a new empty MIDI clip
      const clipId = `midi-clip-${Date.now()}`
      const startBeat = 0
      ProjectStore.dispatch(AddClip(midiTrack.id, {
        id: clipId, type: 'midi', name: 'Rec',
        startBeat, duration: 0, notes: []
      }))
      _midiTargetClipId = clipId

      MidiController.startRecording(ProjectStore.getState().bpm)
      _midiRecording = true
      recBtn.textContent = '■ STOP'
      recBtn.classList.add('recording')
    } else {
      const notes = MidiController.stopRecording()
      _midiRecording = false
      recBtn.textContent = '⏺ REC'
      recBtn.classList.remove('recording')

      if (_midiTargetTrackId && _midiTargetClipId && notes.length) {
        const dur = notes.reduce((m, n) => Math.max(m, n.startBeat + n.duration), 0)
        // SetMidiClipNotes also sets duration
        ProjectStore.dispatch({
          label: 'MIDI recording',
          execute(state) {
            const next = JSON.parse(JSON.stringify(state))
            const track = next.tracks.find(t => t.id === _midiTargetTrackId)
            if (!track) return next
            const clip = track.clips.find(c => c.id === _midiTargetClipId)
            if (!clip) return next
            clip.notes = notes
            clip.duration = Math.max(4, dur)
            return next
          },
          undo(state) { return state }
        })
      }
      _midiTargetClipId = null
    }
  })

  addMidiBtn?.addEventListener('click', () => {
    ProjectStore.dispatch(AddTrack('midi', 'MIDI'))
    syncMixerStrips(ProjectStore.getState())
    switchMode('arrange')
  })

  // Route live MIDI note events → track instruments (routeChannel), falling
  // back to the plain keyboard behaviour when no MIDI tracks exist at all.
  document.addEventListener('midi-event', (e) => {
    const detail = e.detail
    if (detail.kind === 'program-change' || (detail.kind === 'cc' && (detail.controller === 0 || detail.controller === 32))) {
      const result = applyChannelMidi(_channelPrograms, detail)
      _channelPrograms = result.stateByChannel
      if (!result.change) return
      const state = ProjectStore.getState()
      for (const trackId of routeChannel(state.tracks.filter(track => track.type === 'midi'), detail.channel, _midiTargetTrackId)) {
        const track = state.tracks.find(candidate => candidate.id === trackId)
        if (track?.instrument?.type !== 'pack' || track.instrument.programFollow === 'pinned') continue
        const pack = packFor(track.instrument.packId, track.instrument.packVersion)
        const resolved = pack && resolvePatch(pack, result.change, { channel: detail.channel })
        ProjectStore.dispatch(SetTrackInstrumentProgram(trackId, {
          ...(resolved?.selection || { packId: track.instrument.packId, packVersion: track.instrument.packVersion, patchId: track.instrument.patchId }),
          ...result.change,
          patchId: resolved?.patch?.id || track.instrument.patchId,
          unresolved: !resolved?.patch
        }))
      }
      return
    }
    if (detail.kind !== 'note-on' && detail.kind !== 'note-off' && detail.kind !== 'cc' && detail.kind !== 'pitch-bend') return
    ensureAudio()
    const ctx = AudioEngine.getContext()
    if (!ctx) return

    const state = ProjectStore.getState()
    const midiTracks = state.tracks.filter(t => t.type === 'midi')

    // Prune instruments for tracks that no longer exist.
    for (const [trackId, entry] of [..._liveInstruments]) {
      if (!state.tracks.some(t => t.id === trackId)) {
        entry.inst.dispose()
        _liveInstruments.delete(trackId)
      }
    }

    const ids = routeChannel(midiTracks, detail.channel, _midiTargetTrackId)

    if (ids.length === 0 && midiTracks.length === 0) {
      // No MIDI tracks at all — plain keyboard behaviour, notes only.
      if (detail.kind !== 'note-on' && detail.kind !== 'note-off') return
      const note = detail.pitch
      if (detail.kind === 'note-on') {
        if (activeVoices[note]) return
        const freq = 440 * Math.pow(2, (note - 69) / 12)
        try {
          const voice = currentPalette.createVoice(ctx, AudioEngine.getMasterInput(), freq, detail.velocity / 127, ctx.currentTime)
          activeVoices[note] = voice
        } catch (err) {}
      } else {
        if (activeVoices[note]) {
          try { activeVoices[note].stop(ctx.currentTime) } catch (err) {}
          delete activeVoices[note]
        }
      }
      return
    }

    for (const trackId of ids) {
      const track = state.tracks.find(t => t.id === trackId)
      if (!track) continue

      const sig = JSON.stringify(track.instrument ?? null)
      let entry = _liveInstruments.get(trackId)
      if (entry && entry.sig !== sig) {
        entry.inst.dispose()
        entry = null
      }
      if (!entry) {
        const output = MixerEngine.getOutput(track.mixerChannelId) || AudioEngine.getMasterInput()
        const inst = liveInstrumentFor(track, {
          palettes: Palettes,
          ctx,
          output,
          racks: state.racks,
          packFor,
          sampleStoreFor,
          mountRack: rack => RackEngine.mount(ctx, rack, {
            output,
            getBuffer: fileKey => AudioStore.getBufferOrLoad?.(fileKey) ?? null,
            onParam: (target, value) => {
              const [channelId, param] = target.split('.')
              if (param === 'volume') MixerEngine.setVolume(channelId, value)
              else if (param === 'pan') MixerEngine.setPan(channelId, value)
            }
          })
        })
        if (!inst) continue
        entry = { sig, inst }
        _liveInstruments.set(trackId, entry)
      }

      try {
        if (detail.kind === 'note-on') entry.inst.noteOn(detail.pitch, detail.velocity)
        else if (detail.kind === 'note-off') entry.inst.noteOff(detail.pitch)
        // ponytail: only CC1 mapped. Add a CC-learn map when a second controller matters.
        else if (detail.kind === 'cc') {
          if (detail.controller === 1) entry.inst.send({ type: 'mod', value: detail.value / 127 })
        }
        else entry.inst.send({ type: 'pitch-bend', value: detail.value })
      } catch (err) {}
    }
  })

  // Keep device list in sync when devices connect/disconnect
  document.addEventListener('midi-device-change', (e) => {
    updateMidiDeviceSelect(e.detail.inputs)
  })

  // Listen for selected track changes to auto-arm MIDI record to it
  document.addEventListener('track-selected', (e) => {
    const state = ProjectStore.getState()
    const track = state.tracks.find(t => t.id === e.detail.trackId)
    if (track && track.type === 'midi') {
      _midiTargetTrackId = track.id
      if (recBtn && MidiController.isGranted() && deviceSel?.value) {
        recBtn.disabled = false
      }
    }
  })
}

// ─── Piano Roll ──────────────────────────────────────────────────────────────
function initPianoRoll() {
  const drawer    = document.getElementById('piano-roll-drawer')
  const container = document.getElementById('piano-roll-container')
  const closeBtn  = document.getElementById('close-piano-roll-btn')
  const nameEl    = document.getElementById('pr-clip-name')
  const quantSel  = document.getElementById('pr-quantize')
  if (!drawer || !container) return

  _pianoRoll = new PianoRoll(container, { store: ProjectStore })

  function setPrTool(tool) {
    drawer.querySelectorAll('.pr-tool-btn').forEach(b => {
      const isActive = b.dataset.prTool === tool
      b.classList.toggle('active', isActive)
      b.setAttribute('aria-checked', isActive ? 'true' : 'false')
    })
    _pianoRoll.setTool(tool)
  }

  // Tool buttons
  drawer.querySelectorAll('.pr-tool-btn').forEach(btn => {
    btn.addEventListener('click', () => setPrTool(btn.dataset.prTool))
  })

  quantSel?.addEventListener('change', () => {
    _pianoRoll.setQuantize(quantSel.value)
  })

  function closePianoRoll() {
    drawer.style.display = 'none'
    ShortcutManager.setContext('global')
    // Return focus to arrangement canvas
    document.getElementById('arrangement-container')?.querySelector('canvas')?.focus()
  }

  closeBtn?.addEventListener('click', closePianoRoll)

  // Open on double-click from arrangement view
  document.addEventListener('open-piano-roll', (e) => {
    const { trackId, clipId, clipName } = e.detail
    if (nameEl) nameEl.textContent = clipName || 'clip'
    drawer.style.display = 'flex'
    _pianoRoll.open(trackId, clipId)
    ShortcutManager.setContext('pianoroll')
    // Focus the close button for keyboard users
    closeBtn?.focus()
  })

  // Piano roll shortcut keys (only active in pianoroll context)
  ShortcutManager.register({ key: 'd', context: 'pianoroll' }, () => setPrTool('draw'))
  ShortcutManager.register({ key: 's', context: 'pianoroll' }, () => setPrTool('select'))
  ShortcutManager.register({ key: 'e', context: 'pianoroll' }, () => setPrTool('erase'))
  ShortcutManager.register({ key: 'escape', context: 'pianoroll' }, () => closePianoRoll())
}

// ─── Shortcuts ────────────────────────────────────────────────────────────────
let _isPlaying = false

function initShortcuts() {
  ShortcutManager.init()

  // Undo / Redo
  ShortcutManager.register({ key: 'z', ctrl: true },              () => ProjectStore.undo())
  ShortcutManager.register({ key: 'z', ctrl: true, shift: true }, () => ProjectStore.redo())
  ShortcutManager.register({ key: 'y', ctrl: true },              () => ProjectStore.redo())

  // Project
  ShortcutManager.register({ key: 's', ctrl: true }, () => {
    document.getElementById('save-project-btn')?.click()
  })
  ShortcutManager.register({ key: 'n', ctrl: true }, () => {
    document.getElementById('new-project-btn')?.click()
  })
  ShortcutManager.register({ key: 'o', ctrl: true }, () => {
    document.getElementById('open-project-btn')?.click()
  })

  // Mode switching
  ShortcutManager.register({ key: 'f1' }, () => switchMode('synth'))
  ShortcutManager.register({ key: 'f2' }, () => switchMode('arrange'))
  ShortcutManager.register({ key: 'f3' }, () => switchMode('rack'))

  // Transport — Space = play/stop toggle (mode-aware)
  ShortcutManager.register({ key: ' ' }, () => {
    const playBtn = document.getElementById('global-play-btn')
    const stopBtn = document.getElementById('global-stop-btn')
    if (_isPlaying) {
      stopBtn?.click()
      _isPlaying = false
      playBtn?.setAttribute('aria-pressed', 'false')
    } else {
      playBtn?.click()
      _isPlaying = true
      playBtn?.setAttribute('aria-pressed', 'true')
    }
  })

  // Stop always resets
  ShortcutManager.register({ key: ' ', shift: true }, () => {
    document.getElementById('global-stop-btn')?.click()
    _isPlaying = false
    document.getElementById('global-play-btn')?.setAttribute('aria-pressed', 'false')
  })
}

// Legacy alias (kept for boot() call site)
function initUndoRedo() { /* migrated to initShortcuts */ }

// ─── Bootstrap ─────────────────────────────────────────────────────────────
function boot() {
  applyTheme(savedTheme())
  Keyboard.render('keyboard')
  renderDrumPads()
  Sequencer.init('seq-tracks')
  const tr909Container = document.getElementById('tr909-view')
  if (tr909Container) _tr909View = new Tr909View(tr909Container, { ensureAudio })

  renderKnobPanel()
  initGlobalHeader()
  initTransport()
  initTabs()
  initRecorder()

  // Init audio on first click anywhere (required by browsers)
  document.body.addEventListener('click', ensureAudio, { once: false })
  document.body.addEventListener('keydown', ensureAudio, { once: false })

  initProjectBar()
  initSidebarModes()
  initMixerParamBus()
  initArrangeToolbar()
  initShortcuts()
  initMidi()
  initPianoRoll()

  // Init arrangement view
  const container = document.getElementById('arrangement-container')
  if (container) {
    _arrangementView = new ArrangementView(container, {
      store: ProjectStore,
      audioStore: AudioStore,
      packCatalog: () => _packCatalog
    })
  }
  const inspector = document.getElementById('instrument-inspector')
  if (inspector) _instrumentInspector = new InstrumentInspector(inspector, { store: ProjectStore, packCatalog: () => _packCatalog, audition: auditionTrack })
  const rackContainer = document.getElementById('rack-view')
  if (rackContainer) _rackView = new RackView(rackContainer, {
    hasWorklet: () => AudioEngine.hasWorklet(),
    getAudioContext: () => AudioEngine.getContext(),
    getMasterInput: () => AudioEngine.getMasterInput()
  })

  // Subscribe store to keep mixer in sync
  ProjectStore.subscribe(state => syncMixerStrips(state))
  refreshPackCatalog().catch(error => console.warn('Could not load instrument packs:', error))
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot)
} else {
  boot()
}
