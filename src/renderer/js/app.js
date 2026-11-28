/**
 * app.js
 * Entry point. Wires AudioEngine, Palettes, Keyboard, and Sequencer together.
 * Handles palette switching, knob panel, and transport controls.
 */
import AudioEngine from './audio-engine.js'
import Palettes, { paletteDefaults } from './palettes.js'
import Keyboard from './keyboard.js'
import Sequencer from './sequencer.js'
import Recorder from './recorder.js'
import ProjectStore, { AddTrack, AddClip, SetMixerParam, SetBpm, RemoveTrack, SetTrackInstrument, SetTrackInstrumentProgram, SetInstrumentParam, DEFAULT_PADS, SetPadsSettings, SetKitSlot, SeedKit, SetTrackFlashAssets } from './store/ProjectStore.js'
import RackEngine from './rack/rack-engine.js'
import { routeChannel } from './midi/midi-routing.js'
import { holdReducer } from './midi/midi-hold.js'
import { createTakeRecorder } from './midi/take-recorder.js'
import { liveInstrumentFor, paletteAcceptsNote, kitAcceptsNote } from './midi/live-instrument.js'
import FileAdapter from './io/FileAdapter.js'
import { pickAudioFile } from './io/audio-picker.js'
import AudioStore from './audio-store.js'
import { ArrangementView } from './components/arrangement-view.js'
import { MixerStrip } from './components/mixer-strip.js'
import MixerEngine from './audio/mixer-engine.js'
import TimelinePlayer, { instrumentFor as scheduledInstrumentFor, preloadKitSamples } from './playback/timeline-player.js'
import MidiController from './midi/MidiController.js'
import { groupInputs } from './midi/device-group.js'
import { createSmcPadLink } from './pads/smc-pad-link.js'
import { kitFor, padColours, DEFAULT_KIT_ID, sampleSlot, sliceSlots } from './pads/kit.js'
import { missesOf } from './pads/kit-voices.js'
import { createUserSamples, userSampleStoreFor } from './instruments/user-samples.js'
import { createSliceDialog } from './components/slice-dialog.js'
import { checkSampleFile, padEndSec, slotCommands, samplePadsOf, tooShort, MAX_SLICE_SEC, MAX_PAD_BYTES } from './pads/sample-drop.js'
import { mono, trimEnd } from './pads/slicer.js'
import { createLoopPlayer } from './pads/loop-player.js'
import { createPadsSession, canRecordHit } from './pads/pads-session.js'
import { playClick } from './pads/click.js'
import { createRepeatEngine } from './pads/repeat-engine.js'
import { REPEAT_RATES } from './pads/repeat.js'
import { createLedMirror } from './pads/led-mirror.js'
import { createControllerRouter } from './pads/controller-router.js'
import { createControllerLearn, loadOverrides, safeStorage } from './components/controller-learn-dialog.js'
import { padOf } from './pads/profile.js'
import { SMC_PAD } from './pads/profiles/smc-pad.js'
import { shapeHit } from './pads/hit-shape.js'
import { PianoRoll } from './components/piano-roll.js'
import { Tr909View } from './components/tr909-view.js'
import { PadsView, PAD_KEY_ROWS } from './components/pads-view.js'
import { RackView } from './components/rack-view.js'
import { InstrumentBrowser } from './components/instrument-browser.js'
import { InstrumentSettings } from './components/instrument-settings.js'
import { LibraryDialog } from './components/library-dialog.js'
import { AssistantDialog } from './components/assistant-dialog.js'
import ShortcutManager from './shortcuts.js'
import { applyTheme, savedTheme, THEMES } from './theme.js'
import { commandItems } from './ui/command-model.js'
import { createLessonSession } from './pads/lesson-session.js'
import { createLessonCard } from './components/lesson-card.js'
import { openDialog, closeDialog } from './ui/dialog.js'
import { applyChannelMidi } from './instruments/channel-program.js'
import { compilePackManifest, resolvePatch, packPatchState } from './instruments/pack-registry.js'
import { createSampleStore } from './instruments/sample-store.js'
import { createPackStore } from './instruments/pack-store-idb.js'
import { importPackFromFile, pickFile } from './instruments/pack-import-web.js'
import { canBrowseFolders, createFolderLibrary } from './instruments/soundfont-folder-web.js'
import { createAuditioner } from './instruments/auditioner.js'
import { createFm1Sessions } from './fm1/session-manager.js'
import { createFirmwareStore } from './fm1/firmware-store.js'
import { libraryRows } from './fm1/catalog.js'
import { fm1Descriptor, failureText } from './fm1/descriptor.js'
import { saveProject, flashReader, anyFlashDirty, exportDeviceState, importDeviceState, resetDeviceState, flashReasonText, deviceChanges, trackedFm1 } from './fm1/project-flash.js'
import { EXPORT_EXT } from './fm1/flash-asset.js'
import { createFm1DeviceDialog } from './components/fm1-device-dialog.js'
import { createFm1RecordDialog } from './components/fm1-record-dialog.js'
import { createFm1RecordFlow } from './fm1/record-flow.js'
import { isActive as fm1RecordActive } from './fm1/record-take.js'
import { newId } from './utils/new-id.js'
import { encodeWAV, interleaveToI16 } from './utils/wav-encoder.js'
import { armPlan } from './instruments/arm-track.js'
import { trackInstrumentLabel } from './instruments/instrument-label.js'
import { PadGrid } from './components/pad-grid.js'
import { padBank } from './instruments/pad-map.js'
import { audioTimeFor } from './utils/midi-clock.js'
import { applyKnob } from './pads/knob-roles.js'

// ─── Per-type directory memory ────────────────────────────────────────────────
const DIR_KEY_PROJECT = 'synth_lastProjectDir'
const DIR_KEY_AUDIO   = 'synth_lastAudioDir'
const MIDI_DEVICE_KEY = 'synth_midi_input'

// Same gate as webDiscovery(): the Access-protected https host has
// /api/assistant, and Electron carries its own IPC transport (dawAssistant
// preload bridge) regardless of host.
function assistantAvailable() {
  return (location.protocol === 'https:' && location.hostname === 'synth.zakharhome.org') || !!window.dawAssistant
}

function webDiscovery() {
  if (location.protocol !== 'https:' || location.hostname !== 'synth.zakharhome.org') return null
  const listeners = new Set()
  const requests = new Map()
  const emit = event => listeners.forEach(listener => listener(event))
  return {
    browser: true,
    available: async () => true,
    onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    run(brief) {
      const runId = newId()
      const controller = new AbortController()
      requests.set(runId, controller)
      queueMicrotask(async () => {
        try {
          const response = await fetch('/api/music-discovery', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...brief, sources: ['web'] }), signal: controller.signal })
          const data = await response.json().catch(() => ({}))
          if (!response.ok) throw new Error(data.error || 'Search unavailable')
          emit({ runId, type: 'final', candidates: Array.isArray(data.candidates) ? data.candidates.slice(0, 5) : [] })
        } catch (error) {
          if (requests.has(runId)) emit({ runId, type: 'error', message: error instanceof Error ? error.message : 'Search unavailable' })
        } finally { requests.delete(runId) }
      })
      return runId
    },
    cancel(runId) { requests.get(runId)?.abort(); requests.delete(runId) },
    async listLeads() {
      const response = await fetch('/api/music-discovery/leads')
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || 'Saved leads unavailable')
      return Array.isArray(data.leads) ? data.leads : []
    },
    async saveLead(lead) {
      const response = await fetch('/api/music-discovery/leads', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(lead) })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || 'Could not save lead')
      return data.lead
    },
    open(candidate) {
      try {
        const url = new URL(candidate?.sourceUrl)
        if (url.protocol === 'https:' || url.protocol === 'http:') window.open(url.href, '_blank', 'noopener')
      } catch { /* source was rejected */ }
    }
  }
}
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

// A melodic octave plus every note the pad banks can send. A drum patch keeps
// one zone per pad, so warming only 48/60/72 left the first strike of each pad
// waiting on an IndexedDB read — audible as a late first hit, every pad.
const WARM_NOTES = [...new Set([48, 60, 72, ...padBank('A').map(pad => pad.note), ...padBank('B').map(pad => pad.note)])]

async function warmPack(pack, patch) {
  await ensureAudio()
  const ctx = AudioEngine.getContext(), store = pack && ctx && sampleStoreFor(pack, ctx)
  const ids = [...new Set(WARM_NOTES.flatMap(note => patch?.zones
    ?.filter(item => note >= item.keyLo && note <= item.keyHi && 100 >= (item.velocityLo ?? 0) && 100 <= (item.velocityHi ?? 127))
    .map(item => item.sampleId) || []))]
  if (store && ids.length) await store.preload(ids)
}

// ─── FM-1 devices ──────────────────────────────────────────────────────────
// One emulated device per track, owned by the session manager (created on first
// use, once the AudioContext exists) so live play, the timeline and the device
// panel share it. The firmware store is shared with the library dialog.
const _fm1 = { store: null, sessions: null, module: null, dialog: null, installed: [], rows: [], compat: new Map(), tracked: new Map(), loaded: false, seed: null, saveCommit: false }

function fm1Store() { return _fm1.store ??= createFirmwareStore() }

/** Fetch + compile the pinned wasm once: sessions get the compiled Module, and the bytes for the worklet path. A failure is not cached. */
function fm1Wasm() {
  return _fm1.module ??= (async () => {
    const response = await fetch(new URL('fm1/fm1_web.wasm', document.baseURI))
    if (!response.ok) throw new Error(`fm1 wasm ${response.status}`)
    const bytes = await response.arrayBuffer()
    return { bytes, module: await WebAssembly.compile(bytes) }
  })().catch(error => { _fm1.module = null; throw error })
}

function fm1Sessions() {
  const ctx = AudioEngine.getContext()
  if (!ctx) return undefined
  return _fm1.sessions ??= createFm1Sessions({
    ctx,
    getModule: async () => (await fm1Wasm()).module,
    getWasmBytes: async () => (await fm1Wasm()).bytes,
    readFirmware: async id => (await fm1Store().read(id))?.slice(0) ?? null,
    // The track's saved device state, from the open project folder (the session decodes it).
    readFlash: flashReader({ getDir: () => AudioStore.getProjectDir(), readFm1Flash: (dir, name) => FileAdapter.readFm1Flash(dir, name) }),
    // No preferWorklet: every device runs on the Worker path. One Felucca at 120 MHz takes 75-100%
    // of the audio rendering thread (rtf 1.2-1.4 in Electron), and a saturated render thread stops
    // delivering port messages to the worklet, so MIDI and the LCD request never arrive: a silent
    // device with a black LCD. See the fm1-session test "the app default…".
    workletUrl: new URL('worklets/fm1-worklet.js', document.baseURI).href,
    now: () => performance.now()
  })
}

/** Reload the installed-firmware list and catalog compat. Resolves true when it changed. */
async function refreshFm1Cache() {
  _fm1.loaded = true
  try {
    const [installed, catalogs] = await Promise.all([fm1Store().list(), fm1Store().getCatalogs()])
    _fm1.seed ??= (await import('./fm1/seed-catalog.json')).default
    const rows = libraryRows({ catalogs: [...catalogs, _fm1.seed], installed })
    const compat = new Map(rows.filter(row => row.installedId && row.compat).map(row => [row.installedId, row.compat]))
    const changed = JSON.stringify([installed.map(record => [record.id, record.name]), [...compat], rows.map(row => row.key)])
      !== JSON.stringify([_fm1.installed.map(record => [record.id, record.name]), [..._fm1.compat], _fm1.rows.map(row => row.key)])
    _fm1.installed = installed
    _fm1.rows = rows
    _fm1.compat = compat
    if (changed) { renderInstrumentSlot(); _instrumentBrowser?.refresh(); _arrangementView?.render() }
    return changed
  } catch (error) {
    console.warn('Could not read FM-1 firmware:', error)
    return false
  }
}

/** Arguments for TimelinePlayer.play from the current project; shared by the Play button and FM-1 recording. */
function arrangePlayArgs(beat) {
  const state = ProjectStore.getState()
  return {
    beat,
    bpm: state.bpm,
    tracks: state.tracks,
    audioStore: AudioStore,
    mixerEngine: MixerEngine,
    palettes: Palettes,
    racks: state.racks,
    kits: state.kits,
    packFor,
    sampleStoreFor,
    rackHandles: [_rackView?.getEngineHandle()].filter(Boolean),
    fm1Sessions: fm1Sessions(),
    notify: showToast
  }
}

let _fm1Rec = null
function fm1Record() {
  if (_fm1Rec) return _fm1Rec
  const fm1Tracks = () => _hot.midiTracks.filter(track => track.instrument?.type === 'fm1')
  const flow = createFm1RecordFlow({
    sessions: { get: id => { const track = _hot.byId.get(id); if (track) liveEntryFor(track); return fm1Sessions()?.get(id) ?? null } },
    timeline: {
      prepare: async () => {
        const state = ProjectStore.getState()
        await preloadKitSamples(userSampleStoreFor(AudioEngine.getContext()), state.tracks, state.kits)
      },
      play: ({ beat, bpm, endBeat }) => {
        // FM-1 notes go 1.5 s ahead: a background window holds timers ~1 s, which cut the first notes of a take
        const started = TimelinePlayer.play({ ...arrangePlayArgs(beat), bpm, endBeat, fm1Lookahead: 1.5 })
        syncTransportPressed()
        return typeof started === 'number' ? started : TimelinePlayer.startAudioTime
      },
      stop: options => { TimelinePlayer.stop(options); syncTransportPressed() }
    },
    store: ProjectStore,
    getTrack: id => _hot.byId.get(id) ?? null,
    files: { saveRecording: (...args) => FileAdapter.saveRecording(...args), exportWav: exportWavOrDownload },
    audioStore: AudioStore,
    encode: (L, R, rate) => encodeWAV(interleaveToI16(L, R), rate, 2),
    time: () => AudioEngine.getContext().currentTime,
    now: () => new Date(),
    bpm: () => ProjectStore.getState().bpm,
    beatsPerBar: () => _hot.beatsPerBar,
    newId,
    commands: { AddTrack, AddClip, SetMixerParam },
    notify: showToast
  })
  const dialog = createFm1RecordDialog({
    flow,
    getTracks: () => fm1Tracks().map(track => ({ id: track.id, name: track.name })),
    armedId: () => _hot.armedId
  })
  return (_fm1Rec = { flow, dialog })
}

/** True while an FM-1 recording owns the transport (arming, recording, tail, saving). */
const fm1Recording = () => !!_fm1Rec && fm1RecordActive(_fm1Rec.flow.state().phase)

/** Save-as for a WAV: the native picker (Electron dialog / showSaveFilePicker), or a plain download
 *  where neither exists (the LAN http route). Resolves null when the user cancelled. */
async function exportWavOrDownload(bytes, name) {
  if (window.electronFS || typeof window.showSaveFilePicker === 'function') return FileAdapter.exportWav(bytes, name)
  const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }))
  const link = Object.assign(document.createElement('a'), { href: url, download: name })
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 60000)
  return name
}

// Transport — mode-aware: drives Sequencer in synth mode, TimelinePlayer in arrange mode. An FM-1
// recording owns the transport: Play is ignored (checked again after every await, a recording may
// have started meanwhile), Stop is the record dialog's Stop. In arrange, resolves with the audible
// start time TimelinePlayer.play() returns (the MIDI take's anchor). An open MIDI take owns it too.
async function transportPlay() {
  if (fm1Recording() || midiTakeOpen()) return
  await ensureAudio()
  if (fm1Recording()) return
  if (_currentMode === 'arrange') {
    const state = ProjectStore.getState()
    // Decode every kit track's samples first: otherwise each one's first hit is silent.
    await preloadKitSamples(userSampleStoreFor(AudioEngine.getContext()), state.tracks, state.kits)
    if (fm1Recording()) return
    const started = TimelinePlayer.play(arrangePlayArgs(0))
    syncTransportPressed()
    return started
  } else if (_currentMode === 'pads') {
    startPadsLoop()
  } else {
    Sequencer.play()
  }
  syncTransportPressed()
}

function transportStop() {
  if (fm1Recording()) return fm1RecordStop()
  if (midiTakeOpen()) return stopMidiTake()
  if (_currentMode === 'arrange') {
    TimelinePlayer.stop()
  } else if (_currentMode === 'pads') {
    stopPadsLoop()
  } else {
    Sequencer.stop()
  }
  syncTransportPressed()
}

/** Transport Stop during an FM-1 recording: recording -> the dialog's Stop (keeps the take);
 *  arming -> cancel with a message; tail/saving -> nothing to stop, the dialog shows where it is. */
function fm1RecordStop() {
  const { flow, dialog } = _fm1Rec
  flow.transportStop()
  if (dialog && !dialog.isOpen()) dialog.open()
}

async function openFm1Record() {
  // One recording owns the transport at a time.
  if (midiTakeOpen()) return showToast('STOP MIDI RECORDING FIRST')
  await ensureAudio()
  return fm1Record().dialog?.open()
}

async function openFm1Device(trackId) {
  await ensureAudio()
  _fm1.dialog ??= createFm1DeviceDialog({
    getSession: id => { const track = _hot.byId.get(id); if (track) liveEntryFor(track); return _fm1.sessions?.get(id) ?? null },
    getTrack: id => _hot.byId.get(id) ?? null,
    trackNumber: id => ProjectStore.getState().tracks.findIndex(t => t.id === id) + 1 || null,
    compatFor: hash => _fm1.compat.get(hash) ?? null,
    flash: fm1FlashActions()
  })
  const opened = _fm1.dialog?.open(trackId)
  refreshFm1Cache().then(changed => { if (changed && _fm1.dialog?.isOpen()) _fm1.dialog.open(trackId) })
  return opened
}

const MAX_FLASH_FILE = 2 * 1024 * 1024   // a full 1 MiB flash diff is ~1.03 MiB encoded

/** The device dialog's saved-state actions: reset to firmware defaults, Export / Import device state. */
function fm1FlashActions() {
  const trackOf = id => ProjectStore.getState().tracks.find(t => t.id === id && t.instrument?.type === 'fm1') ?? null
  return {
    hasFolder: () => !!AudioStore.getProjectDir(),
    reset(id) {
      resetDeviceState(id, {
        dispatch: command => ProjectStore.dispatch(command),
        reacquire: trackId => {
          const track = trackOf(trackId)
          if (track) fm1Sessions()?.acquire(trackId, fm1Descriptor(track.instrument), MixerEngine.getOutput(track.mixerChannelId) || AudioEngine.getMasterInput())
        }
      })
      _fm1.dialog?.refresh()
    },
    async exportState(id) {
      const track = trackOf(id)
      const result = await exportDeviceState(_fm1.sessions?.get(id) ?? null, track?.instrument.firmwareHash)
      if (!result.ok) return showToast(`Export failed: ${flashReasonText(result.reason)}`)
      const name = `${(track.name || 'fm1').replace(/[^\w-]+/g, '_')}${EXPORT_EXT}`
      const url = URL.createObjectURL(new Blob([result.bytes], { type: 'application/octet-stream' }))
      Object.assign(document.createElement('a'), { href: url, download: name }).click()
      setTimeout(() => URL.revokeObjectURL(url), 60000)
    },
    async importState(id) {
      if (fm1Recording()) return showToast('Import failed: stop the FM-1 recording first')
      const file = await pickFile(EXPORT_EXT)
      if (!file) return
      if (file.size > MAX_FLASH_FILE) return showToast('Import failed: not a device state file')
      const track = trackOf(id)
      try {
        const result = await importDeviceState(_fm1.sessions?.get(id) ?? null, new Uint8Array(await file.arrayBuffer()), track?.instrument.firmwareHash)
        showToast(result.ok ? 'Device state imported' : `Import failed: ${flashReasonText(result.reason)}`)
      } catch (e) {
        // a running device keeps running with its previous state (session trialImport)
        showToast(`Import failed: ${failureText(e?.message)} The device keeps its previous state.`)
      }
    }
  }
}

/**
 * Release the device of a track that was removed or whose descriptor changed; re-boot one whose
 * saved state moved by undo / redo / reset (not by a save's own commit, _fm1.saveCommit), so it
 * runs the project's state or fails visibly. Runs before the live entry rebuilds.
 */
function pruneFm1(state) {
  const live = trackedFm1(state)
  const { release, reboot } = deviceChanges(_fm1.tracked, live, { saveCommit: _fm1.saveCommit })
  _fm1.tracked = live
  for (const id of release) _fm1.sessions?.release(id)
  for (const id of reboot) {
    if (!_fm1.sessions?.get(id)) continue   // never booted: the next use boots from the new state
    const track = state.tracks.find(t => t.id === id)
    _fm1.sessions.release(id)
    _fm1.sessions.acquire(id, fm1Descriptor(track.instrument), MixerEngine.getOutput(track.mixerChannelId) || AudioEngine.getMasterInput())
      .ready.catch(error => { if (error?.message !== 'disposed') showToast(`FM-1: ${failureText(error?.message)}`) })
  }
}

/** A project switch ends every device of the old project. */
function disposeFm1() {
  _fm1Rec?.flow.abort('The project changed, so the recording was cancelled.')
  _fm1.sessions?.disposeAll()
  _fm1.tracked.clear()
  _prewarmSig = null   // the same track ids may come back (re-Open): their devices must boot again
}
// Leaving the page ends every device too: Workers and worklet nodes must not outlive it.
// (Pagehide, not beforeunload: it also fires on bfcache entry and mobile tab discard.)
window.addEventListener('pagehide', disposeFm1)

/** Deps for instrumentFor/liveInstrumentFor — one shape, every call site, so
 *  an audition cannot be built differently from the thing it auditions. */
function instrumentDeps({ output, trackId } = {}) {
  const ctx = AudioEngine.getContext()
  const out = output || AudioEngine.getMasterInput()
  return {
    palettes: Palettes,
    ctx,
    output: out,
    racks: _hot.racks,
    kits: _hot.kits,
    getKits: () => _hot.kits,
    packFor,
    sampleStoreFor,
    userSampleStoreFor,
    onStatus: trackId ? status => sampleStatus(trackId, status) : undefined,
    fm1Sessions: fm1Sessions(),
    trackId,
    currentInstrument: trackId ? () => _hot.byId.get(trackId)?.instrument : undefined,
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

/** 'ready' | 'unavailable' | 'missing' for a pack instrument descriptor.
 *  A pack is only playable from the origin it was installed to, so the sample
 *  loader answers this — asking for Electron alone called every browser pack
 *  unavailable. */
function packState(instrument) {
  return packPatchState(packFor(instrument.packId, instrument.packVersion), instrument.patchId, sampleLoaderFor)
}

function addMidiTrack(name = 'MIDI', instrument) {
  ProjectStore.dispatch(AddTrack('midi', name))
  const track = ProjectStore.getState().tracks.at(-1)
  if (track && instrument) ProjectStore.dispatch(SetTrackInstrument(track.id, instrument))
  if (track) _midiTargetTrackId = track.id
  refreshHot()
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
  refreshHot()
  syncInstrumentUi()
  return ProjectStore.getState().tracks.find(track => track.id === plan.trackId)
}

// ─── Live hot path ─────────────────────────────────────────────────────────
// ProjectStore.getState() deep-clones, so the MIDI handler must not call it per
// hit. This snapshot is rebuilt when the store or the armed track changes and
// holds the store's own (read-only) track objects.
const _hot = { midiTracks: [], byId: new Map(), sigs: new Map(), armedId: null, racks: undefined, kits: undefined, pads: DEFAULT_PADS, bpm: 120, beatsPerBar: 4 }
let _prewarmSig = null

/** A kit's signature for instrument rebuilds: slot `perf` (knob layer) is read live, so it must not move the signature. */
const kitSig = kit => kit && { ...kit, slots: Object.fromEntries(Object.entries(kit.slots ?? {}).map(([n, { perf, ...def }]) => [n, def])) }

const withoutFlashId = instrument => {
  if (instrument?.type !== 'fm1') return instrument
  const { flashAssetId, ...rest } = instrument
  return rest
}

function refreshHot(state = ProjectStore.getState()) {
  _hot.midiTracks = state.tracks.filter(track => track.type === 'midi')
  _hot.byId = new Map(_hot.midiTracks.map(track => [track.id, track]))
  // The output node is baked into the instrument at build time, so a move to
  // another mixer channel has to invalidate it too.
  // flashAssetId moves on every project save; the adapter reads the current one (currentInstrument)
  _hot.sigs = new Map(_hot.midiTracks.map(track => [track.id, JSON.stringify([withoutFlashId(track.instrument) ?? null, track.mixerChannelId ?? null, track.instrument?.type === "kit" ? kitSig(state.kits?.[track.instrument.kitId] ?? null) : null])]))
  _hot.armedId = armPlan(state.tracks, _midiTargetTrackId).trackId
  _hot.racks = state.racks
  _hot.kits = state.kits
  _hot.pads = state.pads ?? DEFAULT_PADS
  _hot.bpm = state.bpm
  _hot.beatsPerBar = state.timeSignature?.[0] ?? 4
  if (_hot.armedId) _midiTargetTrackId = _hot.armedId   // a removed armed track falls back to the first
}

/** The built instrument for a snapshot track, rebuilt when its signature moved. */
function liveEntryFor(track) {
  const sig = _hot.sigs.get(track.id)
  let entry = _liveInstruments.get(track.id)
  if (entry && entry.sig !== sig) {
    entry.inst.dispose()
    _liveInstruments.delete(track.id)   // the rebuild below may return null
    entry = null
  }
  if (!entry) {
    const output = MixerEngine.getOutput(track.mixerChannelId) || AudioEngine.getMasterInput()
    const inst = liveInstrumentFor(track, instrumentDeps({ output, trackId: track.id }))
    if (!inst) return null
    entry = { sig, inst }
    _liveInstruments.set(track.id, entry)
  }
  return entry
}

/** Build the armed instrument and its heavy state before the first hit, so the
 *  first strike is not the one that pays for it. A no-op until the graph exists. */
function prewarmArmed() {
  if (!AudioEngine.getContext()) return
  const track = _hot.byId.get(_hot.armedId)
  const sig = track && _hot.sigs.get(track.id)
  if (!track || sig === _prewarmSig) return
  const entry = liveEntryFor(track)
  _prewarmSig = entry ? sig : null   // an unavailable pack may come back; try again
  Promise.resolve(entry?.inst.prewarm?.()).catch(error => {
    if (track.instrument?.type !== 'fm1' || error?.message === 'disposed') return
    if (_prewarmSig === sig) _prewarmSig = null   // a failed device is retried on the next prewarm
    showToast(`FM-1: ${failureText(error?.message)}`)
  })
  const instrument = track.instrument
  if (instrument?.type === 'pack') {
    const pack = packFor(instrument.packId, instrument.packVersion)
    const patch = pack?.byId?.get(instrument.patchId)
    if (pack && patch) warmPack(pack, patch).catch(() => {})
  }
}

// ─── Step sequencer voice ──────────────────────────────────────────────────
// Sequencer rows carry a note and nothing else; the sound is whatever the slot
// holds. Scheduling stays in the timeline's note contract so the sequencer and
// the arrangement cannot drift apart.
const SEQ_GATE = 0.18        // seconds a step sounds for
let _seqPlayer = null        // { sig, play, packInstruments }

function disposeSeqPlayer() {
  for (const instance of _seqPlayer?.packInstruments || []) {
    try { instance.dispose() } catch (err) {}
  }
  _seqPlayer = null
}

function sequencerPlayNote(note, velocity, time) {
  const ctx = AudioEngine.getContext()
  if (!ctx) return
  const track = armedTrack()
  const instrument = armedInstrument()
  const sig = JSON.stringify([instrument ?? null, track?.mixerChannelId ?? null])
  if (_seqPlayer && _seqPlayer.sig !== sig) disposeSeqPlayer()
  if (!_seqPlayer) {
    const output = MixerEngine.getOutput(track?.mixerChannelId) || AudioEngine.getMasterInput()
    const packInstruments = []
    const play = scheduledInstrumentFor({ instrument }, {
      palettes: Palettes,
      ctx,
      output,
      rackHandles: [_rackView?.getEngineHandle()].filter(Boolean),
      packFor,
      sampleStoreFor,
      packInstruments,
      fm1Sessions: fm1Sessions(),
      trackId: track?.id
    })
    if (!play) return
    _seqPlayer = { sig, play, packInstruments }
  }
  _seqPlayer.play({ pitch: note, velocity }, time, time + SEQ_GATE)
}

/** How far ahead the step sequencer must send notes: an FM-1 device's lead plus timer slack, else 0. */
function sequencerLead() {
  const track = armedTrack()
  const instrument = armedInstrument()
  if (instrument?.type !== 'fm1' || !track) return 0
  const output = MixerEngine.getOutput(track.mixerChannelId) || AudioEngine.getMasterInput()
  const session = fm1Sessions()?.acquire(track.id, fm1Descriptor(instrument), output)
  return session ? session.leadSec + 0.03 : 0
}

/**
 * One folder-library interface over both origins: Electron IPC, or the browser's
 * directory handles. Null where neither exists (the LAN http route), and that is
 * what hides the browse UI — see specs/soundfont-library.md phase 5.
 */
let _folderLibrary
function folderLibrary() {
  if (_folderLibrary !== undefined) return _folderLibrary
  const fs = window.electronFS
  // Electron folders are plain paths; the browser half already speaks { id, name, granted }.
  const listed = paths => (paths || []).map(path => ({ id: path, name: path, granted: true }))
  if (fs?.scanSoundFontFolders) {
    _folderLibrary = {
      listFolders: async () => listed(await fs.listSoundFontFolders()),
      addFolder: async () => { const paths = await fs.addSoundFontFolder(); return paths ? listed(paths) : null },
      removeFolder: async id => listed(await fs.removeSoundFontFolder(id)),
      requestAccess: async () => true,
      scan: async () => { const result = await fs.scanSoundFontFolders(); return { ...result, folders: listed(result.folders) } },
      importPreset: (path, presetIndex) => fs.importSf2Preset(path, presetIndex)
    }
  } else if (canBrowseFolders()) {
    try { _folderLibrary = createFolderLibrary({ packStore: webPackStore() }) } catch { _folderLibrary = null }
  } else {
    _folderLibrary = null
  }
  return _folderLibrary
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
let _padsView = null
let _loopPlayer = null
let _padsSession = null
let _repeat = null              // Note Repeat engine
let _padsRouter = null          // profile routing for encoders/buttons/pressure
let _controllerLearn = null
let _lessons = null             // Pads lesson session
let _lessonCard = null
let _lessonNextPad = null
let _padMirror = null           // LED mirror over the SMC-PAD link
let _padsSource = null          // last real hit, the Ladder source
let _repeatHeld = false
const _heldPads = new Map()     // hardware pads currently down: note -> velocity
let _lastDevice = null          // last controller name seen, for the learn dialog
const _overrideCache = new Map()
let _rackView = null
let _instrumentBrowser = null
let _instrumentSettings = null
let _libraryDialog = null
let _assistantDialog = null
let _mixerStrips = new Map()  // channelId → MixerStrip
let _currentMode = 'synth'    // 'synth' | 'arrange' | 'rack' | 'tr909' | 'pads'
let _selectedArrangeTrackId = null
let _rafId = null
let _midiTargetTrackId = null  // the armed track: routing target for notes on unclaimed channels
let _take = null               // Arrange MIDI take recorder while a take is open
let _takeStarting = 0          // generation of a pending ● start (prep / count-in); 0 = none
let _takeGen = 0
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
  const first = !AudioEngine.getContext()
  await AudioEngine.init()
  if (first) renderCommands()
}

/** The master recorder is a worklet: known after init; before it, a secure context is the tell. */
const canRecordMaster = () => AudioEngine.getContext() ? AudioEngine.hasRecorder() : !!window.isSecureContext

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
    recording: midiTakeOpen(),
    masterRecording: _audioRecording,
    canRecordMaster: canRecordMaster(),
    midiInput: _midiInputName,
    // Electron imports through IPC, the browser through a file input plus
    // IndexedDB. Dead only when neither backend exists.
    canImportPacks: canImportPacks(),
    assistant: assistantAvailable(),
    fm1Armed: _hot.byId.get(_hot.armedId)?.instrument?.type === 'fm1'
  })
  for (const item of items) {
    document.querySelectorAll(`[data-cmd="${item.id}"]`).forEach(el => {
      el.hidden = !item.visible
      if ('disabled' in el) el.disabled = !item.enabled
      // Menu labels can change with state (record-master is a toggle).
      if (el.classList.contains('menu-item')) el.firstElementChild.textContent = item.label
    })
  }
  const recBtn = document.getElementById('rec-btn')
  if (recBtn) {
    // Unavailable, not disabled: it stays focusable and says why.
    const off = _currentMode !== 'arrange'
    recBtn.disabled = false
    recBtn.setAttribute('aria-disabled', String(off))
    recBtn.title = off ? 'MIDI recording works in Arrange' : 'Record MIDI'
    if (off) recBtn.setAttribute('aria-description', 'MIDI recording works in Arrange')
    else recBtn.removeAttribute('aria-description')
    recBtn.setAttribute('aria-pressed', midiTakeOpen() ? 'true' : 'false')
  }
  // A take is timed against the tempo it started with.
  const bpmEl = document.getElementById('global-bpm')
  if (bpmEl) {
    bpmEl.disabled = midiTakeOpen()
    bpmEl.title = bpmEl.disabled ? 'Stop recording to change the tempo' : ''
  }
  // Master WAV recording runs on with the transport stopped: the ⋯ button shows it, and stops it.
  const menuBtn = document.getElementById('app-menu-btn')
  if (menuBtn) {
    menuBtn.classList.toggle('recording', _audioRecording)
    menuBtn.setAttribute('aria-label', _audioRecording ? 'More commands (master recording; stop it here)' : 'More commands')
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
  const items = commandItems({ mode: 'arrange', projectOpen: true, assistant: assistantAvailable() })
    .filter(item => item.visible && item.group !== 'transport' && item.id !== 'midi-token' && item.id !== 'theme')

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

  // Arrange MIDI recording preference; device-local like the theme.
  // A button, so Space and Enter toggle it; the menu stays open.
  const countItem = Object.assign(document.createElement('button'), { type: 'button', id: 'count-in-toggle', className: 'menu-item' })
  countItem.setAttribute('role', 'menuitemcheckbox')
  const countMark = Object.assign(document.createElement('span'), { className: 'menu-shortcut' })
  countMark.setAttribute('aria-hidden', 'true')
  const showCountIn = on => { countItem.setAttribute('aria-checked', String(on)); countMark.textContent = on ? '✓' : '' }
  countItem.append(Object.assign(document.createElement('span'), { textContent: 'Count-in before recording' }), countMark)
  countItem.addEventListener('click', () => {
    const on = !countInOn()
    safeStorage()?.setItem(COUNT_IN_KEY, on ? '1' : '0')
    showCountIn(on)
  })
  showCountIn(countInOn())
  menu.appendChild(countItem)
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
  const paletteKey = track?.paletteKey || 'classic'
  return track?.instrument || { type: 'palette', paletteKey, params: paletteDefaults(paletteKey) }
}

/** Rebuild the slot, knobs and pads — but only when the selection really moved. */
function syncInstrumentUi() {
  const track = armedTrack()
  const sig = JSON.stringify([track?.id ?? null, track?.midiChannel ?? null, track?.instrument ?? null])
  if (sig === _slotSig) return
  _slotSig = sig
  renderInstrumentSlot()
  renderKnobPanel()
  renderCommands()   // 'FM-1 device…' follows the armed instrument
  _padGrid?.render()
  if (_currentMode === 'pads') _padsView?.refreshKit()
}

const SLOT_STATE = { ready: '● loaded', unavailable: '○ no audio', missing: '○ missing' }

function renderInstrumentSlot() {
  const nameEl = document.getElementById('slot-name')
  if (!nameEl) return
  const track = armedTrack()
  const instrument = armedInstrument()
  nameEl.textContent = trackInstrumentLabel(instrument, _packCatalog, _fm1.installed)
  if (instrument.type === 'fm1' && !_fm1.loaded) refreshFm1Cache()   // names come from the firmware store
  const channelEl = document.getElementById('slot-channel')
  if (channelEl) {
    channelEl.textContent = !track ? 'new track on first note'
      : track.midiChannel == null ? 'omni'
      : 'ch ' + (track.midiChannel + 1)
  }
  const stateEl = document.getElementById('slot-state')
  if (stateEl) {
    const state = instrument.type === 'pack' ? packState(instrument)
      : instrument.type === 'fm1' && _fm1.loaded && !_fm1.installed.some(record => record.id === instrument.firmwareHash) ? 'missing'
      : 'ready'
    stateEl.textContent = instrument.type === 'pack' || instrument.type === 'fm1' ? (SLOT_STATE[state] ?? '') : ''
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
  if (instrument.type === 'kit') return kitAcceptsNote(instrument, note, _hot.kits)
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

// ─── Pads view ─────────────────────────────────────────────────────────────
// The view and the loop player are shells; the pass/commit rules live in
// pads/pads-session.js and the maths in pads/loop-record.js.
let _padsIdSeq = 0

/** The track the pads play: the armed kit track, else the first kit track, else a new one. */
function padsTrack() {
  const armed = _hot.byId.get(_hot.armedId)
  if (armed?.instrument?.type === 'kit') return armed
  const kitTrack = _hot.midiTracks.find(track => track.instrument?.type === 'kit')
  if (kitTrack) {
    _midiTargetTrackId = kitTrack.id
    refreshHot()
    syncInstrumentUi()
    return kitTrack
  }
  return addMidiTrack('Pads', { type: 'kit', kitId: DEFAULT_KIT_ID })
}

const padsLoopBeats = () => _hot.pads.loopBars * _hot.beatsPerBar
const padsDims = () => ({ loopBars: _hot.pads.loopBars, beatsPerBar: _hot.beatsPerBar })
const commitPadsPass = () => _padsSession?.commit(_hot.pads.loopBars, _hot.beatsPerBar)

/** The matching release of a view pad (pointer up, key up): a note-off like a hardware pad's, so Repeat lets go. */
function padsRelease(note) {
  const target = padsTrack()
  if (!target) return
  document.dispatchEvent(new CustomEvent('midi-event', {
    detail: { kind: 'note-off', channel: target.midiChannel ?? 0, pitch: note, velocity: 0, source: 'pads-view' }
  }))
}

/** A pad press from the view — a midi-event like every other pad, so routing, choke and mixer come along. */
function padsTrigger(note, velocity) {
  ensureAudio()
  const target = padsTrack()
  if (!target) return
  document.dispatchEvent(new CustomEvent('midi-event', {
    detail: { kind: 'note-on', channel: target.midiChannel ?? 0, pitch: note, velocity, source: 'pads-view' }
  }))
}

const canRecordPadsHit = (detail, trackId) => canRecordHit({
  mode: _currentMode,
  layerOn: _padsView?.layerOn(),
  playing: _loopPlayer?.isPlaying(),
  armedId: _hot.armedId,
  armedType: _hot.byId.get(_hot.armedId)?.instrument?.type
}, detail, trackId)

/** Tee from handleMidiEvent: flash the pad, and record it when Layer is armed over a running loop. */
/** `rawPitch` is the pad before Ladder/Full shaping: lessons score the pad the player hit. */
function padsNoteOn(trackId, detail, time, rawPitch = detail.pitch) {
  if (trackId !== _hot.armedId || !_padsView) return
  _padsView.flashPad(detail.pitch, detail.velocity)
  if (_lessons?.active() && _loopPlayer.isPlaying() && rawPitch >= 36 && rawPitch < 52) {
    _loopPlayer.syncBpm()
    _lessons.hit({ pad: rawPitch - 36, beat: _loopPlayer.beatAt(time), velocity: detail.velocity, source: detail.source })
  }
  if (!canRecordPadsHit(detail, trackId) || _padsView.isWiping()) return
  _loopPlayer.syncBpm()
  const beat = _loopPlayer.beatAt(time)
  if (beat < 0) return   // count-in
  const { snapGrid, snapStrength, groove } = _hot.pads
  _padsSession.hit(trackId, { pitch: detail.pitch, velocity: detail.velocity, beat },
    { loopBeats: padsLoopBeats(), grid: snapGrid, strength: snapStrength, swing: groove }, padsDims())
}

function startPadsLoop() {
  if (!padsTrack()) return
  _loopPlayer.start({ countInBars: _padsView.layerOn() ? _hot.pads.countInBars : 0 })
  _lessons?.restart()
  _padsView.setPlaying(true)
}

function stopPadsLoop() {
  _loopPlayer?.stop()
  commitPadsPass()
  _padsView?.setPlaying(false)
}

/** A project was replaced (new/open): the pass and the running loop belong to the old one. */
function resetPadsForNewProject() {
  _loopPlayer?.stop()
  _padsSession?.discard()
  _padsView?.setPlaying(false)
}

// ─── Pads: controller routing, Repeat, knob effects ────────────────────────
const padsClick = selector => _padsView?.container.querySelector(selector)?.click()
const padsHold = (selector, down) => _padsView?.container.querySelector(selector)
  ?.dispatchEvent(new Event(down ? 'pointerdown' : 'pointerup', { bubbles: true }))

// ─── Sample drops (Pads view) ───────────────────────────────────────────────
let _userSamples = null
const userSampleStorage = () => (_userSamples ??= createUserSamples())
/** put + forget a cached "missing" verdict for that id, so a re-dropped sample plays at once. */
async function putUserSample(sample) {
  const stored = await userSampleStorage().put(sample)
  const store = userSampleStoreFor(AudioEngine.getContext())
  if (store) missesOf(store).delete(stored.id)
  return stored
}
let _fm1Library = null
/** Lazy: the store, dialog and seed catalog load on first open. */
async function openFm1Library() {
  // Cache the promise: concurrent opens must share one controller (one set of listeners).
  _fm1Library ??= (async () => {
    const [{ createFm1LibraryDialog }, { pickFile }, seed] = await Promise.all([
      import('./components/fm1-library-dialog.js'),
      import('./instruments/pack-import-web.js'),
      import('./fm1/seed-catalog.json')
    ])
    return createFm1LibraryDialog({
      store: fm1Store(),
      seedCatalog: seed.default,
      // Every import/remove outcome toasts, so it is also the moment the shared list may have moved.
      toast: message => { showToast(message); refreshFm1Cache() },
      // Firmware added or removed: the armed FM-1 track's device may now boot (or must stop).
      onChange: () => { _prewarmSig = null; prewarmArmed() },
      pickFile: () => pickFile('.fwsc'),
      pickCatalogFile: () => pickFile('.json')
    })
  })()
  try { return (await _fm1Library).open() } catch (e) { _fm1Library = null; throw e }
}

let _sliceDialog = null

/** File -> { bytes, buffer, name } or { error } (a short message for the toast). Never throws. */
async function decodeDropped(file, opts) {
  const check = checkSampleFile(file, opts)
  if (!check.ok) return { error: check.reason }
  let bytes
  try { bytes = await file.arrayBuffer() } catch { return { error: 'Could not read file' } }
  try {
    await ensureAudio()
    const buffer = await AudioEngine.getContext().decodeAudioData(bytes.slice(0))
    return { bytes, buffer, name: file.name.replace(/\.[^.]+$/, '') }
  } catch { return { error: 'Could not decode audio' } }
}

function putSlots(kitId, slots, label) {
  const kit = kitFor(kitId, _hot.kits)
  if (!kit) return showToast('Kit not found')
  ProjectStore.dispatchBatch(slotCommands(kitId, kit, !!_hot.kits?.[kitId], slots), label)
  refreshPadLeds()
}

/** One audition source at a time, 10 ms fade-out at the region end. */
let _auditionSrc = null
function stopAudition() {
  try { _auditionSrc?.stop() } catch { /* already ended */ }
  _auditionSrc = null
}
function auditionRegion(buffer, start, end) {
  const ctx = AudioEngine.getContext()
  if (!ctx) return
  stopAudition()
  const dur = Math.max(end - start, 0.001), fade = Math.min(0.01, dur / 2), t = ctx.currentTime
  const gain = ctx.createGain()
  gain.gain.setValueAtTime(1, t + dur - fade)
  gain.gain.linearRampToValueAtTime(0, t + dur)
  gain.connect(AudioEngine.getMasterInput())
  const src = ctx.createBufferSource()
  src.buffer = buffer
  src.connect(gain)
  src.start(t, start, dur)
  src.stop(t + dur + 0.01)
  src.onended = () => { if (_auditionSrc === src) _auditionSrc = null }
  _auditionSrc = src
}

const trimmedOf = buffer => trimEnd(mono(Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i))))

async function onPadsDropFile(file, { pad = null, note = null, count = 1 } = {}) {
  const kitId = armedKitId()
  if (!kitId) return showToast('Arm a kit track first')
  if (count > 1) showToast(`One file at a time — used ${file.name}`)
  const got = await decodeDropped(file, pad == null ? undefined : { maxBytes: MAX_PAD_BYTES })
  if (got.error) return showToast(got.error)
  const trimmed = trimmedOf(got.buffer)
  const short = tooShort(trimmed, got.buffer.sampleRate, pad == null ? 'slice' : 'pad')
  if (short) return showToast(short)
  if (pad == null) {
    if (got.buffer.duration > MAX_SLICE_SEC) return showToast(`Too long to slice (max ${MAX_SLICE_SEC} s)`)
    _sliceDialog ??= createSliceDialog({
      onApply: applySlice,
      onSetBpm: setBpm,
      audition: auditionRegion,
      onClose: stopAudition
    })
    return _sliceDialog.open(got)
  }
  let stored
  try { stored = await putUserSample({ name: file.name, type: file.type, bytes: got.bytes }) } catch { return showToast('Could not store sample') }
  const { buffer } = got
  const slot = sampleSlot({ sampleId: stored.id, name: got.name, start: 0, end: padEndSec(trimmed, buffer.sampleRate) })
  putSlots(kitId, { [note ?? 36 + pad]: slot }, 'Load sample')
}

async function applySlice({ regions, sampleRate, name, bytes }) {
  const kitId = armedKitId()
  if (!kitId) return
  let stored
  try { stored = await putUserSample({ name, type: 'audio/*', bytes }) } catch { return showToast('Could not store sample') }
  putSlots(kitId, sliceSlots(regions, sampleRate, { sampleId: stored.id, name }), 'Slice sample')
}

function armedKitId() {
  const instrument = _hot.byId.get(_hot.armedId)?.instrument
  return instrument?.type === 'kit' ? instrument.kitId : null
}

/** Hold state of Repeat. Pressing it with pads already down repeats them. */
function setRepeatHeld(pressed) {
  _repeatHeld = pressed
  if (!_repeat) return
  if (pressed) for (const [note, velocity] of _heldPads) _repeat.press(note, velocity)
  else _repeat.stop()
}

/** Run what pads/knob-roles.js asked for. One turn is one undo step (so a long twist is many; accepted). */
function runKnobEffects(effects) {
  const commands = []
  const seeded = new Set()
  for (const fx of effects) {
    if (fx.type === 'pads') commands.push(SetPadsSettings(fx.patch))
    else if (fx.type === 'bpm') { if (midiTakeOpen()) showToast('STOP RECORDING TO CHANGE TEMPO'); else commands.push(SetBpm(fx.bpm)) }
    else if (fx.type === 'slot') {
      const kitId = armedKitId()
      const kit = kitId && kitFor(kitId, _hot.kits)
      const def = kit?.slots?.[fx.note]
      if (!def) continue
      if (!_hot.kits?.[kitId] && !seeded.has(kitId)) { seeded.add(kitId); commands.push(SeedKit(kitId, kit)) }   // kit lives in code only: copy it in first
      const { tuneSt, decayMul, filterMul, level } = fx.params
      const perf = { ...def.perf, ...Object.fromEntries(Object.entries({ tuneSt, decayMul, filterMul, level }).filter(([, v]) => v !== undefined)) }
      commands.push(SetKitSlot(kitId, fx.note, { ...def, perf }))
    }
  }
  if (commands.length) ProjectStore.dispatchBatch(commands, 'Pads knob')
}

/** What pads/knob-roles.js needs: the selected pad's slot as { voice, params }, with the performance layer as params. */
function knobContext() {
  const note = _padsView?.selectedNote?.() ?? 36
  const kitId = armedKitId()
  const def = kitId && kitFor(kitId, _hot.kits)?.slots?.[note]
  const perf = def?.perf ?? {}
  const slot = def ? { voice: def.voice, params: { tuneSt: perf.tuneSt ?? 0, decayMul: perf.decayMul ?? 1, filterMul: perf.filterMul ?? 1, level: perf.level ?? 1 } } : null
  return { pads: _hot.pads, bpm: _hot.bpm, slot, note }
}

const padsKnob = (index, delta) => runKnobEffects(applyKnob?.(index, delta, knobContext()) ?? [])

/** A repeat tick, played exactly like a live hit: routing, Layer recording and the pad flash all apply. */
function padsRepeatHit(note, velocity, time) {
  const channel = _hot.byId.get(_hot.armedId)?.midiChannel ?? 0
  document.dispatchEvent(new CustomEvent('midi-event', {
    detail: { kind: 'note-on', channel, pitch: note, velocity, source: 'repeat', audioTime: time }
  }))
}

/** One-per-event: Ladder source, Full, then the hit (and a Repeat press) — see hit-shape.js. */
function shapePadsHit(detail) {
  const shaped = shapeHit(_hot.pads, _padsSource, { note: detail.pitch, velocity: detail.velocity, repeat: detail.source === 'repeat' })
  _padsSource = shaped.source
  if (detail.source !== 'repeat') {
    _heldPads.set(detail.pitch, detail.velocity)   // every non-repeat source: its note-off releases Repeat
    if (_repeatHeld) _repeat?.press(detail.pitch, detail.velocity)
  }
  return { detail: { ...detail, pitch: shaped.note, velocity: shaped.velocity }, override: shaped.override }
}

function initPadsRouting() {
  _repeat = createRepeatEngine({
    getContext: () => AudioEngine.getContext(),
    bpm: () => _hot.bpm,
    swing: () => _hot.pads.groove,
    rate: () => REPEAT_RATES[_hot.pads.repeatRate] ?? REPEAT_RATES['1/16'],
    beatAt: time => {
      if (!_loopPlayer?.isPlaying()) return null
      _loopPlayer.syncBpm()
      return _loopPlayer.beatAt(time)
    },
    playHit: padsRepeatHit
  })
  _padsRouter = createControllerRouter({
    profileFor: device => (SMC_PAD.match(device) ? SMC_PAD : null),
    overrides: device => {
      if (!_overrideCache.has(device)) _overrideCache.set(device, loadOverrides(safeStorage(), device))
      return _overrideCache.get(device)
    },
    applyKnob,
    knobCtx: knobContext,
    run: runKnobEffects,
    view: () => _padsView,
    active: () => _currentMode === 'pads',
    actions: {
      play: () => document.getElementById(_loopPlayer?.isPlaying() ? 'global-stop-btn' : 'global-play-btn')?.click(),
      layer: () => padsClick('.pads-layer'),
      repeat: setRepeatHeld,
      wipe: down => padsHold('.pads-wipe', down),
      full: () => ProjectStore.dispatch(SetPadsSettings({ full: !_hot.pads.full })),
      pressure: value => _repeat.pressure(value)
    }
  })
  _controllerLearn = createControllerLearn({
    getDevice: () => _lastDevice ?? _midiInputName,
    isConnected: () => MidiController.isGranted() && !!document.getElementById('midi-device-select')?.value,
    router: _padsRouter,
    profileFor: device => (SMC_PAD.match(device) ? SMC_PAD : null),
    onChange: device => _overrideCache.delete(device)
  })
}

function initPadsView() {
  const container = document.getElementById('pads-view')
  if (!container) return
  _padsSession = createPadsSession({
    getTrack: id => _hot.byId.get(id),
    dispatch: command => ProjectStore.dispatch(command),
    dispatchBatch: (commands, label) => ProjectStore.dispatchBatch(commands, label),
    undo: () => ProjectStore.undo(),
    getUndoLabel: () => ProjectStore.getUndoLabel(),
    newId: () => `pads-${Date.now().toString(36)}-${++_padsIdSeq}`
  })
  _loopPlayer = createLoopPlayer({
    getContext: () => AudioEngine.getContext(),
    bpm: () => _hot.bpm,
    beatsPerBar: () => _hot.beatsPerBar,
    loopBeats: padsLoopBeats,
    notes: () => _padsSession.notes(_hot.armedId),
    playHit: (pitch, velocity, time) => {
      if (_hot.pads.muted?.includes(pitch)) return   // muted pads stay in the loop, silent
      const track = _hot.byId.get(_hot.armedId)
      const entry = track && liveEntryFor(track)
      try { entry?.inst.hit?.(pitch, velocity, time) } catch (err) {}
    },
    playClick: (accent, time) => playClick(AudioEngine.getContext(), AudioEngine.getMasterInput(), accent, time),
    metronome: () => _hot.pads.metronome,
    onWrap: k => { commitPadsPass(); _lessons?.wrap(k) },
    // Wipe-while-held erases whatever the playhead just passed.
    onTick: (fromBeat, toBeat) => {
      _lessons?.tick(toBeat)
      if (!_padsView?.isWiping() || !_hot.armedId) return
      _padsSession.wipe(_hot.armedId, { pitches: _padsView.wipePitches(), fromBeat, toBeat, loopBeats: padsLoopBeats() }, padsDims())
    }
  })
  _padsView = new PadsView(container, {
    triggerPad: padsTrigger,
    releasePad: padsRelease,
    getKit: () => {
      const instrument = _hot.byId.get(_hot.armedId)?.instrument
      return kitFor(instrument?.type === 'kit' ? instrument.kitId : DEFAULT_KIT_ID, _hot.kits)
    },
    getNotes: () => _padsSession.notes(_hot.armedId),
    getBeat: () => (_loopPlayer.isPlaying() ? _loopPlayer.currentBeat() : null),
    canUndo: () => _padsSession.canUndo(),
    onUndo: () => { _padsSession.undo(); _padsView.drawStrip() },
    onLayerChange: on => { if (!on) commitPadsPass() },
    onKnob: padsKnob,
    onDropFile: onPadsDropFile,
    getBpm: () => _hot.bpm,
    onAction: (action, payload) => {
      if (action === 'repeat') setRepeatHeld(!!payload?.pressed)
      else if (action === 'learn') _controllerLearn?.open()
      else if (action === 'lessons') openLessons()
    }
  })
  initPadsRouting()
  initLessons()
}

function openLessons() {
  if (_currentMode !== 'pads') switchMode('pads')
  _lessonCard?.open()
}

function initLessons() {
  _lessons = createLessonSession({
    storage: safeStorage(),
    getPads: () => _hot.pads,
    getBpm: () => _hot.bpm,
    getLoopBeats: padsLoopBeats,
    getBeatsPerBar: () => _hot.beatsPerBar,
    getClipPads: () => new Set((_padsSession?.notes(_hot.armedId) ?? []).map(n => n.pitch - 36).filter(p => p >= 0 && p < 16)),
    getSamplePads: () => { const id = armedKitId(); return samplePadsOf(id && kitFor(id, _hot.kits)) },
    applySetup: lesson => {
      ProjectStore.dispatchBatch([
        SetBpm(lesson.bpm),
        // Base first: one lesson's Ladder/Full must not leak into the next.
        SetPadsSettings({ loopBars: lesson.bars, groove: lesson.groove, metronome: true, full: false, ladder: null, ...lesson.setup })
      ], 'Lesson setup')
      _padsView?.setBank(0)
    },
    onUpdate: m => {
      _lessonNextPad = m?.nextPad ?? null
      _padsView?.setLesson?.(m ? { targets: m.lesson.targets, bars: m.lesson.bars } : null)
      _padsView?.setMarks?.(m?.marks ?? [])
      _padsView?.setBias?.(m?.biasMs ?? null)
      _padsView?.setNextTarget?.(_lessonNextPad)
      _lessonCard?.render(m)
    }
  })
  _lessonCard = createLessonCard({
    session: _lessons,
    onStart: id => {
      _lessons.start(id)
      // Restart so beat 0 is the lesson's origin; stopPadsLoop commits any open pass.
      if (_loopPlayer.isPlaying()) stopPadsLoop()
      startPadsLoop()
      _lessonCard.setNotice(_loopPlayer.isPlaying() ? '' : 'No Pads track to play. Arm a kit track first.')
    },
    onStop: () => _lessons.stop()
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
  if (instrument.type === 'kit') return
  if (instrument.type === 'fm1') return renderFm1Panel(panel)
  renderPaletteKnobs(panel, instrument, armedTrack()?.id)
}

function renderFm1Panel(panel) {
  const open = document.createElement('button')
  open.type = 'button'
  open.className = 'btn midi-btn'
  open.textContent = 'Open device…'
  open.addEventListener('click', () => runCommand('fm1-device'))
  panel.append(open)
}

function renderPaletteKnobs(panel, instrument, trackId) {
  const paletteKey = instrument.paletteKey || 'classic'
  const p = Palettes[paletteKey] || Palettes.classic
  const params = instrument.params || paletteDefaults(paletteKey)

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
        if (params[def.key] === opt) o.selected = true
        sel.appendChild(o)
      })
      sel.addEventListener('change', () => {
        if (trackId) ProjectStore.dispatch(SetInstrumentParam(trackId, def.key, sel.value))
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
      value: params[def.key],
      // Commit on release, not per tick: one drag is one undo entry. The
      // slider still tracks the pointer live via updateFill, only the store
      // write is deferred.
      // ponytail: a note struck mid-drag plays the pre-drag value — voices
      // sample params at creation, not live, so this only affects notes
      // triggered while a knob is still moving.
      event: 'change',
      onInput: v => { if (trackId) ProjectStore.dispatch(SetInstrumentParam(trackId, def.key, v)) }
    })
    if (def.key === 'reverb') {
      // Reverb keeps immediate feedback during the drag — engine state, not
      // store state, so ticking it does not spam undo history.
      document.getElementById(`knob-${paletteKey}-${def.key}`)
        ?.addEventListener('input', e => AudioEngine.setReverb(parseFloat(e.target.value)))
    }
    if (i < p.knobs.length - 1) addDivider(panel)
  })

  // Each palette carries its own reverb default, applied when it becomes the
  // armed sound rather than on a tab click that no longer exists.
  if (AudioEngine.getContext() && params?.reverb != null) {
    _reverbAmount = params.reverb
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
  open.className = 'btn knob-open-btn'
  open.textContent = 'OPEN RACK'
  open.addEventListener('click', () => switchMode('rack'))
  panel.append(note, open)
}

/** One slider, one label, one readout — the shape every knob has always had. */
function addKnob(panel, def, { id, value, onInput, event = 'input' }) {
  const group = document.createElement('div')
  group.className = 'knob-group'
  group.dataset.group = String(panel.querySelectorAll('.knob-group').length % 4 + 1)

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
    if (!setBpm(bpm)) e.target.value = ProjectStore.getState().bpm
  })
  // Store is the source of truth; push into Sequencer's copy and keep the
  // input in sync (e.g. after project open).
  ProjectStore.subscribe(() => {
    const bpm = ProjectStore.getState().bpm
    if (bpmEl) bpmEl.value = bpm
    Sequencer.setBPM(bpm)
    if (_projectOpen && !_projectDirty) { _projectDirty = true; renderCommands() }
  })

  // Transport — every Play/Stop (buttons, Space, Shift+Space, the pad controller) clicks these.
  document.getElementById('global-play-btn')?.addEventListener('click', transportPlay)
  document.getElementById('global-stop-btn')?.addEventListener('click', transportStop)

  // Everything that is not live lives in the ⋯ menu or a dialog.
  buildAppMenu()
  COMMANDS['midi-setup'] = () => openDialog('midi-setup-dialog')
  COMMANDS['controller-map'] = () => _controllerLearn?.open()
  COMMANDS['lessons'] = () => openLessons()
  COMMANDS['fm1-library'] = () => openFm1Library()
  COMMANDS['fm1-device'] = () => {
    const track = _hot.byId.get(_hot.armedId)
    if (track?.instrument?.type === 'fm1') return openFm1Device(track.id)
  }
  COMMANDS['fm1-record'] = () => openFm1Record()
  COMMANDS['mixer'] = () => toggleMixer()
  // No listener yet for these two — the instrument agent wires them.
  COMMANDS['library'] = () => document.dispatchEvent(new CustomEvent('open-library'))
  if (assistantAvailable()) COMMANDS['assistant'] = () => document.dispatchEvent(new CustomEvent('open-assistant'))
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

/** Master to WAV: a ⋯ menu toggle. The recorder is a worklet, so this needs a secure context. */
let _masterTimer = null
async function toggleMasterRecording() {
  const timer = document.getElementById('rec-timer')
  await ensureAudio()
  if (!_audioRecording) {
    if (!AudioEngine.hasRecorder()) {
      showToast('REC NEEDS HTTPS')
      return
    }
    _audioRecording = true
    let elapsed = 0
    const digits = document.getElementById('rec-time')
    if (digits) digits.textContent = '00:00'
    if (timer) timer.hidden = false
    showToast('● RECORDING')
    Recorder.start(AudioEngine.getContext(), AudioEngine.getRecordTap())
    _masterTimer = setInterval(() => {
      elapsed++
      const digits = document.getElementById('rec-time')
      if (digits) digits.textContent = pad(Math.floor(elapsed / 60)) + ':' + pad(elapsed % 60)
    }, 1000)
    renderCommands()
  } else {
    _audioRecording = false
    clearInterval(_masterTimer)
    if (timer) timer.hidden = true
    renderCommands()
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
}

function initRecorder() {
  COMMANDS['record-master'] = toggleMasterRecording
  document.getElementById('rec-btn')?.addEventListener('click', () => {
    if (midiTakeOpen()) return stopMidiTake()
    if (_currentMode !== 'arrange') return showToast('MIDI RECORDING WORKS IN ARRANGE')
    startMidiTake()
  })
  // Playback stopping for any reason ends an open take (and keeps it).
  TimelinePlayer.onStop = () => { if (_take) stopMidiTake() }
}

// ─── Arrange MIDI recording ─────────────────────────────────────────────────
// The header ● in Arrange: play from the top and record every note the routed tracks are told to
// play into a new clip per track, one undo step. The tap is in handleMidiEvent, where keys, pads
// and MIDI devices all converge.
const COUNT_IN_KEY = 'synth_count_in'
const countInOn = () => safeStorage()?.getItem(COUNT_IN_KEY) === '1'
function midiTakeOpen() { return !!_take || !!_takeStarting }

/** Tempo edits wait while a take is open: its notes are timed against the tempo it started with. */
function setBpm(bpm) {
  if (midiTakeOpen()) { showToast('STOP RECORDING TO CHANGE TEMPO'); return false }
  ProjectStore.dispatch(SetBpm(bpm))
  return true
}

/** Everything slow before the first click: kit samples decoded, FM-1 devices booted. */
async function prepareArrangeTake() {
  const state = ProjectStore.getState()
  await preloadKitSamples(userSampleStoreFor(AudioEngine.getContext()), state.tracks, state.kits)
  const sessions = fm1Sessions()
  await Promise.allSettled(state.tracks.filter(track => track.type === 'midi' && track.instrument?.type === 'fm1')
    .map(track => sessions?.acquire(track.id, fm1Descriptor(track.instrument), MixerEngine.getOutput(track.mixerChannelId) || AudioEngine.getMasterInput())?.ready))
}

/** One bar of metronome clicks from just after now, accent first. Returns the downbeat after them. */
function scheduleCountIn(ctx, bpm, beatsPerBar) {
  const beat = 60 / bpm
  const t0 = ctx.currentTime + 0.05
  for (let i = 0; i < beatsPerBar; i++) playClick(ctx, AudioEngine.getMasterInput(), i === 0, t0 + i * beat)
  return t0 + beatsPerBar * beat
}

async function startMidiTake() {
  if (_currentMode !== 'arrange' || midiTakeOpen()) return
  if (fm1Recording()) return showToast('FM-1 RECORDING IN PROGRESS')
  // A generation, not a flag: Stop then ● again while the first start still awaits must not
  // let the first one start a second take.
  const gen = _takeStarting = ++_takeGen
  const current = () => _takeStarting === gen && _currentMode === 'arrange' && !fm1Recording()
  renderCommands()
  await ensureAudio()
  if (TimelinePlayer.isPlaying() && current()) {   // no seek: a take starts from the top
    TimelinePlayer.stop()
    syncTransportPressed()
    showToast('Recording from the start')
  }
  if (current()) await prepareArrangeTake()
  if (!current()) {   // Stop / ● pressed, view left or FM-1 recording started meanwhile
    if (_takeStarting === gen) _takeStarting = 0
    renderCommands()
    return
  }
  const state = ProjectStore.getState()
  const ctx = AudioEngine.getContext()
  // The timeline is anchored on the downbeat after the clicks, so nothing can make it late.
  const at = countInOn() ? scheduleCountIn(ctx, state.bpm, _hot.beatsPerBar) : undefined
  const startTime = TimelinePlayer.play({ ...arrangePlayArgs(0), at })
  _takeStarting = 0
  syncTransportPressed()
  if (typeof startTime !== 'number') { renderCommands(); return }
  const takeNumber = 1 + Math.max(0, ...state.tracks.flatMap(track => (track.clips || []).map(clip => Number(/^Take (\d+)$/.exec(clip.name)?.[1] ?? 0))))
  // Always from beat 0 (no seek yet). Notes played during the count-in are before startTime: dropped.
  _take = createTakeRecorder({ startTime, playBeat: 0, bpm: state.bpm, beatsPerBar: _hot.beatsPerBar, takeNumber })
  renderCommands()
}

function stopMidiTake() {
  if (_takeStarting) { _takeStarting = 0; renderCommands(); return }   // startMidiTake unwinds
  if (!_take) return
  const take = _take
  _take = null
  const recorded = take.finish(AudioEngine.getContext().currentTime)
  TimelinePlayer.stop()
  syncTransportPressed()
  // A track deleted during the take has nowhere to put its clip.
  const kept = recorded.filter(({ trackId }) => _hot.byId.has(trackId))
  ProjectStore.dispatchBatch(kept.map(({ trackId, clip }) => AddClip(trackId, clip)), 'Record MIDI')
  showToast(kept.length ? 'TAKE RECORDED' : 'NOTHING RECORDED')
  renderCommands()
}

/** New / Open during a take: the tracks it was recording into are going away. */
function discardMidiTake() {
  if (!midiTakeOpen()) return
  _take = null
  _takeStarting = 0
  TimelinePlayer.stop()
  syncTransportPressed()
  showToast('TAKE DISCARDED')
  renderCommands()
}

// ─── Mode switching ──────────────────────────────────────────────────────────
// The number row means pads on the synth view and voices on the 909's; 'synth' and 'arrange'
// also let the PC keys play the piano (keyboard.js). Rack keeps 'global': no keyboard there.
const shortcutContext = mode => ['synth', 'tr909', 'pads', 'arrange'].includes(mode) ? mode : 'global'

function switchMode(mode) {
  if (mode !== 'arrange' && midiTakeOpen()) stopMidiTake()   // a take is an Arrange thing
  _currentMode = mode
  updateGlobalPlayAvailability()
  ShortcutManager.setContext(shortcutContext(mode))
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
  if (mode !== 'pads') closeDialog('lesson-dialog')   // its close handler stops the lesson
  if (mode !== 'pads' && (_loopPlayer?.isPlaying() || _padsSession?.hasPass())) stopPadsLoop()
  else Sequencer.stop()   // one transport at a time
  _padsView?.setActive(mode === 'pads')
  syncTransportPressed()
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
    discardMidiTake()
    disposeLiveInstruments()
    disposeFm1()
    resetPadsForNewProject()
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
    discardMidiTake()
    disposeLiveInstruments()
    disposeFm1()
    resetPadsForNewProject()
    // folder first: the load notification prewarms the armed FM-1 track, which reads its saved state from it
    AudioStore.reset()
    AudioStore.setProjectDir(handle)
    ProjectStore.load(state)
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

  // FM-1 device flash goes first (one new asset file per changed device), project.json last:
  // it is the commit point, so an interrupted save leaves the previous project + assets intact.
  // Resolves true when project.json was written, false otherwise (the toast says why).
  let saving = null
  COMMANDS['save'] = () => saving ??= (async () => {
    const handle = AudioStore.getProjectDir()
    if (!handle) return false
    try {
      const { messages } = await saveProject({
        getState: () => ProjectStore.getState(),
        snapshotAll: () => _fm1.sessions?.snapshotAll() ?? new Map(),
        writeFlash: (name, bytes) => FileAdapter.writeFm1Flash(handle, name, bytes),
        commit: assignments => {
          _fm1.saveCommit = true   // pruneFm1: the devices already run this state, no reboot
          try { ProjectStore.dispatch(SetTrackFlashAssets(assignments)) } finally { _fm1.saveCommit = false }
        },
        writeProject: state => FileAdapter.writeProject(handle, state),
        getSession: id => _fm1.sessions?.get(id) ?? null,
        newId: () => newId()
      })
      _projectDirty = false
      renderCommands()
      if (messages.length) showToast(messages.join(' · '))
      return true
    } catch (e) {
      showToast(`SAVE FAILED: ${e?.message || e}`)
      return false
    }
  })().finally(() => { saving = null })

  // A firmware save changes the device's flash without a store command: poll the sessions so the
  // project shows unsaved changes.
  setInterval(() => {
    if (!_projectOpen || _projectDirty || !_fm1.sessions) return
    if (anyFlashDirty(_fm1.sessions, _hot.midiTracks.filter(t => t.instrument?.type === 'fm1').map(t => t.id))) { _projectDirty = true; renderCommands() }
  }, 1000)

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
    try {
      const wav = await TimelinePlayer.bounce({
        bpm: state.bpm,
        tracks: state.tracks,
        audioStore: AudioStore,
        durationBeats,
        racks: state.racks,
        kits: state.kits,
        packFor,
        sampleStoreFor,
        sampleRate: state.sampleRate,
        palettes: Palettes
      })
      await FileAdapter.exportWav(wav, `bounce-${Date.now()}.wav`)
    } catch (error) {
      showToast(error?.message || 'Bounce failed')
    }
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
  // One entry per physical device: a mirrored port would double every hit.
  const groups = groupInputs(inputs)
  groups.forEach(({ primaryId, name }) => {
    const opt = document.createElement('option')
    opt.value = primaryId; opt.textContent = name
    sel.appendChild(opt)
  })
  const primaryOf = id => groups.find(group => group.ids.includes(id))?.primaryId
  const preferred = [current, saved].map(primaryOf).find(Boolean)
    || groups.find(group => !/clock|thru/i.test(group.name || ''))?.primaryId
    || groups[0]?.primaryId
  sel.value = preferred || ''
  MidiController.selectInput(sel.value)
  linkPads()
  syncMidiToken(sel)
}

// ─── SMC-PAD LEDs ─────────────────────────────────────────────────────────
// In a user preset (SHIFT + Pad 3–8) the host can colour the pads: each pad
// takes its kit voice's colour, and its notes are mapped onto the kit's 36–51.
// Performance mode keeps its fixed colours and already sends 36–51. Writes go
// to working memory only; the save command is never built. specs/pads-view.md
const PAD_POLL_MS = 2000       // the preset changes on the device with no MIDI, so poll the mode
let _padLink = null
let _padPoll = null
let _padKitId = null
let _padOutputId = null
let _padSeq = 0                // only the latest refresh may set the note map

function linkPads() {
  const output = MidiController.selectedOutput()
  // statechange fires for every hot-plug; keep a live link to the same port.
  if (_padLink && output?.id === _padOutputId) return
  clearInterval(_padPoll)
  _padMirror?.stop()
  _padMirror = null
  _padLink = null
  _padKitId = null
  MidiController.onSysex = null
  _padOutputId = null
  if (!output || !/SMC-PAD/i.test(output.name || '')) return
  _padOutputId = output.id
  const link = createSmcPadLink({ send: bytes => output.send(bytes) })
  _padLink = link
  MidiController.onSysex = bytes => link.onSysex(bytes)
  _padMirror = createLedMirror({
    link,
    colours: () => {
      const kitId = armedKitId()
      const kit = kitId && kitFor(kitId, _hot.kits)
      return kit ? padColours(kit) : null
    },
    // Pad i is the same colour in every bank; muted/hasSound follow the bank the view shows.
    patterns: () => {
      const kitId = armedKitId()
      const kit = kitId && kitFor(kitId, _hot.kits)
      const wiping = !!_padsView?.isWiping()
      const wiped = _padsView?.wipePitches()
      const base = 36 + 16 * (_padsView?.bank ?? 0)   // the bank the view shows
      return Array.from({ length: 16 }, (_, i) => ({
        hasSound: !!kit?.slots?.[base + i],
        muted: !!_hot.pads.muted?.includes(base + i),
        wipeArmed: wiping && (!wiped || wiped.has(base + i)),
        target: _lessonNextPad === i && (_padsView?.bank ?? 0) === 0
      }))
    }
  })
  _padMirror.start()
  refreshPadLeds()
  _padPoll = setInterval(refreshPadLeds, PAD_POLL_MS)
}

async function refreshPadLeds() {
  const link = _padLink
  if (!link) return
  const instrument = _hot.byId.get(_hot.armedId)?.instrument
  _padKitId = instrument?.type === 'kit' ? instrument.kitId : null
  const kit = _padKitId ? kitFor(_padKitId, _hot.kits) : null
  const seq = ++_padSeq
  // Only a kit is laid out as 16 pads; anything else hears the device's own notes.
  // The mirror's current frame, so a refresh does not paint over a blink in progress.
  const map = kit ? await link.refresh(_padMirror?.snapshot() ?? padColours(kit)) : null
  if (link === _padLink && seq === _padSeq) MidiController.setNoteMap(map)
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
    updateMidiDeviceSelect(inputs)
  }

  // Both are real gestures, and a resume needs one. Spinning the context up
  // here is what lets the note path stay synchronous: by the time a pad sends
  // anything, the graph exists and is running. The boot call below is not a
  // gesture, so it deliberately does not do this.
  enableBtn.addEventListener('click', () => { ensureAudio().then(prewarmArmed); enableMidi() })
  // Electron resets Web MIDI access with every renderer restart. Reconnect a
  // previously-approved device so restarting the app cannot silently disable it.
  enableMidi()

  deviceSel?.addEventListener('change', () => {
    ensureAudio()
    MidiController.selectInput(deviceSel.value)
    _padsRouter?.resetKnobs()
    linkPads()
    if (deviceSel.value) localStorage.setItem(MIDI_DEVICE_KEY, deviceSel.value)
    syncMidiToken(deviceSel)
  })

  // Route live MIDI note events → track instruments (routeChannel), falling
  // back to the plain keyboard behaviour when no MIDI tracks exist at all.
  // Sustain (CC64) is resolved before anything else sees the stream: the pure
  // reducer swallows note-offs while a channel is held and flushes them on
  // release, so no instrument has to know the pedal exists.
  // Synchronous end to end. An awaited handler put every note at least one
  // microtask behind the MIDI callback that delivered it, and that jitter is
  // audible the moment you finger-drum.
  document.addEventListener('midi-event', (e) => {
    if (e.detail.device) _lastDevice = e.detail.device
    // Encoders, buttons and pressure of a recognised controller; its pads fall through.
    if (_padsRouter?.handle(e.detail)) return
    const { state, emit } = holdReducer(_holdState, e.detail)
    _holdState = state
    for (const event of emit) handleMidiEvent(event)
  })

  function handleMidiEvent(detail) {
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
    // The graph is built synchronously so this note can reach it now; resuming
    // a suspended context still needs a gesture, so that half stays async and
    // off the hot path. Both the MIDI enable button and every on-screen control
    // call ensureAudio() on their own gesture, so this rarely has work to do.
    const ctx = AudioEngine.ensureContext()
    if (!ctx) return
    if (ctx.state !== 'running') ensureAudio()

    // The controller stamps each message with its performance.now() arrival.
    // Scheduling against that instead of "whenever the main thread got here"
    // is what keeps a roll even under GC and store reads.
    const time = detail.audioTime ?? audioTimeFor(detail.time, performance.now(), ctx.currentTime)

    // Auto-provision: a note into an empty project makes the track it belongs
    // on, once. Note-offs never provision — they can only follow a note-on.
    if (detail.kind === 'note-on') {
      if (!_hot.midiTracks.length) ensureMidiTrack()
      // A hardware octave button has to be visible: scroll the key window to
      // the note instead of letting it disappear. Pads send percussion notes
      // that have nothing to do with the keys, so they are exempt.
      // Channel 10 is percussion: its note numbers are drum slots, not pitches.
      if (detail.source !== 'pad' && detail.source !== 'pads-view' && detail.source !== 'repeat' && detail.channel !== 9) Keyboard.ensureVisible(detail.pitch)
    }
    // Hot path: no store reads. Removed tracks are pruned by the store subscriber.
    const midiTracks = _hot.midiTracks
    const routeKey = `${detail.channel}:${detail.pitch}`
    const ids = detail.kind === 'note-off'
      ? (_soundingRoutes.get(routeKey) || routeChannel(midiTracks, detail.channel, _midiTargetTrackId))
      : routeChannel(midiTracks, detail.channel, _midiTargetTrackId)
    if (detail.kind === 'note-on') _soundingRoutes.set(routeKey, ids)
    else if (detail.kind === 'note-off') _soundingRoutes.delete(routeKey)

    for (const trackId of ids) {
      const track = _hot.byId.get(trackId)
      if (!track) continue
      // Arrange MIDI take: what this track is told to play, at the time it is told to play it.
      if (_take && (detail.kind === 'note-on' || detail.kind === 'note-off')) {
        _take.note({ trackId, pitch: detail.pitch, velocity: detail.velocity, on: detail.kind === 'note-on', time, source: `${detail.source ?? detail.device ?? 'keys'}:${detail.channel}` })
      }
      const entry = liveEntryFor(track)
      if (!entry) continue

      try {
        if (detail.kind === 'note-on') {
          // Pads view, armed kit only: Full / Ladder / Repeat press, once, before the voice.
          if (_currentMode === 'pads' && trackId === _hot.armedId && track.instrument?.type === 'kit') {
            if (_padsView?.overlayActive?.()) {   // pads are a menu while Overlay is held
              if (detail.source !== 'repeat') _padsView.pickPad(padOf(detail.pitch))   // on-screen pads already picked in the view
              continue
            }
            const shaped = shapePadsHit(detail)
            entry.inst.noteOn(shaped.detail.pitch, shaped.detail.velocity, time, shaped.override)
            padsNoteOn(trackId, shaped.detail, time, detail.pitch)
          } else entry.inst.noteOn(detail.pitch, detail.velocity, time)
        }
        else if (detail.kind === 'note-off') {
          entry.inst.noteOff(detail.pitch, time)
          if (_heldPads.delete(detail.pitch)) _repeat?.release(detail.pitch)
        }
        // ponytail: CC1/7/11/120/123 mapped. Add a CC-learn map when a sixth matters.
        else if (detail.kind === 'cc') {
          if (detail.controller === 1) entry.inst.send({ type: 'mod', value: detail.value / 127 })
          // Channel volume and expression ride the mixer channel's own gain.
          // Live only — the stored fader is untouched, so reopening the project
          // comes back at its saved level rather than wherever the knob was left.
          else if (detail.controller === 7 || detail.controller === 11) {
            if (track.mixerChannelId) MixerEngine.setVolume(track.mixerChannelId, detail.value / 127)
          }
          // All Sound Off / All Notes Off. Palette voices sustain until their
          // note-off, so one dropped note-off is a drone for the life of the
          // tab — and a drone the master limiter keeps ducking everything under.
          // Disposing is the panic; the next note-on rebuilds the instrument.
          else if (detail.controller === 120 || detail.controller === 123) {
            // An FM-1 device outlives its entry: silence it, never dispose it.
            if (entry.inst.panic) entry.inst.panic()
            else { entry.inst.dispose(); _liveInstruments.delete(trackId) }
          }
        }
        else entry.inst.send({ type: 'pitch-bend', value: detail.value })
      } catch (err) {}
    }

    // The panic disposed the instruments those routes pointed at; a stale entry
    // would send the next note-off to something already gone.
    if (detail.kind === 'cc' && (detail.controller === 120 || detail.controller === 123)) {
      for (const key of [..._soundingRoutes.keys()]) {
        if (key.startsWith(`${detail.channel}:`)) _soundingRoutes.delete(key)
      }
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

  // Selecting a MIDI track arms it
  document.addEventListener('track-selected', (e) => {
    const state = ProjectStore.getState()
    const track = state.tracks.find(t => t.id === e.detail.trackId)
    if (track && track.type === 'midi') {
      _midiTargetTrackId = track.id
      refreshHot()
      syncInstrumentUi()
      prewarmArmed()
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
  if (_currentMode === 'pads') return !!_loopPlayer?.isPlaying()
  return _currentMode === 'arrange' ? TimelinePlayer.isPlaying() : Sequencer.isPlaying()
}

/** Play's pressed state is derived, so a disabled button cannot desync it. */
function syncTransportPressed() {
  document.getElementById('global-play-btn')?.setAttribute('aria-pressed', isTransportPlaying() ? 'true' : 'false')
}

/** A modal owns the keyboard: global shortcuts must not fire behind it. */
function modalOpen() {
  return !!document.querySelector('dialog[open]:not([data-nonmodal])')
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
  if (assistantAvailable()) ShortcutManager.register({ key: 'a', ctrl: true, shift: true }, () => runCommand('assistant'))
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
  // Pads view: letter/number keys in the hardware's 4x4 shape (pad 1 bottom-left).
  PAD_KEY_ROWS.forEach((row, r) => row.forEach((key, c) => {
    ShortcutManager.register({ key, context: 'pads' }, (e) => {
      if (['SELECT', 'INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return
      if (!e.repeat) _padsView?.trigger((3 - r) * 4 + c, `key${key}`)
    })
  }))
  ShortcutManager.setContext(shortcutContext(_currentMode))

  // Mode switching. Blocked behind a modal: switchMode() rewrites the shortcut
  // context, which the dialog would then restore on top of when it closes.
  for (const [key, mode] of [['f1', 'synth'], ['f2', 'arrange'], ['f3', 'rack'], ['f4', 'tr909'], ['f5', 'pads']]) {
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
  Sequencer.init('seq-tracks', { playNote: sequencerPlayNote, lead: sequencerLead, onStop: () => _seqPlayer?.play.panic?.() })
  const tr909Container = document.getElementById('tr909-view')
  if (tr909Container) _tr909View = new Tr909View(tr909Container, { ensureAudio })
  initPadsView()

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
      packCatalog: () => _packCatalog,
      fm1Installed: () => _fm1.installed
    })
  }
  _instrumentSettings = new InstrumentSettings({
    store: ProjectStore,
    packCatalog: () => _packCatalog,
    warmPack: (pack, patch) => warmPack(pack, patch).catch(() => {}),
    fm1Installed: () => _fm1.installed,
    fm1CatalogRows: () => _fm1.rows,
    fm1Store: fm1Store(),
    fm1Compat: hash => _fm1.compat.get(hash) ?? null,
    openFm1Device,
    refreshFm1: refreshFm1Cache
  })
  _instrumentBrowser = new InstrumentBrowser({
    store: ProjectStore,
    packCatalog: () => _packCatalog,
    // tr909 is the 909 editor's own transport, not a playable voice.
    palettes: () => Object.fromEntries(Object.entries(Palettes).filter(([key]) => key !== 'tr909')),
    racks: () => ProjectStore.getState().racks,
    presets: () => ProjectStore.getState().presets || [],
    fm1Rows: () => _fm1.installed,
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
    usage: () => webPackStore()?.usage() ?? null,
    discovery: () => window.musicDiscovery || webDiscovery(),
    folders: folderLibrary,
    importPreset: async (bankPath, presetIndex, onProgress) => {
      const pack = await folderLibrary()?.importPreset(bankPath, presetIndex, { onProgress })
      if (pack) await refreshPackCatalog()
      return pack
    },
    // Importing is the audition path, so the imported preset lands on the armed
    // track straight away; a second activation only re-arms.
    armPack: (packId, packVersion, patchId) => {
      const instrument = { type: 'pack', packId, packVersion, patchId, programFollow: 'pinned' }
      const track = ensureMidiTrack(instrument)
      if (track) ProjectStore.dispatch(SetTrackInstrument(track.id, instrument))
    }
  })
  if (assistantAvailable()) {
    _assistantDialog = new AssistantDialog({ store: ProjectStore, packs: () => _packCatalog })
    document.addEventListener('open-assistant', () => _assistantDialog.open())
  }
  document.addEventListener('open-instrument-browser', () => { _instrumentBrowser.open(); refreshFm1Cache() })
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
    pruneFm1(state)   // before refreshHot/prewarm, which may acquire the replacement device
    const prevPads = _hot.pads
    refreshHot(state)
    _fm1.dialog?.refresh()   // track gone or no longer FM-1 -> close; new device -> re-bind
    if (_fm1Rec?.dialog?.isOpen()) _fm1Rec.dialog.refresh()   // FM-1 tracks added/renamed/removed
    if (_lessons?.active() && prevPads !== _hot.pads) _lessons.padsChanged(prevPads, _hot.pads, _loopPlayer?.isPlaying() ? _loopPlayer.currentBeat() : -1)
    syncMixerStrips(state)
    syncInstrumentUi()
    prewarmArmed()
    const armed = _hot.byId.get(_hot.armedId)?.instrument
    if (_padLink && (armed?.type === 'kit' ? armed.kitId : null) !== _padKitId) refreshPadLeds()
    // A removed track must go quiet immediately. Pruning only inside the MIDI
    // handler left a deleted track sounding until the next incoming event —
    // with no controller attached, forever.
    for (const [trackId, entry] of [..._liveInstruments]) {
      if (state.tracks.some(track => track.id === trackId)) continue
      try { entry.inst.dispose() } catch (err) {}
      _liveInstruments.delete(trackId)
    }
  })
  refreshHot()
  refreshPackCatalog().catch(error => console.warn('Could not load instrument packs:', error))
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot)
} else {
  boot()
}
