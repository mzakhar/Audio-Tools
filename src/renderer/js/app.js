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
import ProjectStore, { AddTrack, AddClip, SetMixerParam, SetBpm, RemoveTrack, SetTrackInstrument, SetTrackInstrumentProgram } from './store/ProjectStore.js'
import RackEngine from './rack/rack-engine.js'
import { routeChannel } from './midi/midi-routing.js'
import { holdReducer } from './midi/midi-hold.js'
import { liveInstrumentFor, paletteAcceptsNote } from './midi/live-instrument.js'
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
import { InstrumentBrowser } from './components/instrument-browser.js'
import { InstrumentSettings } from './components/instrument-settings.js'
import { LibraryDialog } from './components/library-dialog.js'
import ShortcutManager from './shortcuts.js'
import { applyTheme, savedTheme, THEMES } from './theme.js'
import { commandItems } from './ui/command-model.js'
import { openDialog, closeDialog } from './ui/dialog.js'
import { applyChannelMidi } from './instruments/channel-program.js'
import { compilePackManifest, resolvePatch } from './instruments/pack-registry.js'
import { createSampleStore } from './instruments/sample-store.js'
import { createPackStore } from './instruments/pack-store-idb.js'
import { importPackFromFile } from './instruments/pack-import-web.js'
import { createAuditioner } from './instruments/auditioner.js'
import { armPlan } from './instruments/arm-track.js'
import { trackInstrumentLabel } from './instruments/instrument-label.js'
import { PadGrid } from './components/pad-grid.js'
import { padBank } from './instruments/pad-map.js'

// ─── Per-type directory memory ────────────────────────────────────────────────
const DIR_KEY_PROJECT = 'synth_lastProjectDir'
const DIR_KEY_AUDIO   = 'synth_lastAudioDir'
const MIDI_DEVICE_KEY = 'synth_midi_input'
function getLastDir(key)       { return localStorage.getItem(key) || undefined }
function setLastDir(key, path) { if (path) localStorage.setItem(key, path) }

const computerKeyTracks = new Map() // note → MIDI channel while held
const _liveInstruments = new Map() // trackId → { sig, inst }
let _packCatalog = []
let _channelPrograms = null
let _holdState                        // sustain-pedal state, one shared object, keyed internally by channel
// `${channel}:${pitch}` → trackId[]. A note-off must reach whatever played the
// note-on: arming another track mid-hold would otherwise strand the voice.
const _soundingRoutes = new Map()
const _sampleStores = new WeakMap()

function packFor(packId, version) {
  return _packCatalog.find(pack => pack.id === packId && pack.version === version) || null
}

/** IndexedDB pack storage, when this build has one. Private windows can refuse. */
let _webPacks
function webPackStore() {
  if (_webPacks === undefined) {
    try { _webPacks = createPackStore() } catch { _webPacks = null }
  }
  return _webPacks
}

function canImportPacks() {
  return !!window.electronFS?.importSf2Pack || !!webPackStore()
}

/** Catalog entries carry `origin`, so a pack is always read back from where it lives. */
function sampleLoaderFor(pack) {
  if (pack.origin === 'idb') {
    const store = webPackStore()
    return store ? sampleId => store.readSample(pack.id, pack.version, sampleId) : null
  }
  if (!window.electronFS?.readInstrumentSample) return null
  return sampleId => window.electronFS.readInstrumentSample(pack.id, pack.version, sampleId)
}

function sampleStoreFor(pack, ctx) {
  const load = sampleLoaderFor(pack)
  if (!load) return null
  let stores = _sampleStores.get(ctx)
  if (!stores) _sampleStores.set(ctx, stores = new Map())
  const key = `${pack.origin || 'fs'}:${pack.id}@${pack.version}`
  if (!stores.has(key)) stores.set(key, createSampleStore({ ctx, load }))
  return stores.get(key)
}

function sampleStatus(trackId, status) {
  document.dispatchEvent(new CustomEvent('instrument-sample-status', { detail: { trackId, status } }))
}

async function warmPack(pack, patch) {
  await ensureAudio()
  const ctx = AudioEngine.getContext(), store = pack && ctx && sampleStoreFor(pack, ctx)
  // Warm a small playable octave range, not an entire SoundFont preset.
  const ids = [...new Set([48, 60, 72].flatMap(note => patch?.zones
    ?.filter(item => note >= item.keyLo && note <= item.keyHi && 100 >= (item.velocityLo ?? 0) && 100 <= (item.velocityHi ?? 127))
    .map(item => item.sampleId) || []))]
  if (store && ids.length) await store.preload(ids)
}

/** Deps for instrumentFor/liveInstrumentFor — one shape, every call site, so
 *  an audition cannot be built differently from the thing it auditions. */
function instrumentDeps({ output, trackId } = {}) {
  const ctx = AudioEngine.getContext()
  const out = output || AudioEngine.getMasterInput()
  return {
    palettes: Palettes,
    ctx,
    output: out,
    racks: ProjectStore.getState().racks,
    packFor,
    sampleStoreFor,
    onStatus: trackId ? status => sampleStatus(trackId, status) : undefined,
    mountRack: rack => RackEngine.mount(ctx, rack, {
      output: out,
      getBuffer: fileKey => AudioStore.getBufferOrLoad?.(fileKey) ?? null,
      onParam: (target, value) => {
        const [channelId, param] = target.split('.')
        if (param === 'volume') MixerEngine.setVolume(channelId, value)
        else if (param === 'pan') MixerEngine.setPan(channelId, value)
      }
    })
  }
}

const _auditioner = createAuditioner({ ensureAudio, buildDeps: () => instrumentDeps() })

/** 'ready' | 'unavailable' | 'missing' for a pack instrument descriptor. */
function packState(instrument) {
  const pack = packFor(instrument.packId, instrument.packVersion)
  if (!pack?.byId?.get(instrument.patchId)) return 'missing'
  return window.electronFS?.readInstrumentSample ? 'ready' : 'unavailable'
}

function addMidiTrack(name = 'MIDI', instrument) {
  ProjectStore.dispatch(AddTrack('midi', name))
  const track = ProjectStore.getState().tracks.at(-1)
  if (track && instrument) ProjectStore.dispatch(SetTrackInstrument(track.id, instrument))
  if (track) _midiTargetTrackId = track.id
  syncMixerStrips(ProjectStore.getState())
  syncInstrumentUi()
  return track
}

/**
 * The one selection: the armed MIDI track. A note played into a project with
 * no MIDI track provisions one — a person playing notes wants somewhere to
 * record them. One track, once; never one per note.
 */
function ensureMidiTrack(instrument) {
  const plan = armPlan(ProjectStore.getState().tracks, _midiTargetTrackId)
  if (plan.provision) return addMidiTrack('MIDI', instrument)
  _midiTargetTrackId = plan.trackId
  syncInstrumentUi()
  return ProjectStore.getState().tracks.find(track => track.id === plan.trackId)
}

/** One import entry point: native dialog under Electron, file input otherwise. */
async function importPack(onProgress) {
  const pack = window.electronFS?.importSf2Pack
    ? await window.electronFS.importSf2Pack()
    : await importPackFromFile({ store: webPackStore(), onProgress })
  if (pack) await refreshPackCatalog()
  return pack
}

async function listPacksFrom(source, origin) {
  try { return (await source()).map(entry => ({ ...entry, origin })) }
  catch (err) { console.warn(`Could not list ${origin} instrument packs:`, err); return [] }
}

async function refreshPackCatalog() {
  const sources = []
  if (window.electronFS?.listInstrumentPacks) sources.push(listPacksFrom(() => window.electronFS.listInstrumentPacks(), 'fs'))
  const store = webPackStore()
  if (store) sources.push(listPacksFrom(() => store.listPacks(), 'idb'))
  if (!sources.length) return
  // compilePackManifest throws on an invalid manifest. One bad pack must not
  // empty the whole catalog and mute every pack track in the project.
  _packCatalog = (await Promise.all(sources)).flat().flatMap(entry => {
    try { return [{ ...compilePackManifest(entry.manifest), origin: entry.origin, bytes: entry.bytes || 0 }] }
    catch (err) { console.warn('Skipping unreadable instrument pack:', entry?.manifest?.id ?? entry, err); return [] }
  })
  renderInstrumentSlot()
  _arrangementView?.render()
  _instrumentBrowser?.refresh()
  _libraryDialog?.render()
}

/** Tear down every live MIDI instrument — the old project's tracks are gone. */
function disposeLiveInstruments() {
  for (const entry of _liveInstruments.values()) {
    try { entry.inst.dispose() } catch (err) {}
  }
  _liveInstruments.clear()
  // The pedal state outlives nothing: a channel still marked held would
  // swallow every future note-off, and the deferred pitches it is holding
  // belong to instruments that no longer exist.
  _holdState = undefined
  _soundingRoutes.clear()
}

let _arrangementView = null
let _pianoRoll = null
let _tr909View = null
let _rackView = null
let _instrumentBrowser = null
let _instrumentSettings = null
let _libraryDialog = null
let _mixerStrips = new Map()  // channelId → MixerStrip
let _currentMode = 'synth'    // 'synth' | 'arrange' | 'rack' | 'tr909'
let _selectedArrangeTrackId = null
let _rafId = null
let _midiRecording = false
let _midiTargetTrackId = null  // track to write recorded MIDI into
let _midiTargetClipId = null
let _projectOpen = false
let _projectName = ''
let _projectDirty = false
let _midiInputName = null      // selected MIDI input, drives the live status token
let _audioRecording = false

let _padGrid = null
let _slotSig = null           // armed track + instrument, so the panel only rebuilds when it must
let _reverbAmount = 0.2       // AudioEngine has no getter; this is the knob's copy

// ─── Audio init on first gesture ──────────────────────────────────────────
async function ensureAudio() {
  await AudioEngine.init()
}

// ─── Commands ──────────────────────────────────────────────────────────────
// One implementation per command id. The command bar, the ⋯ menu and the
// shortcuts all route through here, so a control can never be live in one
// place and dead in another.
const COMMANDS = Object.create(null)
function runCommand(id) { return COMMANDS[id]?.() }

/** Transient status line — replaces the permanent #rec-status span. */
let _toastTimer = null
function showToast(message) {
  const el = document.getElementById('toast')
  if (!el) return
  el.textContent = message
  el.hidden = false
  clearTimeout(_toastTimer)
  _toastTimer = setTimeout(() => { el.hidden = true }, 2000)
}

/**
 * Push the pure command model onto every [data-cmd] element — bar and menu
 * alike. Enabled/visible have exactly one source of truth: commandItems().
 */
function renderCommands() {
  const items = commandItems({
    mode: _currentMode,
    projectOpen: _projectOpen,
    recording: _audioRecording,
    midiInput: _midiInputName,
    // Electron imports through IPC, the browser through a file input plus
    // IndexedDB. Dead only when neither backend exists.
    canImportPacks: canImportPacks()
  })
  for (const item of items) {
    document.querySelectorAll(`[data-cmd="${item.id}"]`).forEach(el => {
      el.hidden = !item.visible
      if ('disabled' in el) el.disabled = !item.enabled
    })
  }
  const nameEl = document.getElementById('project-name')
  if (nameEl) nameEl.textContent = _projectOpen ? (_projectName || 'Untitled') : 'No Project'
  const dirtyEl = document.getElementById('project-dirty')
  if (dirtyEl) dirtyEl.hidden = !(_projectOpen && _projectDirty)
  const tokenName = document.getElementById('midi-token-name')
  if (tokenName) tokenName.textContent = _midiInputName || ''
}

/** Build the ⋯ popover once. Labels are static; state comes from renderCommands. */
function buildAppMenu() {
  const menu = document.getElementById('app-menu')
  if (!menu) return
  menu.innerHTML = ''
  // Ask the model for the full label set; the bar owns transport and the live
  // MIDI token, so those never appear as menu items.
  const items = commandItems({ mode: 'arrange', projectOpen: true })
    .filter(item => item.group !== 'transport' && item.id !== 'midi-token' && item.id !== 'theme')

  let group = null
  for (const item of items) {
    if (group && item.group !== group) menu.appendChild(Object.assign(document.createElement('div'), { className: 'menu-sep' }))
    group = item.group
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'menu-item'
    btn.setAttribute('role', 'menuitem')
    btn.dataset.cmd = item.id
    const label = document.createElement('span')
    label.textContent = item.label
    const key = document.createElement('span')
    key.className = 'menu-shortcut'
    key.textContent = item.shortcut || ''
    btn.append(label, key)
    btn.addEventListener('click', () => { menu.hidePopover?.(); runCommand(item.id) })
    menu.appendChild(btn)
  }

  // Theme submenu — a select keeps all themes one click away without a
  // second popover layer.
  menu.appendChild(Object.assign(document.createElement('div'), { className: 'menu-sep' }))
  const row = document.createElement('div')
  row.className = 'menu-row'
  const rowLabel = document.createElement('label')
  rowLabel.textContent = 'Theme'
  rowLabel.setAttribute('for', 'theme-select')
  const select = document.createElement('select')
  select.id = 'theme-select'
  select.setAttribute('aria-label', 'Theme')
  for (const theme of THEMES) {
    const opt = document.createElement('option')
    opt.value = theme
    opt.textContent = theme.toUpperCase()
    select.appendChild(opt)
  }
  select.value = savedTheme()
  select.addEventListener('change', () => applyTheme(select.value))
  row.append(rowLabel, select)
  menu.appendChild(row)
}

/** Mixer drawer open/closed. Session state — never written to the project. */
function toggleMixer(force) {
  const bar = document.getElementById('mixer-bar')
  // #mixer-bar lives inside #arrange-view, so toggling it from another view
  // arms a drawer that pops open the next time arrange is shown.
  if (!bar || _currentMode !== 'arrange') return
  const open = force ?? !bar.classList.contains('open')
  bar.classList.toggle('open', open)
  document.getElementById('mixer-toggle-btn')?.setAttribute('aria-pressed', open ? 'true' : 'false')
}

// ─── The armed instrument ──────────────────────────────────────────────────
// One selection: the armed MIDI track's instrument. The slot shows it, the
// knob panel follows it, the pads and keys play it. Nothing in the synth view
// picks a sound any more — the browser does.

function armedTrack() {
  const state = ProjectStore.getState()
  const plan = armPlan(state.tracks, _midiTargetTrackId)
  return plan.provision ? null : state.tracks.find(track => track.id === plan.trackId) || null
}

/** Never null: an empty project still plays and provisions its track on the
 *  first note. Mirrors liveInstrumentFor's own fallback. */
function armedInstrument() {
  const track = armedTrack()
  return track?.instrument || { type: 'palette', paletteKey: track?.paletteKey || 'classic' }
}

/** Rebuild the slot, knobs and pads — but only when the selection really moved. */
function syncInstrumentUi() {
  const track = armedTrack()
  const sig = JSON.stringify([track?.id ?? null, track?.midiChannel ?? null, track?.instrument ?? null])
  if (sig === _slotSig) return
  _slotSig = sig
  renderInstrumentSlot()
  renderKnobPanel()
  Sequencer.setPalette(armedInstrument().paletteKey || 'classic')
  _padGrid?.render()
}

const SLOT_STATE = { ready: '● loaded', unavailable: '○ no audio', missing: '○ missing' }

function renderInstrumentSlot() {
  const nameEl = document.getElementById('slot-name')
  if (!nameEl) return
  const track = armedTrack()
  const instrument = armedInstrument()
  nameEl.textContent = trackInstrumentLabel(instrument, _packCatalog)
  const channelEl = document.getElementById('slot-channel')
  if (channelEl) {
    channelEl.textContent = !track ? 'new track on first note'
      : track.midiChannel == null ? 'omni'
      : 'ch ' + (track.midiChannel + 1)
  }
  const stateEl = document.getElementById('slot-state')
  if (stateEl) {
    const state = instrument.type === 'pack' ? packState(instrument) : 'ready'
    stateEl.textContent = instrument.type === 'pack' ? SLOT_STATE[state] : ''
    stateEl.classList.toggle('slot-warn', state !== 'ready')
  }
}

function initInstrumentSlot() {
  document.getElementById('instrument-slot')?.addEventListener('click', () => {
    ensureAudio()
    runCommand('instrument-browser')
  })
  document.getElementById('instrument-gear')?.addEventListener('click', () => {
    document.dispatchEvent(new CustomEvent('open-instrument-settings'))
  })
}

// The 909 owns its own Bar/Chain transport, so the shared Play is meaningless
// while it is on screen. It is a view now, not a palette, so exactly one
// variable decides: Play belongs to whichever view is active.
function updateGlobalPlayAvailability() {
  // `disabled` is set by renderCommands from commandItems().play.enabled; only
  // the explanation is local.
  renderCommands()
  const btn = document.getElementById('global-play-btn')
  if (!btn) return
  btn.title = _currentMode === 'tr909' ? '909 uses its own Bar/Chain transport' : 'Play (Space)'
}

// ─── Pads ──────────────────────────────────────────────────────────────────
// Pads are input, not a drum kit: a press is a note through the same
// 'midi-event' path as an on-screen key, so routing, sustain, the mixer and
// the armed track all come along for free. They stay visible for every
// instrument.

function padNote(note, on) {
  ensureAudio()
  const target = ensureMidiTrack({ type: 'palette', paletteKey: 'drum' })
  if (!target) return
  const channel = target.midiChannel ?? 0
  const detail = on
    ? { kind: 'note-on', channel, pitch: note, velocity: 108, source: 'pad' }
    : { kind: 'note-off', channel, pitch: note, source: 'pad' }
  document.dispatchEvent(new CustomEvent('midi-event', { detail }))
}

/** An internal drum palette only answers to four GM notes; the rest read unlit
 *  rather than pretending. Every other source is pitch-mapped already. */
function padPlayable(note) {
  const instrument = armedInstrument()
  if (instrument.type !== 'palette') return true
  return paletteAcceptsNote(Palettes[instrument.paletteKey || 'classic'], note)
}

function initPads() {
  const container = document.getElementById('drum-pads')
  if (!container) return
  _padGrid = new PadGrid(container, {
    bankEl: document.getElementById('pad-banks'),
    onPad: padNote,
    isPlayable: padPlayable
  })
}

// The number row triggers pads on the synth view and 909 voices on the 909
// view. Registered per context in initShortcuts() — as raw document listeners
// they also fired while a modal dialog had focus.
const PAD_KEYS = padBank('A').map(pad => pad.key)
const NUMBER_ROW = ['1','2','3','4','5','6','7','8','9','0','-']
const TR909_VOICES = ['bd','sd','lt','mt','ht','rs','cp','ch','oh','cr','rd']

// ─── Knob panel ────────────────────────────────────────────────────────────
// Follows the armed instrument. A pack shows only what is really wired — no
// cutoff knob that changes nothing.
function renderKnobPanel() {
  const panel = document.getElementById('knob-panel')
  if (!panel) return
  panel.innerHTML = ''
  const instrument = armedInstrument()
  if (instrument.type === 'rack') return renderRackPanel(panel, instrument)
  if (instrument.type === 'pack') return renderPackKnobs(panel, instrument)
  renderPaletteKnobs(panel, instrument.paletteKey || 'classic')
}

function renderPaletteKnobs(panel, paletteKey) {
  const p = Palettes[paletteKey] || Palettes.classic

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

  p.knobs.forEach((def, i) => {
    addKnob(panel, def, {
      id: `knob-${paletteKey}-${def.key}`,
      value: p.params[def.key],
      onInput: v => {
        p.params[def.key] = v
        if (def.key === 'reverb') { _reverbAmount = v; AudioEngine.setReverb(v) }
      }
    })
    if (i < p.knobs.length - 1) addDivider(panel)
  })

  // Each palette carries its own reverb default, applied when it becomes the
  // armed sound rather than on a tab click that no longer exists.
  if (AudioEngine.getContext() && p.params?.reverb != null) {
    _reverbAmount = p.params.reverb
    AudioEngine.setReverb(_reverbAmount)
  }
}

/** Only the controls a pack patch really has: mixer level and pan, the master
 *  reverb send, and the bend range the instrument descriptor carries. */
function renderPackKnobs(panel, instrument) {
  const track = armedTrack()
  const channel = ProjectStore.getState().mixer.channels.find(item => item.id === track?.mixerChannelId)
  const send = (param, value) => document.dispatchEvent(new CustomEvent('mixer-param', { detail: { channelId: track.mixerChannelId, param, value } }))

  const rows = []
  if (channel) {
    rows.push({ def: { key: 'level', label: 'Level', min: 0, max: 1.5, step: 0.01, fmt: '' }, value: channel.volume ?? 1, onInput: v => send('volume', v) })
    rows.push({ def: { key: 'pan', label: 'Pan', min: -1, max: 1, step: 0.01, fmt: '' }, value: channel.pan ?? 0, onInput: v => send('pan', v) })
  }
  rows.push({ def: { key: 'reverb', label: 'Reverb', min: 0, max: 1, step: 0.01, fmt: '' }, value: _reverbAmount, onInput: v => { _reverbAmount = v; AudioEngine.setReverb(v) } })
  rows.push({
    def: { key: 'bend', label: 'Bend', min: 0, max: 24, step: 1, fmt: 'st' },
    value: instrument.bendRange ?? 2,
    // On 'change', not 'input': the dispatch rewrites the instrument, which
    // rebuilds this panel — mid-drag that would pull the slider out from
    // under the pointer.
    event: 'change',
    onInput: v => { if (track) ProjectStore.dispatch(SetTrackInstrument(track.id, { ...instrument, bendRange: v })) }
  })

  rows.forEach((row, i) => {
    addKnob(panel, row.def, { id: `knob-pack-${row.def.key}`, value: row.value, onInput: row.onInput, event: row.event })
    if (i < rows.length - 1) addDivider(panel)
  })
}

function renderRackPanel(panel, instrument) {
  const rack = ProjectStore.getState().racks?.[instrument.rackId]
  const note = document.createElement('span')
  note.className = 'knob-note'
  note.textContent = `Rack: ${rack?.name || instrument.rackId}`
  const open = document.createElement('button')
  open.type = 'button'
  open.className = 'knob-open-btn'
  open.textContent = 'OPEN RACK'
  open.addEventListener('click', () => switchMode('rack'))
  panel.append(note, open)
}

/** One slider, one label, one readout — the shape every knob has always had. */
function addKnob(panel, def, { id, value, onInput, event = 'input' }) {
  const group = document.createElement('div')
  group.className = 'knob-group'

  const lbl = document.createElement('label')
  lbl.className = 'knob-label'
  lbl.textContent = def.label
  lbl.setAttribute('for', id)

  const slider = document.createElement('input')
  slider.type = 'range'
  slider.id = id
  slider.className = 'filled'
  slider.min = def.min
  slider.max = def.max
  slider.step = def.step
  slider.value = value

  const valSpan = document.createElement('span')
  valSpan.className = 'knob-val'

  function formatVal(v) {
    const fmt = def.fmt || ''
    if (fmt === 's') return parseFloat(v).toFixed(2) + 's'
    if (fmt === 'Hz') return v >= 1000 ? (v/1000).toFixed(1) + 'k' : Math.round(v) + ''
    if (fmt === 'c') return Math.round(v) + 'c'
    if (fmt === 'st') return Math.round(v) + 'st'
    return parseFloat(v).toFixed(2)
  }

  function updateFill() {
    const pct = (slider.value - slider.min) / (slider.max - slider.min) * 100
    slider.style.setProperty('--fill', pct + '%')
    valSpan.textContent = formatVal(slider.value)
  }

  slider.addEventListener('input', updateFill)
  slider.addEventListener(event, () => onInput(parseFloat(slider.value)))

  updateFill()
  group.append(lbl, slider, valSpan)
  panel.appendChild(group)
}

function addDivider(panel) {
  const div = document.createElement('div')
  div.className = 'knob-divider'
  panel.appendChild(div)
}

// ─── Command bar: BPM, master volume, transport, tokens, ⋯ menu ────────────
function initCommandBar() {
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
    if (_projectOpen && !_projectDirty) { _projectDirty = true; renderCommands() }
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
    syncTransportPressed()
  })
  document.getElementById('global-stop-btn')?.addEventListener('click', () => {
    if (_currentMode === 'arrange') {
      TimelinePlayer.stop()
    } else {
      Sequencer.stop()
    }
    syncTransportPressed()
  })

  // Everything that is not live lives in the ⋯ menu or a dialog.
  buildAppMenu()
  COMMANDS['midi-setup'] = () => openDialog('midi-setup-dialog')
  COMMANDS['mixer'] = () => toggleMixer()
  // No listener yet for these two — the instrument agent wires them.
  COMMANDS['library'] = () => document.dispatchEvent(new CustomEvent('open-library'))
  COMMANDS['instrument-browser'] = () => document.dispatchEvent(new CustomEvent('open-instrument-browser'))

  document.getElementById('midi-token')?.addEventListener('click', () => runCommand('midi-setup'))
  document.getElementById('mixer-toggle-btn')?.addEventListener('click', () => runCommand('mixer'))
  document.querySelectorAll('[data-close-dialog]').forEach(btn => {
    btn.addEventListener('click', () => closeDialog(btn.dataset.closeDialog))
  })

  renderCommands()
}

// ─── Note events (from Keyboard) ───────────────────────────────────────────
// There is one selection: the armed MIDI track. Keys, pads and external MIDI
// all reach it through the same 'midi-event' path.
document.addEventListener('note-on', (e) => {
  const target = ensureMidiTrack()
  if (!target) return
  const channel = target.midiChannel ?? 0
  computerKeyTracks.set(e.detail.note, channel)
  document.dispatchEvent(new CustomEvent('midi-event', { detail: { kind: 'note-on', channel, pitch: e.detail.note, velocity: 108 } }))
})

document.addEventListener('note-off', (e) => {
  const note = e.detail.note
  if (!computerKeyTracks.has(note)) return
  const channel = computerKeyTracks.get(note)
  computerKeyTracks.delete(note)
  document.dispatchEvent(new CustomEvent('midi-event', { detail: { kind: 'note-off', channel, pitch: note } }))
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

// ─── Recorder ───────────────────────────────────────────────────────────────
function pad(n) { return String(n).padStart(2, '0') }

function initRecorder() {
  const btn   = document.getElementById('rec-btn')
  const timer = document.getElementById('rec-timer')
  if (!btn) return

  let interval = null, elapsed = 0

  btn.addEventListener('click', async () => {
    await ensureAudio()
    if (!_audioRecording) {
      if (!AudioEngine.hasRecorder()) {
        showToast('REC NEEDS HTTPS')
        return
      }
      _audioRecording = true
      elapsed = 0
      btn.classList.add('recording')
      btn.setAttribute('aria-pressed', 'true')
      if (timer) { timer.textContent = '00:00'; timer.hidden = false }
      showToast('● RECORDING')
      Recorder.start(AudioEngine.getContext(), AudioEngine.getCompressor())
      interval = setInterval(() => {
        elapsed++
        if (timer) timer.textContent = pad(Math.floor(elapsed / 60)) + ':' + pad(elapsed % 60)
      }, 1000)
    } else {
      _audioRecording = false
      clearInterval(interval)
      btn.classList.remove('recording')
      btn.setAttribute('aria-pressed', 'false')
      if (timer) { timer.hidden = true; timer.textContent = '00:00' }
      showToast('SAVING…')
      const ts = new Date().toISOString().replace('T', '-').replace(/:/g, '-').slice(0, 19)
      try {
        const path = await Recorder.stop('synth-' + ts + '.wav', AudioStore.getProjectDir())
        showToast(path ? `SAVED: ${path}` : 'SAVE CANCELED')
      } catch (error) {
        console.error('Audio recording save failed:', error)
        showToast(`SAVE FAILED: ${error.message}`)
      }
    }
    renderCommands()
  })
}

// ─── Mode switching ──────────────────────────────────────────────────────────
function switchMode(mode) {
  _currentMode = mode
  updateGlobalPlayAvailability()
  // The number row means pads on the synth view and voices on the 909's.
  ShortcutManager.setContext(mode === 'synth' || mode === 'tr909' ? mode : 'global')
  // #app and #arrange-view visibility is CSS, keyed off this attribute.
  // #rack-view is not: RackView owns its own inline display and reads it back
  // (rack-view.js:183), so an inline style would win over any rule here.
  const mainEl = document.getElementById('main')
  if (mainEl) mainEl.dataset.view = mode
  const rackEl = document.getElementById('rack-view')
  syncTransportPressed()   // the two transports have separate running states
  document.querySelectorAll('.tool-btn').forEach(btn => {
    const isActive = btn.dataset.tool === mode
    btn.classList.toggle('active', isActive)
    btn.setAttribute('aria-pressed', isActive ? 'true' : 'false')
  })
  if (mode !== 'tr909') _tr909View?.stop()
  if (mode === 'arrange') {
    // The rack is a sibling of #arrange-view, both flex: 1 — leaving it visible
    // stacks the two views and keeps RackPoll's interval running.
    if (_rackView) _rackView.hide()
    else if (rackEl) rackEl.style.display = 'none'
    startArrangeLoop()
    // Canvas may still be 0×0 if ResizeObserver hasn't fired since the element was hidden.
    // Force a size update on the next frame once the element is laid out.
    requestAnimationFrame(() => {
      if (_arrangementView) _arrangementView._onResize()
    })
  } else if (mode === 'rack') {
    stopArrangeLoop()
    _rackView?.show()
  } else {
    if (_rackView) _rackView.hide()
    else if (rackEl) rackEl.style.display = 'none'
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
  // No per-button disabling here: commandItems() derives every enabled state
  // from _projectOpen, for the bar and the ⋯ menu alike.
  _projectOpen = true
  _projectName = name || 'Untitled'
  _projectDirty = false
  renderCommands()
}

function initProjectCommands() {
  COMMANDS['new'] = (async () => {
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

  COMMANDS['open'] = (async () => {
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

  COMMANDS['save'] = (async () => {
    const handle = AudioStore.getProjectDir()
    if (!handle) return
    await FileAdapter.writeProject(handle, ProjectStore.getState())
    _projectDirty = false
    renderCommands()
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

  COMMANDS['import-audio'] = () => importAudioToTrack(_selectedArrangeTrackId)

  COMMANDS['add-midi-track'] = () => {
    addMidiTrack()
    switchMode('arrange')
  }

  COMMANDS['import-pack'] = (async () => {
    try {
      await importPack()
    } catch (error) {
      alert(`Could not import SoundFont:\n${error.message}`)
    }
  })

  document.addEventListener('add-sample-to-track', (e) => {
    importAudioToTrack(e.detail.trackId)
  })

  COMMANDS['bounce'] = (async () => {
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
  COMMANDS['add-track'] = () => {
    ProjectStore.dispatch(AddTrack('audio', 'Track'))
    syncMixerStrips(ProjectStore.getState())
  }

  // Add Track from arrangement context menu
  document.addEventListener('add-audio-track', () => {
    ProjectStore.dispatch(AddTrack('audio', 'Track'))
    syncMixerStrips(ProjectStore.getState())
  })
  document.addEventListener('add-midi-track', () => {
    addMidiTrack()
  })
}

// ─── MIDI ───────────────────────────────────────────────────────────────────
function updateMidiDeviceSelect(inputs) {
  const sel = document.getElementById('midi-device-select')
  if (!sel) return
  const current = sel.value
  const saved = localStorage.getItem(MIDI_DEVICE_KEY)
  while (sel.options.length > 1) sel.remove(1)
  inputs.forEach(({ id, name }) => {
    const opt = document.createElement('option')
    opt.value = id; opt.textContent = name
    sel.appendChild(opt)
  })
  const preferred = [current, saved].find(id => inputs.some(input => input.id === id))
    || inputs.find(input => !/clock|thru/i.test(input.name || ''))?.id
    || inputs[0]?.id
  sel.value = preferred || ''
  MidiController.selectInput(sel.value)
  syncMidiToken(sel)
}

/** The command bar shows one live MIDI token: a dot plus the device name. */
function syncMidiToken(sel) {
  const option = sel?.options?.[sel.selectedIndex]
  _midiInputName = sel?.value ? (option?.textContent || 'MIDI') : null
  renderCommands()
}

function initMidi() {
  const enableBtn  = document.getElementById('midi-enable-btn')
  const statusEl   = document.getElementById('midi-status')
  const deviceSel  = document.getElementById('midi-device-select')
  const recBtn     = document.getElementById('midi-record-btn')

  if (!enableBtn) return

  const enableMidi = async () => {
    const { granted, inputs, error } = await MidiController.requestAccess()
    if (!granted) {
      if (statusEl) statusEl.textContent = 'MIDI: ' + (error || 'denied')
      return
    }
    if (statusEl) {
      statusEl.textContent = 'MIDI ON'
      statusEl.classList.add('granted')
    }
    enableBtn.style.display = 'none'
    if (deviceSel) deviceSel.style.display = ''
    if (recBtn) recBtn.style.display = ''
    updateMidiDeviceSelect(inputs)
  }

  enableBtn.addEventListener('click', enableMidi)
  // Electron resets Web MIDI access with every renderer restart. Reconnect a
  // previously-approved device so restarting the app cannot silently disable it.
  enableMidi()

  deviceSel?.addEventListener('change', () => {
    MidiController.selectInput(deviceSel.value)
    if (deviceSel.value) localStorage.setItem(MIDI_DEVICE_KEY, deviceSel.value)
    if (recBtn) recBtn.disabled = !deviceSel.value
    syncMidiToken(deviceSel)
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
        midiTrack = addMidiTrack()
        state = ProjectStore.getState()
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

  // Route live MIDI note events → track instruments (routeChannel), falling
  // back to the plain keyboard behaviour when no MIDI tracks exist at all.
  // Sustain (CC64) is resolved before anything else sees the stream: the pure
  // reducer swallows note-offs while a channel is held and flushes them on
  // release, so no instrument has to know the pedal exists.
  document.addEventListener('midi-event', async (e) => {
    const { state, emit } = holdReducer(_holdState, e.detail)
    _holdState = state
    for (const event of emit) await handleMidiEvent(event)
  })

  async function handleMidiEvent(detail) {
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
        // A controller that re-sends its program on connect would otherwise
        // flush the undo stack with dispatches that change nothing.
        const nextPatchId = resolved?.patch?.id || track.instrument.patchId
        const had = track.instrument.received
        if (nextPatchId === track.instrument.patchId && had && !track.instrument.unresolved &&
            had.bankMsb === result.change.bankMsb && had.bankLsb === result.change.bankLsb &&
            had.program === result.change.program) continue
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
    await ensureAudio()
    const ctx = AudioEngine.getContext()
    if (!ctx) return

    // Auto-provision: a note into an empty project makes the track it belongs
    // on, once. Note-offs never provision — they can only follow a note-on.
    if (detail.kind === 'note-on') {
      ensureMidiTrack()
      // A hardware octave button has to be visible: scroll the key window to
      // the note instead of letting it disappear. Pads send percussion notes
      // that have nothing to do with the keys, so they are exempt.
      // Channel 10 is percussion: its note numbers are drum slots, not pitches.
      if (detail.source !== 'pad' && detail.channel !== 9) Keyboard.ensureVisible(detail.pitch)
    }
    const state = ProjectStore.getState()
    const midiTracks = state.tracks.filter(t => t.type === 'midi')

    // Prune instruments for tracks that no longer exist.
    for (const [trackId, entry] of [..._liveInstruments]) {
      if (!state.tracks.some(t => t.id === trackId)) {
        entry.inst.dispose()
        _liveInstruments.delete(trackId)
      }
    }

    const routeKey = `${detail.channel}:${detail.pitch}`
    const ids = detail.kind === 'note-off'
      ? (_soundingRoutes.get(routeKey) || routeChannel(midiTracks, detail.channel, _midiTargetTrackId))
      : routeChannel(midiTracks, detail.channel, _midiTargetTrackId)
    if (detail.kind === 'note-on') _soundingRoutes.set(routeKey, ids)
    else if (detail.kind === 'note-off') _soundingRoutes.delete(routeKey)

    for (const trackId of ids) {
      const track = state.tracks.find(t => t.id === trackId)
      if (!track) continue

      // The output node is baked into the instrument at build time, so a move
      // to another mixer channel has to invalidate it too.
      const sig = JSON.stringify([track.instrument ?? null, track.mixerChannelId ?? null])
      let entry = _liveInstruments.get(trackId)
      if (entry && entry.sig !== sig) {
        entry.inst.dispose()
        _liveInstruments.delete(trackId)   // the rebuild below may return null
        entry = null
      }
      if (!entry) {
        const output = MixerEngine.getOutput(track.mixerChannelId) || AudioEngine.getMasterInput()
        const inst = liveInstrumentFor(track, instrumentDeps({ output, trackId: track.id }))
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
  }

  // Keep device list in sync when devices connect/disconnect
  document.addEventListener('midi-device-change', (e) => {
    // Fires on connect, disconnect and port open alike. Only a device that
    // actually went away can be holding notes nothing can release — plugging
    // a second controller in mid-performance must not cut the first one off.
    const selected = deviceSel?.value
    if (selected && !e.detail.inputs.some(input => input.id === selected)) disposeLiveInstruments()
    updateMidiDeviceSelect(e.detail.inputs)
  })

  // Listen for selected track changes to auto-arm MIDI record to it
  document.addEventListener('track-selected', (e) => {
    const state = ProjectStore.getState()
    const track = state.tracks.find(t => t.id === e.detail.trackId)
    if (track && track.type === 'midi') {
      _midiTargetTrackId = track.id
      syncInstrumentUi()
      if (recBtn && MidiController.isGranted() && deviceSel?.value) {
        recBtn.disabled = false
      }
    }
  })
}

// ─── Piano Roll ──────────────────────────────────────────────────────────────
function initPianoRoll() {
  const drawer    = document.getElementById('piano-roll-dialog')
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

  // Escape, the focus trap and the context/focus restore are the dialog kit's
  // job now — closeDialog only has to close.
  closeBtn?.addEventListener('click', () => closeDialog('piano-roll-dialog'))

  // Open on double-click from arrangement view
  document.addEventListener('open-piano-roll', (e) => {
    const { trackId, clipId, clipName } = e.detail
    if (nameEl) nameEl.textContent = clipName || 'clip'
    openDialog('piano-roll-dialog', { context: 'pianoroll' })
    _pianoRoll.open(trackId, clipId)
    // The container was 0×0 while the dialog was closed; ResizeObserver fires
    // on show, but kick it once the modal is actually laid out.
    requestAnimationFrame(() => _pianoRoll._onResize())
    // Focus the close button for keyboard users
    closeBtn?.focus()
  })

  // Piano roll shortcut keys (only active in pianoroll context)
  ShortcutManager.register({ key: 'd', context: 'pianoroll' }, () => setPrTool('draw'))
  ShortcutManager.register({ key: 's', context: 'pianoroll' }, () => setPrTool('select'))
  ShortcutManager.register({ key: 'e', context: 'pianoroll' }, () => setPrTool('erase'))
}

// ─── Shortcuts ────────────────────────────────────────────────────────────────
/** True while either transport is actually running — never a shadow copy. */
function isTransportPlaying() {
  return _currentMode === 'arrange' ? TimelinePlayer.isPlaying() : Sequencer.isPlaying()
}

/** Play's pressed state is derived, so a disabled button cannot desync it. */
function syncTransportPressed() {
  document.getElementById('global-play-btn')?.setAttribute('aria-pressed', isTransportPlaying() ? 'true' : 'false')
}

/** A modal owns the keyboard: global shortcuts must not fire behind it. */
function modalOpen() {
  return !!document.querySelector('dialog[open]')
}

function initShortcuts() {
  ShortcutManager.init()

  // Undo / Redo
  ShortcutManager.register({ key: 'z', ctrl: true },              () => ProjectStore.undo())
  ShortcutManager.register({ key: 'z', ctrl: true, shift: true }, () => ProjectStore.redo())
  ShortcutManager.register({ key: 'y', ctrl: true },              () => ProjectStore.redo())

  // Project
  ShortcutManager.register({ key: 's', ctrl: true }, () => runCommand('save'))
  ShortcutManager.register({ key: 'n', ctrl: true, shift: true }, () => runCommand('new'))
  ShortcutManager.register({ key: 'o', ctrl: true, shift: true }, () => runCommand('open'))

  // Dialogs and drawers — every one is also in the ⋯ menu.
  ShortcutManager.register({ key: 'm', ctrl: true },              () => runCommand('midi-setup'))
  ShortcutManager.register({ key: 'b', ctrl: true },              () => runCommand('bounce'))
  ShortcutManager.register({ key: 'l', ctrl: true, shift: true }, () => runCommand('library'))
  ShortcutManager.register({ key: 'i', ctrl: true },              () => runCommand('instrument-browser'))
  ShortcutManager.register({ key: 'm', ctrl: true, shift: true }, () => { if (!modalOpen()) runCommand('mixer') })

  // Number row: pads on the synth view, 909 voices on the 909 view. Bound to
  // a context so a modal dialog never swallows them.
  PAD_KEYS.forEach((key, idx) => {
    ShortcutManager.register({ key, context: 'synth' }, (e) => {
      if (!e.repeat) _padGrid?.trigger(idx + 1)
    })
  })
  NUMBER_ROW.forEach((key, idx) => {
    ShortcutManager.register({ key, context: 'tr909' }, (e) => {
      if (!e.repeat) _tr909View?.trigger(TR909_VOICES[idx], 0.9)
    })
  })
  ShortcutManager.setContext(_currentMode === 'synth' || _currentMode === 'tr909' ? _currentMode : 'global')

  // Mode switching. Blocked behind a modal: switchMode() rewrites the shortcut
  // context, which the dialog would then restore on top of when it closes.
  for (const [key, mode] of [['f1', 'synth'], ['f2', 'arrange'], ['f3', 'rack'], ['f4', 'tr909']]) {
    ShortcutManager.register({ key }, () => { if (!modalOpen()) switchMode(mode) })
  }

  // Transport — Space = play/stop toggle (mode-aware)
  ShortcutManager.register({ key: ' ' }, (e) => {
    if (modalOpen()) return
    // Space is also "activate" for a focused control; the transport must not
    // steal it from a button the user tabbed to.
    const tag = document.activeElement?.tagName
    if (tag === 'BUTTON' || tag === 'A' || tag === 'SUMMARY') {
      document.activeElement.click()
      return
    }
    const playBtn = document.getElementById('global-play-btn')
    const stopBtn = document.getElementById('global-stop-btn')
    if (isTransportPlaying()) stopBtn?.click()
    else playBtn?.click()
    syncTransportPressed()
  })

  // Stop always resets
  ShortcutManager.register({ key: ' ', shift: true }, () => {
    if (modalOpen()) return
    document.getElementById('global-stop-btn')?.click()
    syncTransportPressed()
  })
}

// Legacy alias (kept for boot() call site)
function initUndoRedo() { /* migrated to initShortcuts */ }

// ─── Bootstrap ─────────────────────────────────────────────────────────────
function boot() {
  applyTheme(savedTheme())
  Keyboard.render('keyboard')
  initPads()
  Sequencer.init('seq-tracks')
  Sequencer.setPalette(armedInstrument().paletteKey || 'classic')
  const tr909Container = document.getElementById('tr909-view')
  if (tr909Container) _tr909View = new Tr909View(tr909Container, { ensureAudio })

  renderInstrumentSlot()
  renderKnobPanel()
  initCommandBar()
  initTransport()
  initInstrumentSlot()
  initRecorder()

  // Init audio on first click anywhere (required by browsers)
  document.body.addEventListener('click', ensureAudio, { once: false })
  document.body.addEventListener('keydown', ensureAudio, { once: false })

  initProjectCommands()
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
  _instrumentSettings = new InstrumentSettings({
    store: ProjectStore,
    packCatalog: () => _packCatalog,
    warmPack: (pack, patch) => warmPack(pack, patch).catch(() => {})
  })
  _instrumentBrowser = new InstrumentBrowser({
    store: ProjectStore,
    packCatalog: () => _packCatalog,
    // tr909 is the 909 editor's own transport, not a playable voice.
    palettes: () => Object.fromEntries(Object.entries(Palettes).filter(([key]) => key !== 'tr909')),
    racks: () => ProjectStore.getState().racks,
    auditioner: _auditioner,
    ensureTrack: ensureMidiTrack,
    addTrack: () => addMidiTrack(),
    packState,
    openSettings: trackId => document.dispatchEvent(new CustomEvent('open-instrument-settings', { detail: { trackId } }))
  })
  _libraryDialog = new LibraryDialog({
    packCatalog: () => _packCatalog,
    canImport: canImportPacks,
    importPack: onProgress => importPack(onProgress),
    // Electron packs live on disk and the IPC has no delete; only browser
    // packs can be removed from here.
    removePack: async pack => {
      if (pack.origin !== 'idb') return
      await webPackStore()?.removePack(pack.id, pack.version)
      await refreshPackCatalog()
    },
    usage: () => webPackStore()?.usage() ?? null
  })
  document.addEventListener('open-instrument-browser', () => _instrumentBrowser.open())
  document.addEventListener('open-library', () => _libraryDialog.open())
  document.addEventListener('open-instrument-settings', e => _instrumentSettings.open(e.detail?.trackId ?? ensureMidiTrack()?.id))

  const rackContainer = document.getElementById('rack-view')
  if (rackContainer) _rackView = new RackView(rackContainer, {
    hasWorklet: () => AudioEngine.hasWorklet(),
    getAudioContext: () => AudioEngine.getContext(),
    getMasterInput: () => AudioEngine.getMasterInput()
  })

  // Subscribe store to keep mixer in sync
  ProjectStore.subscribe(state => {
    syncMixerStrips(state)
    syncInstrumentUi()
    // A removed track must go quiet immediately. Pruning only inside the MIDI
    // handler left a deleted track sounding until the next incoming event —
    // with no controller attached, forever.
    for (const [trackId, entry] of [..._liveInstruments]) {
      if (state.tracks.some(track => track.id === trackId)) continue
      try { entry.inst.dispose() } catch (err) {}
      _liveInstruments.delete(trackId)
    }
  })
  refreshPackCatalog().catch(error => console.warn('Could not load instrument packs:', error))
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot)
} else {
  boot()
}
