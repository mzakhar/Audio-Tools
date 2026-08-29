# AGENTS.md

Guidance for coding agents working in this repository. `CLAUDE.md` points here;
this file is the only copy.

## Project

Browser-based DAW/synthesizer. Electron + electron-vite; the renderer also ships
standalone as a static nginx container.

| | |
|---|---|
| `npm run dev` | Electron with the renderer dev server |
| `npm run build` | emits `out/renderer` |
| `npm test` | vitest |

## Architecture

ES modules with `import`/`export` under `src/renderer/js/`. There is no global
load order to respect — import what you need.

### Module responsibilities

- **`AudioEngine`** — singleton AudioContext + master gain chain. Must be
  initialized on a user gesture via `AudioEngine.init()`. All voice output
  connects to `AudioEngine.getMasterInput()`. Chain:
  `masterGain → dryGain + reverbSend → convolver → premaster → compressor → destination`.
- **`Palettes`** — five palettes (`classic`, `fm`, `drum`, `tr909`, `pad`). Each
  has `params{}`, `knobs[]`, `selectors[]`, and
  `createVoice(ctx, output, freq, vel, time) → { stop(t) }`. The drum palette
  additionally has `createDrumVoice(ctx, output, drumIndex, vel, time)`
  (indices 0–3 = kick/snare/hihat/clap). `tr909` is the 909 editor's transport,
  not a playable voice — `app.js` filters it out of instrument pickers.
- **`Keyboard`** — renders a 25-key piano (MIDI 48–72). Fires `'note-on'` /
  `'note-off'` CustomEvents on `document` with `{ detail: { note } }`. Handles
  mouse, touch, and PC keyboard input.
- **`Sequencer`** — 16-step lookahead scheduler over `tracks[]`, each
  `{ paletteKey, drumIndex, note, steps[] }`. `setTimeout` at 25 ms with 100 ms
  lookahead; playhead uses `requestAnimationFrame` against `stepTimes[]`.
- **`Recorder`** — taps the `compressor` output through an `AudioWorkletNode`
  during recording, encodes interleaved stereo 16-bit PCM into a RIFF WAV, and
  triggers a browser download on stop.
- **`app.js`** — wires everything together. Entry point is `boot()`, called on
  `DOMContentLoaded`.

`ProjectStore` schema is at **version 5**, with `migrate()` in
`src/renderer/js/store/ProjectStore.js` (`CURRENT_VERSION` at line 15). Bump both
together and add a migration step; never renumber an existing one.

### Layout structure

```
#layout (flex row)
  #sidebar (72px) — tool switcher nav
  #main (flex: 1)
    #app — header, record-bar, knob-panel, keyboard-section, sequencer-section
```

### Modular rack

Specs are the source of truth: `specs/modular-rack.md`,
`specs/modular-rack-modules.md`, and `specs/modular-rack-implementation-plan.md`
(that last one carries the phase status table and the deferral list — read it
before picking up rack work).

Phases 0–4 are in: rack UI, transport clocking, MIDI instruments, rack inserts,
PARAM OUT control polling, and offline rack bounce. Phase 5 remains
persistence/presets; phase 6 remains the remaining modules and polish.

```
store/ProjectStore.js   state.racks{}, schema version + migrate(), rack commands
rack/rack-engine.js     mount/update/setParamLive/unmount — the only thing that
                        connects one module to another
rack/poly.js            resolveChannels — pure, every polyphony bug lives here
rack/rack-layout.js     PURE HP math (1 HP = 16 px), no DOM
rack/modules/index.js   registry + validateRegistry (throws in dev) + canConnect
rack/modules/*.js       one definition per module: ports, params, create(ctx, opts)
utils/cv.js             PURE 1 V/oct math — 0.1 CV = 1 octave, 0.0 = C4
```

Rules that are not negotiable:

- `create(ctx, { channels, params })` takes the context as an argument and reads
  **no** globals — that is what makes offline bounce and the fake-context tests
  work.
- `inputs`/`outputs` are objects of **arrays indexed by poly channel**, holding
  `AudioNode`s or `AudioParam`s. A module never connects to another module.
- `dispose()` stops and disconnects everything it made. The leak test asserts no
  source is left running after `unmount`.
- Attenuverters, cycle-breaking `DelayNode`s and poly→mono mixdown are the
  engine's job, never a module's.
- Nothing on the basic-voice path (VCO/VCF/VCA/ADSR/LFO/NOISE/MIX/OUT) may be
  worklet tier — the LAN deploy is plain HTTP and has no `audioWorklet`.
- Gates from a scheduler travel in the **event domain**
  (`inst.onEvent(port, { type, time, channel })` with a future timestamp), not as
  a polled signal. That is how ADSR stays sample-accurate without a worklet.

### MIDI

Specced in `specs/midi-bridge.md`. Phases 1–3 are in: `midi/midi-message.js`
parses raw bytes into typed events (channel nibble kept, 0-indexed),
`midi/midi-routing.js` maps a channel to the tracks that claim it,
`midi/live-instrument.js` plays a track live (palette voices, or a lazily
mounted rack driven through its `midi-in` module). `MidiController` dispatches
one `midi-event` on `document`; `app.js` routes it. Clock in (phase 4) and MIDI
out (phase 5) are not started — build them only when something on the other end
needs them.

Phase 3b (sustain CC64 hold, bend/mod for pack and palette voices, aftertouch
parsing) is the next MIDI work. Knob learn, transport buttons, MIDI monitor and
clock are **deferred** in `specs/midi-control-surface.md` — that file is a stash,
not a plan; do not build from it without a fresh decision.

Web MIDI is secure-context only, so none of it works on the LAN http route.

### Instrument packs and the SoundFont library

`specs/instrument-packs.md` owns the pack format, GM program-change routing, and
the import pipeline. `specs/soundfont-library.md` owns browsing a folder of
banks; all its phases have shipped.

```
shared/riff.js                  RIFF primitives, shared so the two below need
                                not import each other
shared/sf2-index.js             bank metadata from positional reads; naming rules
shared/sf2-import.js            SF2/SF3 to manifest + audio, optional preset filter
main/soundfont-folders.js       registered folders, cached incremental index
main/instrument-packs.js        install, validate, read, append a preset
instruments/soundfont-folder-web.js   the browser half, over IndexedDB handles
```

Facts worth not rediscovering:

- Identity comes from the **filename**. `INAM` is present in every real bank but
  collides across 101 of 500, so it is a display title only.
- A bank's `presets` array position **is** the phdr index and the patch id
  (`sf2-N`). Never sort, filter, or reindex that array — a row must carry its
  original index or the wrong instrument gets imported.
- Indexing never reads `sdta`. Indexing 500 banks reads ≤0.6 MB each.
- A zone the parser cannot honour is skipped, never fatal. One ROM reference or
  one bad sample must not cost a bank its other 500 presets.
- Per-preset import appends into one pack per bank: samples are written first
  and the manifest last, because the manifest is the commit point.
- `importSf2Preset` takes a path named by the renderer, so the folder registry
  is what authorizes reading it. Do not weaken that check.

### UI shell and instrument selection

`specs/ui-shell.md` and `specs/instrument-browser.md` are one plan in two files.
Rules they establish, which apply to any UI work:

- A control stays on screen only if it changes while you play. Everything else is
  a native `<dialog>` (or `popover` for menus) on a shortcut, reachable from the
  `⋯` menu. No new bar, rail or sidebar.
- One selection concept: the armed MIDI track's `instrument`.
- One instrument factory serves audition, live play and timeline playback.
- Input (keys, pads, MIDI) and source (palette, pack, rack) are separate axes.
  Palette tabs are not a source picker.
- MIDI tracks use `instrument: { type: 'palette', paletteKey }` or
  `{ type: 'rack', rackId }`; `TimelinePlayer` uses one note strategy for both.
- `audio-in` exposes host audio only; it never requests microphone access.
- `param-out` polls at 60 Hz, targeting `<channelId>.volume` and
  `<channelId>.pan` during rack-track playback.

## Key conventions

**Adding a palette:** add an object to `palettes.js` following the existing
interface, register it in the `Palettes` map at the bottom, and add a `.tab`
button in `index.html`.

**Knob definitions:** each entry in `knobs[]` needs
`{ key, label, min, max, step, fmt }`. `fmt` is `'s'` (seconds), `'Hz'`, `'c'`
(cents), or `''` (raw float). The `reverb` key is special — `app.js` calls
`AudioEngine.setReverb()` when it changes.

**Slider fill:** range inputs use a `--fill` CSS custom property set from JS
(`slider.style.setProperty('--fill', pct + '%')`). Add class `filled` to
activate the gradient.

**Black key positioning:**
`left = (octaveCX + BLACK_OFFSET[semitone]) * WHITE_KEY_W - BLACK_KEY_W / 2`
where `BLACK_OFFSET = {1:1, 3:2, 6:4, 8:5, 10:6}` maps semitone →
(prevWhiteIdx + 1).

**Recorder routing:** `Recorder.start()` disconnects `compressor → destination`,
inserts an `AudioWorkletNode` between, then restores on `stop()`. Always
`await AudioEngine.init()` first and check `AudioEngine.hasRecorder()` —
`ctx.audioWorklet` does not exist outside a secure context, so the worklet load
is best-effort and recording is unavailable there. Nothing else may depend on
the worklet.

**Sequencer tracks:** drum tracks use `drumIndex` (0–3); melodic tracks use
`note` (MIDI number). `track.paletteKey === 'drum'` decides which is active.

**Secure context:** the LAN route is plain HTTP, so anything gated on
`window.isSecureContext` (AudioWorklet, MediaDevices, Clipboard,
`showDirectoryPicker`, Web MIDI in some builds) is unavailable there but works on
the `zakharhome.org` host. Never let a secure-context-only API sit on the
critical path of core audio.

**CSP:** the renderer ships `connect-src 'none'` — the app makes no network
requests at all. Anything that would need one is a deliberate, reviewed change.

## Deployment

Full operational note lives in the Obsidian vault:
`E:\Obsidian\Hivemind\40 Operations\Home Lab\Apps\Synth.md` (see also
`Home Lab.md`, `Machines.md`, `Network.md`). Read it before touching deploy
config.

| | |
|---|---|
| Host | `themachine` (k3s, `192.168.1.3`) — `ssh mzakhar@themachine`, key-based |
| LAN URL | `http://themachine/synth/` (Traefik StripPrefix) — **not** a secure context |
| External URL | `https://synth.zakharhome.org` (Cloudflare Tunnel terminates TLS) — secure context, and currently **unauthenticated** |
| Image | `ghcr.io/mzakhar/audio-tools:main`, built by `.github/workflows/publish-image.yml` |
| Reconciler | Flux CD in **`E:\Projects\homelab-fleet`**, not this repo. `scripts/deploy-k3s.sh` and `deploy/systemd/` are a legacy manual fallback |

### How a deploy actually happens

The digest is pinned in the **fleet repo**, not here. This repo's
`deploy/k8s/deployment.yaml` references the floating `:main` tag, and the Flux
Kustomization applies an `images:` override keyed on
`ghcr.io/mzakhar/audio-tools` that wins over it. **Editing the image line in this
repo deploys nothing.** A deploy is a change to the fleet file.

1. Merge the Audio-Tools PR, then wait for `Publish container image` to pass for
   that merge commit.
2. Resolve that commit's digest from its immutable `sha-<full-sha>` tag. Do
   **not** read `:main` — it moves as soon as any later commit builds, so
   reading it races every other merge:

   ```sh
   SHA=$(git rev-parse HEAD)
   TOKEN=$(curl -s "https://ghcr.io/token?scope=repository:mzakhar/audio-tools:pull&service=ghcr.io" \
     | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
   curl -sI -H "Authorization: Bearer $TOKEN" \
     -H "Accept: application/vnd.oci.image.index.v1+json" \
     "https://ghcr.io/v2/mzakhar/audio-tools/manifests/sha-$SHA" | grep -i docker-content-digest
   ```

3. In `E:\Projects\homelab-fleet`, branch, update
   `clusters/themachine/apps/synth.yaml` → `spec.images[0].digest`, and update
   the comment above it naming the Audio-Tools commit and what shipped. Commit as
   `feat(synth): deploy <sha> — <summary>`, then PR and merge.
4. Flux polls the source every **1 minute** and reconciles the synth
   Kustomization every **10 minutes**. Wait, do not restart pods by hand.

### Verifying

```sh
ssh mzakhar@themachine 'kubectl -n synth get pods,ing'
ssh mzakhar@themachine 'kubectl -n flux-system get kustomization synth'
ssh mzakhar@themachine 'kubectl -n synth get deploy synth -o jsonpath="{.spec.template.spec.containers[0].image}"'
ssh mzakhar@themachine 'kubectl -n synth logs deploy/synth --tail=50'
```

A green Flux status does not prove the new code is serving. Two checks that do:

- The running image digest equals the `sha-<commit>` digest you pinned.
- The live bundle contains something that commit introduced:

  ```sh
  ASSET=$(curl -s https://synth.zakharhome.org/ | grep -o 'assets/index-[A-Za-z0-9_-]*\.js')
  curl -s "https://synth.zakharhome.org/$ASSET" | grep -c 'a string the change introduced'
  ```

**Do not** compare the deployed `index-*.js` hash against a local `npm run build`.
Vite's chunk hash is content-derived, and a Windows checkout with CRLF line
endings builds different bytes than the Linux `node:20-alpine` container, so the
hashes legitimately differ for identical source — `npm ci` does not change this.
That mismatch already caused one false "the deploy shipped stale code" alarm.
