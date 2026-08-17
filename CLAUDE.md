# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Browser-based DAW/synthesizer. Electron + electron-vite; renderer is also shipped standalone as a static nginx container. `npm run dev` for Electron, `npm run build` to emit `out/renderer`, `npm test` for vitest.

> Note: the Architecture section below predates the Electron/Vite rewrite — modules are ES modules with `import`/`export`, not IIFE globals, and live under `src/renderer/js/`. The module responsibilities are still broadly accurate.

## Architecture

All modules are plain IIFEs exposed as globals. Load order in `index.html` matters:

```
audio-engine.js → palettes.js → keyboard.js → sequencer.js → recorder.js → app.js
```

### Module responsibilities

- **`AudioEngine`** — singleton AudioContext + master gain chain. Must be initialized on a user gesture via `AudioEngine.init()`. All voice output connects to `AudioEngine.getMasterInput()`. Chain: `masterGain → dryGain + reverbSend → convolver → premaster → compressor → destination`.
- **`Palettes`** — four palette objects (`classic`, `fm`, `drum`, `pad`). Each has `params{}`, `knobs[]`, `selectors[]`, and `createVoice(ctx, output, freq, vel, time) → { stop(t) }`. The drum palette additionally has `createDrumVoice(ctx, output, drumIndex, vel, time)` (indices 0–3 = kick/snare/hihat/clap).
- **`Keyboard`** — renders 25-key piano (MIDI 48–72). Fires `'note-on'` / `'note-off'` CustomEvents on `document` with `{ detail: { note } }`. Handles mouse, touch, and PC keyboard input.
- **`Sequencer`** — 16-step lookahead scheduler. Maintains an array of `tracks[]`, each with `{ paletteKey, drumIndex, note, steps[] }`. Scheduler uses `setTimeout` at 25ms intervals with 100ms lookahead; playhead uses `requestAnimationFrame` against `stepTimes[]`.
- **`Recorder`** — taps `compressor` output via `ScriptProcessorNode` during recording; encodes interleaved stereo 16-bit PCM into a RIFF WAV and triggers browser download on stop.
- **`app.js`** — wires everything together: palette tab switching, knob panel rendering, master volume, BPM slider, transport buttons, drum pad UI, recorder UI. Entry point is `boot()`, called on `DOMContentLoaded`.

### Layout structure

```
#layout (flex row)
  #sidebar (72px) — tool switcher nav
  #main (flex: 1)
    #app — all synth UI (header, record-bar, knob-panel, keyboard-section, sequencer-section)
```

### Modular rack (in progress)

Specs are the source of truth: `specs/modular-rack.md`, `specs/modular-rack-modules.md`, and `specs/modular-rack-implementation-plan.md` (that last one carries the phase status table and the deferral list — read it before picking up rack work).

Phases 0–4 are in: rack UI, transport clocking, MIDI instruments, rack
inserts, PARAM OUT control polling, and offline rack bounce. Phase 5 remains
persistence/presets; Phase 6 remains remaining modules/polish.

```
store/ProjectStore.js   state.racks{}, schema version 2 + migrate(), rack commands
rack/rack-engine.js     mount/update/setParamLive/unmount — the only thing that
                        connects one module to another
rack/poly.js            resolveChannels — pure, every polyphony bug lives here
rack/rack-layout.js     PURE HP math (1 HP = 16 px), no DOM
rack/modules/index.js   registry + validateRegistry (throws in dev) + canConnect
rack/modules/*.js       one definition per module: ports, params, create(ctx, opts)
utils/cv.js             PURE 1 V/oct math — 0.1 CV = 1 octave, 0.0 = C4
```

External MIDI integration is specced in `specs/midi-bridge.md`. Phases 1–3 are
in: `midi/midi-message.js` parses raw bytes into typed events (channel nibble
kept, 0-indexed), `midi/midi-routing.js` maps a channel to the tracks that
claim it, `midi/live-instrument.js` plays a track live (palette voices, or a
lazily mounted rack driven through its `midi-in` module). `MidiController`
dispatches one `midi-event` on `document`; `app.js` routes it. Clock in
(phase 4) and MIDI out (phase 5) are not started — build them only when
something on the other end needs them.

Web MIDI is secure-context only, so none of it works on the LAN http route.

Phase 4 integration:

- MIDI tracks use `instrument: { type: 'palette', paletteKey }` or
  `{ type: 'rack', rackId }`; `TimelinePlayer` uses one note strategy for both.
- `audio-in` exposes host audio only; it never requests microphone access.
- `param-out` polls at 60 Hz. Current target syntax supports
  `<channelId>.volume` and `<channelId>.pan` during rack-track playback.

Rules that are not negotiable:

- `create(ctx, { channels, params })` takes the context as an argument and reads **no** globals — that is what makes offline bounce and the fake-context tests work.
- `inputs`/`outputs` are objects of **arrays indexed by poly channel**, holding `AudioNode`s or `AudioParam`s. A module never connects to another module.
- `dispose()` stops and disconnects everything it made. The leak test asserts no source is left running after `unmount`.
- Attenuverters, cycle-breaking `DelayNode`s and poly→mono mixdown are the engine's job, never a module's.
- Nothing on the basic-voice path (VCO/VCF/VCA/ADSR/LFO/NOISE/MIX/OUT) may be worklet tier — the LAN deploy is plain HTTP and has no `audioWorklet`.
- Gates from a scheduler travel in the **event domain** (`inst.onEvent(port, { type, time, channel })` with a future timestamp), not as a polled signal. That is how ADSR stays sample-accurate without a worklet.

## Key conventions

**Adding a new palette:** add an object to `palettes.js` following the existing interface, then register it in the `Palettes` map at the bottom and add a `.tab` button in `index.html`.

**Knob definitions:** each entry in `knobs[]` must have `{ key, label, min, max, step, fmt }`. `fmt` values: `'s'` (seconds), `'Hz'`, `'c'` (cents), `''` (raw float). The `reverb` key is special — `app.js` calls `AudioEngine.setReverb()` when it changes.

**Slider fill:** range inputs use a `--fill` CSS custom property set via JS (`slider.style.setProperty('--fill', pct+'%')`). Add class `filled` to activate the gradient.

**Black key positioning:** `left = (octaveCX + BLACK_OFFSET[semitone]) * WHITE_KEY_W - BLACK_KEY_W/2` where `BLACK_OFFSET = {1:1, 3:2, 6:4, 8:5, 10:6}` maps semitone → (prevWhiteIdx + 1).

**Recorder routing:** `Recorder.start()` disconnects `compressor → destination`, inserts an `AudioWorkletNode` in between, then restores on `stop()`. Always `await AudioEngine.init()` before starting the recorder, and check `AudioEngine.hasRecorder()` — `ctx.audioWorklet` does not exist outside a secure context (plain-http origins), so the worklet load is best-effort and recording is unavailable there. Nothing else in the app may depend on the worklet.

**Sequencer tracks:** drum tracks use `drumIndex` (0–3); melodic tracks use `note` (MIDI number). `track.paletteKey === 'drum'` determines which field is active.

## Deployment (home lab)

Full operational note lives in the Obsidian vault: `E:\Obsidian\Hivemind\40 Operations\Home Lab\Apps\Synth.md` (see also `Home Lab.md`, `Machines.md`, `Network.md` in that folder). Read it before touching deploy config — it is the source of truth.

Short version:

| | |
|---|---|
| Host | `themachine` (k3s, `192.168.1.3`) — `ssh mzakhar@themachine`, key-based, no password |
| LAN URL | `http://themachine/synth/` (Traefik StripPrefix) — **not** a secure context |
| External URL | `https://synth.zakharhome.org` (Cloudflare Tunnel terminates TLS) — secure context |
| Image | `ghcr.io/mzakhar/audio-tools:main`, built by `.github/workflows/container.yml` |
| Reconciler | **Flux CD**, `GitRepository/audio-tools` → `deploy/k8s` on `main`. Flux is the mechanism; `scripts/deploy-k3s.sh` + `deploy/systemd/` are a manual fallback only |

Useful checks over ssh:

```sh
ssh mzakhar@themachine 'kubectl -n synth get pods,ing'
ssh mzakhar@themachine 'kubectl -n flux-system get kustomization synth'
ssh mzakhar@themachine 'kubectl -n synth logs deploy/synth --tail=50'
```

Because the LAN route is plain http, anything gated on `window.isSecureContext` (AudioWorklet, MediaDevices, Clipboard, Web MIDI in some builds) is unavailable there but works on the `zakharhome.org` host. Never let a secure-context-only API sit on the critical path of core audio.
