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
import ProjectStore, { AddTrack, AddClip, SetMixerParam } from './store/ProjectStore.js'
import FileAdapter from './io/FileAdapter.js'
import AudioStore from './audio-store.js'
import { ArrangementView } from './components/arrangement-view.js'
import { MixerStrip } from './components/mixer-strip.js'
import MixerEngine from './audio/mixer-engine.js'
import TimelinePlayer from './playback/timeline-player.js'

let currentPaletteKey = 'classic'
let currentPalette = Palettes.classic
const activeVoices = {} // midi note → voice object

let _arrangementView = null
let _mixerStrips = new Map()  // channelId → MixerStrip
let _currentMode = 'synth'    // 'synth' | 'arrange'
let _rafId = null

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
    t.classList.toggle('active', t.dataset.palette === key)
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

// PC keyboard 1–4 for drum pads
window.addEventListener('keydown', (e) => {
  if (currentPaletteKey !== 'drum') return
  if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return
  if (document.activeElement && ['INPUT','SELECT','TEXTAREA'].includes(document.activeElement.tagName)) return
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

    const lbl = document.createElement('label')
    lbl.className = 'knob-label'
    lbl.textContent = def.label

    const rawVal = p.params[def.key]
    const slider = document.createElement('input')
    slider.type = 'range'
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
  document.querySelectorAll('.tool-btn').forEach(btn =>
    btn.classList.toggle('active', btn.dataset.tool === mode)
  )
  if (mode === 'arrange') {
    appEl.style.display = 'none'
    arrangeEl.style.display = 'flex'
    startArrangeLoop()
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
  document.getElementById('bounce-btn').disabled = false
}

function initProjectBar() {
  document.getElementById('new-project-btn')?.addEventListener('click', async () => {
    await ensureAudio()
    const handle = await FileAdapter.createProjectFolder()
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
    const handle = await FileAdapter.openProjectFolder()
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
      const result = await window.electronFS.showOpenDialog({
        properties: ['openFile'],
        filters: [{ name: 'Audio', extensions: ['wav', 'mp3', 'flac', 'ogg', 'aiff'] }]
      })
      if (result.canceled || !result.filePaths.length) return
      fileHandle = result.filePaths[0]
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
  // Re-use existing play/stop buttons for arrange mode too
  // The existing transport buttons already call Sequencer.play/stop
  // When in arrange mode, they should control TimelinePlayer instead
  const playBtn = document.getElementById('play-btn')
  const stopBtn = document.getElementById('stop-btn')
  if (!playBtn || !stopBtn) return

  // Replace handlers to be mode-aware
  playBtn.replaceWith(playBtn.cloneNode(true))
  stopBtn.replaceWith(stopBtn.cloneNode(true))

  document.getElementById('play-btn')?.addEventListener('click', () => {
    ensureAudio()
    if (_currentMode === 'arrange') {
      const state = ProjectStore.getState()
      TimelinePlayer.play({
        beat: 0,
        bpm: state.bpm,
        tracks: state.tracks,
        audioStore: AudioStore,
        mixerEngine: MixerEngine
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

// ─── Undo / Redo ──────────────────────────────────────────────────────────────
function initUndoRedo() {
  window.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === 'z') {
      e.preventDefault()
      ProjectStore.undo()
    }
    if ((e.ctrlKey || e.metaKey) && (e.shiftKey && e.key === 'z' || e.key === 'y')) {
      e.preventDefault()
      ProjectStore.redo()
    }
  })
}

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
  initUndoRedo()

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
