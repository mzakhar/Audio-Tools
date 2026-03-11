# Synth DAW — Product Specification

## 1. Product Vision & Target Audience

**Target audience:** Hobbyist producers. The application balances an accessible, intuitive interface (GarageBand-level approachability) with the core capabilities of a modern DAW.

**Platform:** Electron desktop application, built on web technologies (HTML5, JS, Web Audio API, WebAssembly). The renderer layer remains standard web code; Electron provides native file system access, OS integration, and packaging.

**Design references:** GarageBand (approachability), Ableton Live (clip/pattern model), Reaper (project file simplicity).

---

## 2. Build System

**Toolchain: `electron-vite`**

- Vite handles the renderer (AudioWorklet module URLs via `?worker&url`, Wasm imports, ES module bundling, HMR in dev)
- `electron-vite` provides separate configs for `main` (Node), `preload` (contextBridge), and `renderer` (web app)
- All existing IIFEs and manual `<script>` load ordering are replaced with ES module imports
- **Test runner: Vitest** — zero additional config with Vite, same module resolution

**Module system:** Replace all IIFEs with ES modules. Each file exports its singleton or factory. `app.js` is the renderer entry point imported by Vite.

---

## 3. Project File Format

Projects are saved as a **folder bundle** on disk, aligning with GarageBand (`.band`), Logic (`.logicx`), and similar DAWs.

```
MyProject/
  project.json        ← all project state (see schema below)
  audio/              ← copies of all imported audio files
    sample-a.wav
    drum-loop.wav
```

### `project.json` schema (top level)

```json
{
  "version": 1,
  "bpm": 120,
  "timeSignature": [4, 4],
  "sampleRate": 44100,
  "tracks": [ /* Track[] */ ],
  "mixer": { /* MixerState */ },
  "patterns": { /* id → PatternClip */ },
  "history": []
}
```

### Track

```json
{
  "id": "track-1",
  "name": "Drums",
  "type": "audio | pattern | midi",
  "mixerChannelId": "ch-1",
  "clips": [ /* Clip[] */ ]
}
```

### Clip types

| Type | Key fields |
|---|---|
| `AudioClip` | `file` (relative path in `audio/`), `startBeat`, `duration`, `offset`, `fadeIn`, `fadeOut` |
| `PatternClip` | `patternId` (ref into `patterns` map), `startBeat`, `repeatCount` |
| `MidiClip` | `notes` (array of `{pitch, startBeat, duration, velocity}`), `startBeat`, `duration` |

### File I/O adapter interface

Both browser (File System Access API) and Electron (Node `fs` via IPC) implement the same interface so all project code stays platform-agnostic:

```js
// src/io/FileAdapter.js
export default {
  async readProject(handle)    → { json, audioHandles[] }
  async writeProject(state)    → void
  async importAudio(handle)    → ArrayBuffer
  async exportWav(buffer)      → void
}
```

The Electron preload script exposes `window.electronFS` via `contextBridge`; the adapter switches implementations at runtime.

---

## 4. Audio Engine Architecture

### 4.1 Master signal chain

```
TrackGain(n) ──┐
               ├──→ MasterGain → DryGain ──────────────────→ PreMaster → Compressor → destination
               │                └──→ ReverbSend → Convolver ──┘
TrackGain(n) ──┘
```

Each track feeds into the master chain via its own `GainNode`. Per-track effects are inserted between the track source and `TrackGain`.

### 4.2 AudioWorklet migration — phased

Moving all processing off the main thread in three phases:

**Phase 1 (MVP prerequisite):** Replace `ScriptProcessorNode` in the recorder with an `AudioWorkletProcessor`. The worklet collects PCM samples into a ring buffer; the main thread drains it for WAV encoding. Eliminates the deprecated API and main-thread audio callbacks.

**Phase 2 (post-MVP):** Per-track effects (EQ, compression, reverb send) implemented as `AudioWorkletProcessor` subclasses. Each effect exposes `AudioParam`-compatible parameters for automation.

**Phase 3 (later):** Synthesis engines (palettes) restructured as `AudioWorkletNode` wrappers. The `createVoice` interface becomes a message-passing protocol: main thread sends `{ type: 'noteOn', freq, vel, time }`, worklet manages oscillators internally. Deferred until Phase 2 is stable — assess complexity then.

### 4.3 Performance targets

| Metric | Target |
|---|---|
| Audio round-trip latency | ≤ 10ms |
| Timeline frame rate | 60fps at ≥ 32 tracks, ≥ 5 min visible |
| Waveform LOD computation | Web Worker, never blocks render thread |
| MVP track count | ≥ 8 simultaneous audio tracks |
| AudioWorklet buffer size | 128 frames (Web Audio default) |

### 4.4 Memory management

- Audio buffers stored as `Float32Array` slices; source `AudioBuffer` retained once, clips reference it with `offset`/`duration`
- Waveform LOD levels (peak/RMS per N samples) pre-computed in a `Worker` after import, cached in memory and optionally written to `audio/.cache/`
- Large file imports (> 50MB) decoded via Wasm decoder in a Worker to avoid blocking the audio context

---

## 5. State Management

### 5.1 Central project store

A single plain JS object (`ProjectStore`) holds all mutable project state. All UI panels read from and write to this store via defined actions — no panel directly mutates another panel's state.

```js
// src/store/ProjectStore.js
export const store = {
  state: { /* matches project.json schema */ },
  dispatch(command) { /* execute + push to history */ },
  subscribe(listener) { /* notify on state change */ }
}
```

Panels communicate through events (`CustomEvent` on a shared bus), not direct references.

### 5.2 Undo/redo — command pattern

Every user-initiated edit is a command object pushed to a history stack:

```js
{
  execute(state) → newState,
  undo(state)    → previousState,
  label: 'Move clip'
}
```

`dispatch()` calls `execute`, pushes to `undoStack`, clears `redoStack`. History is not persisted to `project.json` (field is reserved for future use). Default undo depth: 100 commands.

Commands that must be defined before MVP: `AddTrack`, `RemoveTrack`, `AddClip`, `MoveClip`, `TrimClip`, `SetMixerParam`.

---

## 6. UI/UX — Four-Panel Layout

```
┌──────────────────────────────────────────────────────┐
│  Toolbar: transport, BPM, time display, master vol   │
├────────┬─────────────────────────────────────────────┤
│        │  Arrangement View (Canvas — center)         │
│Browser │  Multi-track timeline, clips, playhead      │
│(sidebar│─────────────────────────────────────────────┤
│       )│  Piano Roll (collapsible drawer, bottom)    │
│        │  MIDI note editing, velocity, quantize      │
├────────┴─────────────────────────────────────────────┤
│  Mixer (tabbed strip): faders, pan, insert slots     │
└──────────────────────────────────────────────────────┘
```

**Arrangement View (Canvas):** 2D Canvas with virtual scrolling. Tracks are rows; time is the horizontal axis in beats. Waveform thumbnails drawn from pre-computed LOD data. Handles clip selection, drag-move, drag-trim (left/right edges). Double-clicking a `PatternClip` opens the existing 16-step sequencer UI as the pattern editor in a drawer or modal.

**Browser (sidebar):** File tree of the project `audio/` folder + a "Local Files" section for importing from anywhere on disk. Drag audio files from the browser onto the timeline to create `AudioClip`s.

**Mixer:** One channel strip per track + master bus. Each strip: label, volume fader, pan knob, mute/solo, up to 4 insert effect slots (Phase 2). Sends/returns wired to the reverb bus.

**Piano Roll:** Draws MIDI notes as rectangles on a pitch × time grid. Tools: draw, select, erase. Quantize snap selector. Velocity lane below note grid. Opens when a `MidiClip` is double-clicked.

**Existing synth UI:** The palette tabs, knob panel, on-screen keyboard, and 16-step sequencer are retained as a "Synth" mode accessible from the sidebar. The step sequencer output becomes a `PatternClip` source.

---

## 7. Feature Development Roadmap

Development is sequential. Each phase fully merges to `main` before the next begins.

### Phase 0 — Foundation (current sprint)
- [ ] Migrate build system to `electron-vite`; convert all IIFEs to ES modules
- [ ] Set up Vitest; write smoke tests for existing Sequencer and palette round-trips
- [ ] Define and implement `FileAdapter` interface (browser impl first)
- [ ] Define `ProjectStore` and command pattern skeleton
- [ ] AudioWorklet Phase 1: replace `ScriptProcessorNode` recorder

### Phase 1 — MVP
- [ ] Canvas Arrangement View: render tracks, audio clips, waveform thumbnails, playhead
- [ ] Audio import: `FileAdapter.importAudio` → copy to `audio/`, decode, create `AudioClip`
- [ ] Non-destructive trim: drag clip edges; `AudioBufferSourceNode.start(when, offset, duration)`
- [ ] `OfflineAudioContext` bounce → WAV download
- [ ] Minimal mixer: per-track volume + pan
- [ ] Save/load `project.json` via `FileAdapter`
- [ ] Undo/redo for clip operations
- [ ] Electron packaging (unsigned, local use)

### Phase 2 — Effects & Routing
- [ ] Per-track effect insert chain (EQ, compression, reverb send)
- [ ] AudioWorklet Phase 2: effects as worklet processors
- [ ] Sends/returns in the mixer
- [ ] Wasm decoders for large file imports (MP3, FLAC)
- [ ] Export to MP3/FLAC via WebCodecs + Wasm

### Phase 3 — MIDI & Piano Roll
- [ ] Web MIDI API: `requestMIDIAccess`, device selector, graceful denial fallback
- [ ] MIDI recording: capture events with `performance.now()` timestamps → `MidiClip`
- [ ] Piano Roll UI: draw, select, erase, quantize
- [ ] Pattern Clip editor: 16-step sequencer as clip editor (already exists, needs integration)

### Phase 4 — Polish & Distribution
- [ ] AudioWorklet Phase 3: synthesis engines (assess need at this point)
- [ ] Electron code signing + auto-update
- [ ] Keyboard shortcut system
- [ ] Accessibility pass (ARIA, keyboard navigation)

---

## 8. Security Hardening

### Electron process model
- `nodeIntegration: false`, `contextIsolation: true` on all `BrowserWindow` instances
- All Node.js file system access goes through `contextBridge`-exposed IPC handlers in the preload script
- IPC handlers in the main process validate every argument: path canonicalization, allowlisted operations, no `eval`
- `webSecurity: true` (default); never disable

### Path traversal prevention
All audio file paths stored in `project.json` are relative (e.g., `audio/sample.wav`). On load, the main process resolves each path against the project root and verifies it does not escape the project directory before opening:

```js
const resolved = path.resolve(projectRoot, relativePath)
if (!resolved.startsWith(projectRoot)) throw new Error('Path traversal rejected')
```

### Audio file validation
Before calling `decodeAudioData` or a Wasm decoder, validate:
1. File extension is in the allowlist (`wav`, `mp3`, `flac`, `ogg`, `aiff`)
2. Magic bytes match the declared type (e.g., `RIFF` for WAV, `ID3`/`ff fb` for MP3)
3. File size is below a configurable limit (default 500MB) to prevent OOM

Wrap all decode calls in try/catch; show a user-facing error without crashing the audio context.

### MIDI
- Request MIDI access only on explicit user action (not on app boot)
- Never log device names, manufacturer strings, or raw CC data to the console in production builds
- Graceful UI fallback if `requestMIDIAccess` is denied or unavailable

### Content Security Policy
Set in Electron's `webContents` session and as a `<meta>` tag in the renderer HTML:
```
default-src 'self';
script-src 'self';
worker-src blob:;
img-src 'self' data: blob:;
media-src 'self' blob:;
connect-src 'none';
```

### Wasm
- All Wasm modules (audio decoders) are bundled at build time by Vite — no runtime CDN fetches
- Wasm runs in a Worker with no DOM access

---

## 9. Test Coverage Plan

**Runner:** Vitest (co-located with Vite, no extra config)
**Audio testing:** `OfflineAudioContext` for signal chain assertions
**Coverage target:** ≥ 80% line coverage on Sequencer, ProjectStore, FileAdapter, and project serialization

### Unit tests

| Module | What to test | How |
|---|---|---|
| `Sequencer` | Step timing math, lookahead accuracy, BPM changes, track mutations | Inject fake clock; assert `stepTimes[]` deterministically |
| `ProjectStore` | State transitions for each command; undo/redo stack integrity; history depth cap | Pure JS — no DOM or audio context needed |
| Project serialization | Round-trip: `serialize(state) → deserialize() → state` identity; path traversal rejection | Pure JS |
| `FileAdapter` | Browser and Electron implementations return identical shapes | Mock `FileSystemDirectoryHandle` and `fs` behind the interface |
| Palette `createVoice` | Correct node connections; envelope shape (attack, decay, release timing) | `OfflineAudioContext`; assert peak amplitude and zero-crossing |
| Waveform LOD | Peak/RMS bucketing at multiple zoom levels | Feed a known synthetic buffer; assert bucket values exactly |
| Piano roll quantization | Snap-to-grid math; note collision detection | Pure math functions; trivial unit tests |
| Path traversal guard | Paths with `..` are rejected; paths within project root are accepted | Unit test the validation function |

### Integration tests

| Scenario | How |
|---|---|
| Import audio → appears on timeline → bounce → WAV has non-zero samples | `OfflineAudioContext` + mock FileAdapter |
| Save project → reload → state identical to original | Round-trip through `FileAdapter` mock |
| Undo/redo across 10 clip operations | Drive `ProjectStore.dispatch()` programmatically |
| AudioWorklet recorder captures signal | Render known tone to worklet; assert PCM output matches |

### End-to-end (Electron)

| Scenario | How |
|---|---|
| Boot app, create track, import audio, press play | Playwright against the Electron window |
| Save project to temp folder, relaunch, project loads | Playwright with temp directory fixture |

### What is NOT tested
- CSS and visual layout
- Canvas pixel output (too brittle; visual regression tools can cover this separately if needed)
- Browser MIDI hardware (tested manually against a real device)

---

## 10. Development Workflow

**Branch strategy (sequential, solo developer):**

```
main
 └─ feature/build-system       (Phase 0 — foundation)
     └─ feature/audio-worklet-p1
         └─ feature/mvp-timeline
             └─ feature/mvp-export
                 └─ feature/effects
                     └─ ...
```

Each feature branch is created from the previous one after merge. Git worktrees are useful for keeping a stable reference branch checked out alongside active work:

```bash
git worktree add ../Synth-stable main   # read-only reference while working on a feature
```

**PR process:** Even for a solo developer, open a PR per feature branch. Use it as a checkpoint to review the diff, run CI (Vitest), and write a short description of what changed before merging.

**CI (GitHub Actions):**
- `vitest run` on every push
- `electron-vite build` smoke check (no packaging, just verifies the build succeeds)
- Lint with ESLint (no Prettier — formatting is low priority)
