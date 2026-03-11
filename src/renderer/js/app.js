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
import ProjectStore, { AddTrack, AddClip, SetMixerParam, SetBpm, RemoveTrack } from './store/ProjectStore.js'
import FileAdapter from './io/FileAdapter.js'
import AudioStore from './audio-store.js'
import { ArrangementView } from './components/arrangement-view.js'
import { MixerStrip } from './components/mixer-strip.js'
import MixerEngine from './audio/mixer-engine.js'
import TimelinePlayer from './playback/timeline-player.js'
import MidiController from './midi/MidiController.js'
import { PianoRoll } from './components/piano-roll.js'
import ShortcutManager from './shortcuts.js'

// ─── Per-type directory memory ────────────────────────────────────────────────
const DIR_KEY_PROJECT = 'synth_lastProjectDir'
const DIR_KEY_AUDIO   = 'synth_lastAudioDir'
function getLastDir(key)       { return localStorage.getItem(key) || undefined }
function setLastDir(key, path) { if (path) localStorage.setItem(key, path) }

let currentPaletteKey = 'classic'
let currentPalette = Palettes.classic
const activeVoices = {} // midi note → voice object

let _arrangementView = null
let _pianoRoll = null
let _mixerStrips = new Map()  // channelId → MixerStrip
let _currentMode = 'synth'    // 'synth' | 'arrange'
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
  document.getElementById('keyboard-wrap').style.display = isDrum ? 'none' : ''
  document.getElementById('keyboard-hint').style.display = isDrum ? 'none' : ''
  document.getElementById('drum-pads').style.display    = isDrum ? 'flex' : 'none'
  document.getElementById('drum-hint').style.display    = isDrum ? '' : 'none'
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

// ─── Master volume ──────────────────────────────────────────────────────────
function initMasterVolume() {
  const slider = document.getElementById('master-vol')
  const disp   = document.getElementById('master-vol-display')
  if (!slider) return

  function update() {
    const v = parseFloat(slider.value)
    const pct = v * 100
    slider.style.setProperty('--fill', pct + '%')
    slider.classList.add('filled')
    if (disp) disp.textContent = Math.round(pct)
    AudioEngine.setMasterVolume(v)
  }

  slider.addEventListener('input', update)
  // Init fill
  const pct = parseFloat(slider.value) * 100
  slider.style.setProperty('--fill', pct + '%')
  slider.classList.add('filled')
  if (disp) disp.textContent = Math.round(pct)
}

// ─── BPM slider ────────────────────────────────────────────────────────────
function initBPM() {
  const slider = document.getElementById('bpm-slider')
  const disp   = document.getElementById('bpm-display')
  if (!slider) return

  function update() {
    Sequencer.setBPM(slider.value)
    if (disp) disp.textContent = slider.value
    const pct = (slider.value - slider.min) / (slider.max - slider.min) * 100
    slider.style.setProperty('--fill', pct + '%')
  }

  slider.classList.add('filled')
  slider.addEventListener('input', update)
  update()
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
  document.getElementById('play-btn')?.addEventListener('click', () => {
    ensureAudio()
    Sequencer.play()
  })
  document.getElementById('stop-btn')?.addEventListener('click', () => {
    Sequencer.stop()
  })
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

  btn.addEventListener('click', () => {
    ensureAudio()
    if (!recording) {
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
  const appEl     = document.getElementById('app')
  const arrangeEl = document.getElementById('arrange-view')
  document.querySelectorAll('.tool-btn').forEach(btn => {
    const isActive = btn.dataset.tool === mode
    btn.classList.toggle('active', isActive)
    btn.setAttribute('aria-pressed', isActive ? 'true' : 'false')
  })
  if (mode === 'arrange') {
    appEl.style.display = 'none'
    arrangeEl.style.display = 'flex'
    startArrangeLoop()
    // Canvas may still be 0×0 if ResizeObserver hasn't fired since the element was hidden.
    // Force a size update on the next frame once the element is laid out.
    requestAnimationFrame(() => {
      if (_arrangementView) _arrangementView._onResize()
    })
  } else {
    appEl.style.display = ''
    arrangeEl.style.display = 'none'
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
          ProjectStore.dispatch(SetMixerParam(channelId, param, value))
          MixerEngine.setVolume(channelId, ProjectStore.getState().mixer.channels.find(c => c.id === channelId)?.volume ?? 1)
          if (param === 'volume') MixerEngine.setVolume(channelId, value)
          if (param === 'pan')    MixerEngine.setPan(channelId, value)
          if (param === 'mute')   MixerEngine.setMute(channelId, value)
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
  document.getElementById('new-project-btn')?.addEventListener('click', async () => {
    await ensureAudio()
    const handle = await FileAdapter.createProjectFolder(getLastDir(DIR_KEY_PROJECT))
    if (handle) setLastDir(DIR_KEY_PROJECT, typeof handle === 'string' ? handle : null)
    if (!handle) return
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
    const { state } = await FileAdapter.readProject(handle)
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

  document.getElementById('import-audio-btn')?.addEventListener('click', async () => {
    if (!AudioStore.getProjectDir()) return
    // In browser: show file picker. In Electron: show open dialog.
    let fileHandle
    if (window.electronFS) {
      const audioDialogOpts = {
        properties: ['openFile'],
        filters: [{ name: 'Audio', extensions: ['wav', 'mp3', 'flac', 'ogg', 'aiff'] }]
      }
      const lastAudioDir = getLastDir(DIR_KEY_AUDIO)
      if (lastAudioDir) audioDialogOpts.defaultPath = lastAudioDir
      const result = await window.electronFS.showOpenDialog(audioDialogOpts)
      if (result.canceled || !result.filePaths.length) return
      fileHandle = result.filePaths[0]
      // Save the directory containing the selected file
      const lastSlash = Math.max(fileHandle.lastIndexOf('/'), fileHandle.lastIndexOf('\\'))
      if (lastSlash > 0) setLastDir(DIR_KEY_AUDIO, fileHandle.substring(0, lastSlash))
    } else {
      [fileHandle] = await window.showOpenFilePicker({
        types: [{ description: 'Audio Files', accept: { 'audio/*': ['.wav', '.mp3', '.flac', '.ogg'] } }]
      })
    }
    await ensureAudio()
    const fileKey = await AudioStore.importFile(fileHandle)
    // Add a new audio track + clip to the project
    const state = ProjectStore.getState()
    const trackName = fileKey.split('/').pop().replace(/\.[^.]+$/, '')
    ProjectStore.dispatch(AddTrack('audio', trackName))
    const newState = ProjectStore.getState()
    const newTrack = newState.tracks[newState.tracks.length - 1]
    const buf = AudioStore.getBuffer(fileKey)
    const duration = buf ? buf.duration / (60 / state.bpm) : 4
    ProjectStore.dispatch(AddClip(newTrack.id, {
      id: `clip-${Date.now()}`,
      type: 'audio',
      file: fileKey,
      startBeat: 0,
      duration,
      offset: 0,
      fadeIn: 0,
      fadeOut: 0
    }))
    syncMixerStrips(ProjectStore.getState())
    // Switch to arrange view so the user can immediately see the new track
    switchMode('arrange')
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
}

// ─── Arrange transport (play/stop) ──────────────────────────────────────────
function initArrangeTransport() {
  // Dedicated arrange toolbar buttons
  document.getElementById('arr-play-btn')?.addEventListener('click', () => {
    ensureAudio()
    const state = ProjectStore.getState()
    TimelinePlayer.play({
      beat: 0,
      bpm: state.bpm,
      tracks: state.tracks,
      audioStore: AudioStore,
      mixerEngine: MixerEngine,
      palettes: Palettes
    })
    document.getElementById('arr-play-btn').setAttribute('aria-pressed', 'true')
  })

  document.getElementById('arr-stop-btn')?.addEventListener('click', () => {
    TimelinePlayer.stop()
    document.getElementById('arr-play-btn')?.setAttribute('aria-pressed', 'false')
  })

  document.getElementById('arr-bpm')?.addEventListener('change', (e) => {
    const bpm = parseInt(e.target.value) || 120
    ProjectStore.dispatch(SetBpm(bpm))
  })

  // Keep BPM input in sync with store (e.g. after project open)
  ProjectStore.subscribe(() => {
    const bpmEl = document.getElementById('arr-bpm')
    if (bpmEl) bpmEl.value = ProjectStore.getState().bpm
  })

  // Synth mode transport
  document.getElementById('play-btn')?.addEventListener('click', () => {
    ensureAudio()
    if (_currentMode === 'arrange') {
      const state = ProjectStore.getState()
      TimelinePlayer.play({
        beat: 0,
        bpm: state.bpm,
        tracks: state.tracks,
        audioStore: AudioStore,
        mixerEngine: MixerEngine,
        palettes: Palettes
      })
    } else {
      Sequencer.play()
    }
  })
  document.getElementById('stop-btn')?.addEventListener('click', () => {
    if (_currentMode === 'arrange') {
      TimelinePlayer.stop()
    } else {
      Sequencer.stop()
    }
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

  enableBtn.addEventListener('click', async () => {
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
  })

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

  // Route live MIDI note events → synth voices (same as keyboard)
  document.addEventListener('midi-note-on', (e) => {
    ensureAudio()
    const ctx = AudioEngine.getContext()
    if (!ctx) return
    const note = e.detail.pitch
    if (activeVoices[note]) return
    const freq = 440 * Math.pow(2, (note - 69) / 12)
    try {
      const voice = currentPalette.createVoice(ctx, AudioEngine.getMasterInput(), freq, e.detail.velocity / 127, ctx.currentTime)
      activeVoices[note] = voice
    } catch (err) {}
  })
  document.addEventListener('midi-note-off', (e) => {
    const note = e.detail.pitch
    if (activeVoices[note]) {
      const ctx = AudioEngine.getContext()
      try { activeVoices[note].stop(ctx ? ctx.currentTime : 0) } catch (err) {}
      delete activeVoices[note]
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

  // Transport — Space = play/stop toggle (mode-aware)
  ShortcutManager.register({ key: ' ' }, () => {
    const playBtn = document.getElementById('play-btn')
    const stopBtn = document.getElementById('stop-btn')
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
    document.getElementById('stop-btn')?.click()
    _isPlaying = false
    document.getElementById('play-btn')?.setAttribute('aria-pressed', 'false')
  })
}

// Legacy alias (kept for boot() call site)
function initUndoRedo() { /* migrated to initShortcuts */ }

// ─── Bootstrap ─────────────────────────────────────────────────────────────
function boot() {
  Keyboard.render('keyboard')
  renderDrumPads()
  Sequencer.init('seq-tracks')

  renderKnobPanel()
  initMasterVolume()
  initBPM()
  initTransport()
  initTabs()
  initRecorder()

  // Init audio on first click anywhere (required by browsers)
  document.body.addEventListener('click', ensureAudio, { once: false })
  document.body.addEventListener('keydown', ensureAudio, { once: false })

  initProjectBar()
  initSidebarModes()
  initArrangeTransport()
  initShortcuts()
  initMidi()
  initPianoRoll()

  // Init arrangement view
  const container = document.getElementById('arrangement-container')
  if (container) {
    _arrangementView = new ArrangementView(container, {
      store: ProjectStore,
      audioStore: AudioStore
    })
  }

  // Subscribe store to keep mixer in sync
  ProjectStore.subscribe(state => syncMixerStrips(state))
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot)
} else {
  boot()
}
