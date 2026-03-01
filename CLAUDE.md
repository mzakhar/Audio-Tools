# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Browser-based synthesizer SPA. No build step, no dependencies, no package manager. Open `index.html` directly in a browser to run.

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

## Key conventions

**Adding a new palette:** add an object to `palettes.js` following the existing interface, then register it in the `Palettes` map at the bottom and add a `.tab` button in `index.html`.

**Knob definitions:** each entry in `knobs[]` must have `{ key, label, min, max, step, fmt }`. `fmt` values: `'s'` (seconds), `'Hz'`, `'c'` (cents), `''` (raw float). The `reverb` key is special — `app.js` calls `AudioEngine.setReverb()` when it changes.

**Slider fill:** range inputs use a `--fill` CSS custom property set via JS (`slider.style.setProperty('--fill', pct+'%')`). Add class `filled` to activate the gradient.

**Black key positioning:** `left = (octaveCX + BLACK_OFFSET[semitone]) * WHITE_KEY_W - BLACK_KEY_W/2` where `BLACK_OFFSET = {1:1, 3:2, 6:4, 8:5, 10:6}` maps semitone → (prevWhiteIdx + 1).

**Recorder routing:** `Recorder.start()` disconnects `compressor → destination`, inserts `ScriptProcessor` in between, then restores on `stop()`. Always call `AudioEngine.init()` before starting the recorder.

**Sequencer tracks:** drum tracks use `drumIndex` (0–3); melodic tracks use `note` (MIDI number). `track.paletteKey === 'drum'` determines which field is active.
