# Palette state — implementation brief (specs/palette-state.md, phase 0+1)

Exact file:line pointers gathered by investigation. No fix code below.

## 1. `src/renderer/js/palettes.js` (434 lines total)

Header docblock: lines 1-8. Shared helpers: `noteToFreq` (12), `applyADSR` (16-23).

| Palette | `params{}` | `createVoice` | `createDrumVoice` | `this.params` reads |
|---|---|---|---|---|
| classic | 30-39 | 52-87 | — | `const p = this.params` at 53 |
| fm | 95-103 | 114-166 | — | `const p = this.params` at 115 |
| drum | 204-210 | 234-239 (delegates) | 221-231 | `const p = this.params` at 222 (createDrumVoice); `createVoice` (234) has no local `p`, just maps freq to drumIndex and calls `this.createDrumVoice` |
| tr909 | 426 (`{ reverb: 0.12 }`) | 429 (stub `{stop(){}}`) | 430 (stub) | none - not a playable voice, `knobs:[]`/`selectors:[]` at 427-428 |
| pad | 347-355 | 366-416 | — | `const p = this.params` at 367 |

Drum-specific private methods (read decay/v as already-extracted scalar args, not this.params directly): `_kick` 241-257, `_snare` 259-291, `_hihat` 293-312, `_clap` 314-339. `createDrumVoice` (222) is the only place that dereferences `this.params` for the drum palette; a `params` argument threaded into `createDrumVoice` only needs to change line 222.

Noise-buffer cache (unrelated to params, do not touch): `NOISE_SECONDS`/`noiseBufCache`/`getNoiseBuffer` 176-188, `startNoise` 197-199.

`knobs[]` shape (exact fields, all palettes): `{ key, label, min, max, step, fmt }`, optional `log: true` (classic `cutoff` line 45, pad `cutoff` line 362). `fmt` values in use: `'s'`, `'Hz'`, `'c'`, `''`.

`selectors[]` shape: `{ key, label, options: [...] }`. Only `classic.selectors` (49-51) is non-empty; every other palette has `selectors: []` (113, 218, 365, 428).

Export map: line 433 `const Palettes = { classic: classicPalette, fm: fmPalette, drum: drumPalette, tr909: tr909Palette, pad: padPalette }`, default-exported line 434. Named export `{ noteToFreq, applyADSR }` at line 421 sits between the drum palette and the pad palette in file order (harmless in JS, note if inserting a new export near there).

## 2. All `createVoice` / `createDrumVoice` call sites

Production (must gain a `params` argument per spec):
- `src/renderer/js/midi/live-instrument.js:133` — `voice = palette.createDrumVoice(ctx, output, index, velocityGain(velocity), t)` — inside the `noteOn` closure returned by `instrumentFor` (drum branch).
- `src/renderer/js/midi/live-instrument.js:136` — `voice = palette.createVoice(ctx, output, freq, velocityGain(velocity), t)` — same closure, melodic branch.
- `src/renderer/js/playback/timeline-player.js:17` — `const voice = palette.createVoice(ctx, output, freq, note.velocity ?? 0.8, time)` — inside `paletteInstrument(palette, ctx, output)` (14-20), the one-note-per-call scheduler used by live timeline playback, offline bounce, and the synth-view step sequencer.

Definitions only (self-reference, not external callers): `palettes.js:52, 114, 221, 234, 238 (this.createDrumVoice), 366, 429, 430`.

Tests (mock or exercise the same signature, will need updating alongside):
- `tests/palettes.test.js:29` — `Palettes[key].createVoice(ctx, output, 440, 1, 0)` for `classic`/`fm`/`pad` (`describe.each` at line 25).
- `tests/instrument-factory.test.js:27` (fake classic palette `createVoice: vi.fn(...)`), `:33` (fake drum palette `createVoice`), `:133` (`createDrumVoice: vi.fn(...)`).
- `tests/arrange-ux.test.js:265` (`createVoice: vi.fn(() => voice)`), assertions at `:320, :336, :355, :376, :401, :422`.

`instrumentFor` is exported from two different modules with different call shapes, do not conflate:
- `src/renderer/js/midi/live-instrument.js:27` — `export function instrumentFor(instrument, { palettes, ctx, output, racks, mountRack, packFor, sampleStoreFor, onStatus } = {})`. This is the one live play (keyboard/pads/MIDI-in) and the auditioner use.
- `src/renderer/js/playback/timeline-player.js:30` — `export function instrumentFor(track, { palettes, ctx, output, rackHandles, packFor, sampleStoreFor, packInstruments })`. This is the scheduled-note contract used by arrange-mode playback, offline bounce, and the synth-view step sequencer (aliased `scheduledInstrumentFor` at `app.js:22`).

Callers of each `instrumentFor`:
- `src/renderer/js/midi/live-instrument.js:24` — `liveInstrumentFor` wraps it: `instrumentFor(track.instrument || { type: 'palette', paletteKey: track.paletteKey || 'classic' }, deps)`.
- `src/renderer/js/instruments/auditioner.js:5,29` — imports `instrumentFor` from `../midi/live-instrument.js`; `const inst = instrumentFor(instrument, buildDeps())` (line 29, inside `play()`).
- `src/renderer/js/app.js:1437` — `const inst = liveInstrumentFor(track, instrumentDeps({ output, trackId: track.id }))` inside the `midi-event` listener (listener starts `app.js:1347`).
- `src/renderer/js/playback/timeline-player.js:112` — `const playNote = instrumentFor(track, { palettes, ctx, output, rackHandles, packFor, sampleStoreFor, packInstruments: this._packInstruments })` inside `TimelinePlayer.play()`.
- `src/renderer/js/playback/timeline-player.js:234` — offline bounce call, passes `palettes: null` (see section 5 below).
- `src/renderer/js/app.js:255` — `const play = scheduledInstrumentFor({ instrument }, { palettes: Palettes, ctx, output, rackHandles: [...], packFor, sampleStoreFor, packInstruments })` inside `sequencerPlayNote` (245-264+), the synth-view step sequencer's voice path.

## 3. `src/renderer/js/app.js` — knob panel and armed-instrument reads

- `armedTrack()` 488-492, `armedInstrument()` 494-499 — fallback shape `{ type: 'palette', paletteKey: track?.paletteKey || 'classic' }` when no track/instrument (line 498). No `params` fallback exists yet anywhere in this file.
- `syncInstrumentUi()` 502-510 — re-renders slot/knobs/pads only when `JSON.stringify([track?.id, track?.midiChannel, track?.instrument])` changes (504) — this is the diffing signature that must include `params` once they move onto the instrument, so a params-only change re-renders the panel.
- `renderKnobPanel()` 601-609 — dispatches by `instrument.type`: `renderRackPanel` (606), `renderPackKnobs` (607), else `renderPaletteKnobs(panel, instrument.paletteKey || 'classic')` (608). Only the `paletteKey` is passed, not the instrument or its params — `renderPaletteKnobs` currently has no way to know which track it is for.
- `renderPaletteKnobs(panel, paletteKey)` 611-662:
  - `const p = Palettes[paletteKey] || Palettes.classic` (612) — reads the module-level shared object directly.
  - Selector `<select>` built 616-641; current value read `p.params[def.key] === opt` (630); on `change` writes `p.params[def.key] = sel.value` (633-635) — direct global mutation, no store dispatch.
  - Knob loop 644-654; `addKnob(panel, def, { id, value: p.params[def.key], onInput: v => { p.params[def.key] = v; if (def.key === 'reverb') {...} } })` — value read 647, write 649, reverb special case 650.
  - Reverb-on-palette-select side effect: 656-661 — when the panel is (re)built, if `p.params?.reverb != null` it pushes that value into `_reverbAmount` and calls `AudioEngine.setReverb()` — this runs on every `renderPaletteKnobs` call, i.e. every armed-instrument change, not just a knob drag.
- `renderPackKnobs(panel, instrument)` 666+ — contrast case: writes go through `SetMixerParam` via a `mixer-param` CustomEvent (line 669, dispatched at 673-674) and `SetTrackInstrument` (line 684) rather than a global — this is the pattern `SetInstrumentParam` should mirror for palette instruments.
- `addKnob(panel, def, { id, value, onInput, event = 'input' })` 707-749 — the shared slider widget. `slider.addEventListener('input', updateFill)` (743, visual only) and `slider.addEventListener(event, () => onInput(parseFloat(slider.value)))` (744) — `event` defaults to `'input'`, so `onInput` currently fires on every drag tick, not on release. No caller in `app.js` passes `event: 'change'` today — the pointer-up-commit / `setParamLive`-during-drag split the spec wants (spec lines 98-101) does not exist yet anywhere in this file, it is new behavior.
- `instrumentDeps({ output, trackId })` 175-190ish — builds the deps object passed to `instrumentFor`/`liveInstrumentFor`; `palettes: Palettes` at line 179 is the shared module object.
- Armed instrument is otherwise read at: `app.js:578` (`paletteAcceptsNote(Palettes[instrument.paletteKey || 'classic'], note)`, pad playability check) and `app.js:519` (`trackInstrumentLabel(instrument, _packCatalog)` for the slot label).

## 4. `src/renderer/js/store/ProjectStore.js`

- `CURRENT_VERSION = 5` — line 15. `DEFAULT_STATE` 17-33.
- `migrate(projectJson)` 38-75:
  - Deep-clones input (39), then one `if ((next.version ?? 1) < N)` block per version: `<2` racks backfill (40-43), `<3` patterns backfill (44-47), `<4` VC-to-D cable rewrite (48-60), `<5` pack `programFollow` backfill (61-67, sets `next.version = 5` at 67).
  - Unconditional tail loop, 69-73 — runs on every call regardless of version, backfills `track.instrument` for any `midi` track missing it entirely: `if (track.type === 'midi' && !track.instrument) { track.instrument = { type: 'palette', paletteKey: track.paletteKey || 'classic' } }`. A v6 step (params backfill/prune, unknown-paletteKey fallback to classic) is new spec work and should be its own gated `< 6` block ending `next.version = 6`, inserted before this unconditional tail — the tail's own fallback instrument still will not have `params`, so the new v6 block must run after it or independently re-check.
- Representative commands (verbatim pattern — deep-clone, mutate, return; `undo(state) { return state }`, undo is store-level snapshot restore, not per-command):
  - `SetMixerParam(channelId, param, value)` — lines 324-338. Body: `channel[param] = value` (331), no key validation, no clamping, the cautionary example the spec calls out.
  - `SetTrackInstrument(trackId, instrument)` — lines 135-150. Guards: `if (!track || !instrument) return next` (141); `if (instrument.type === 'rack' && !(next.racks||{})[instrument.rackId]) return state` (142, rejects by returning original `state`, not `next`); `track.instrument = { ...instrument }` (143, shallow spread — a `params` object passed in would be shared by reference with the caller unless the caller already cloned it).
- Rack-side reference pattern worth citing (same "resolve keys from a registry, not the caller" shape the spec wants for `SetInstrumentParam`): `SetModuleParam(rackId, moduleId, key, value)` — `ProjectStore.js:646-652`, delegates to a `rackCommand` helper; body is `mod.params[key] = value` (650), no key/range validation inside the command itself despite the daw-assistant spec text — that check lives in the assistant capability layer (`components/assistant-dialog.js`), not inside `SetModuleParam`. `SetInstrumentParam` per `specs/palette-state.md:89-94` is specified to validate inside the command itself, a new pattern relative to both `SetMixerParam` and `SetModuleParam`.
- `RemoveRack(rackId)` — 590-607. Unknown/removed-rack fallback pattern to mirror for an unknown `paletteKey`: lines 598-601, `if (track.instrument?.type === 'rack' && track.instrument.rackId === rackId) { track.instrument = { type: 'palette', paletteKey: track.paletteKey || 'classic' } }`.
- `AddTrack(type, name, ids)` — 84-116. Instrument creation: line 99, `if (type === 'midi') next.tracks.at(-1).instrument = { type: 'palette', paletteKey: 'classic' }` — no `params` set here either, this is a second creation site that needs `paletteDefaults('classic')` once that helper exists.
- No central command registry/export table in this file — every command is an individually named `export function`. Consumers import by name (`app.js:11`, `components/assistant-dialog.js:12-21`; `FACTORIES` literal allow-list map at `assistant-dialog.js:31-40`, not `Commands[name]`).
- `ProjectStore` object (dispatch/undo/redo/subscribe/load/reset) — lines 873-939, `export default ProjectStore` at line 941. `load(projectJson)` (926-931) is what calls `migrate()`.

## 5. Offline bounce

`TimelinePlayer.bounce({...})` — `src/renderer/js/playback/timeline-player.js:211-259+` (rendering call `offline.startRendering()` at 259).
- Builds an `OfflineAudioContext` (213), mounts racks (218-221), preloads pack samples (222-231).
- Per-track voice building: line 232-241, `if (track.type === 'midi') { const playNote = instrumentFor(track, { palettes: null, ctx: offline, output: offline.destination, rackHandles, packFor, sampleStoreFor, packInstruments }); ... playNote?.(note, at, at + ...) }`.
- `palettes: null` at line 234 — inside `instrumentFor` (same file, line 52) this makes `palettes?.[instrument.paletteKey || track.paletteKey || 'classic']` evaluate to `undefined`, so `paletteInstrument` (14) is never constructed and `playNote` is `null` for any `midi` track whose `instrument.type === 'palette'`. Palette-instrument tracks are currently silent in bounce; only `pack` and `rack` MIDI tracks and plain `audio` tracks bounce today. This is the exact spot the spec's "Bounce parity" risk (spec lines 152-155) points at, fixing it means passing real `Palettes` (and, post-migration, the track's `instrument.params`) into this call.

## 6. Exact context: two named call sites from the spec

`src/renderer/js/midi/live-instrument.js:126-141` (window around line 136):
```js
      if (voices.has(pitch) && !drums) return
      let voice
      if (drums) {
        // GM percussion onto the palette's 0–3 voices. An unmapped note is
        // silent rather than detuned — the pad shows unlit for the same reason.
        const index = PALETTE_DRUM_NOTES[pitch]
        if (index === undefined) return
        voice = palette.createDrumVoice(ctx, output, index, velocityGain(velocity), t)
      } else {
        const freq = 440 * Math.pow(2, (pitch - 69) / 12)
        voice = palette.createVoice(ctx, output, freq, velocityGain(velocity), t)
      }
      voices.set(pitch, voice)
      // A note struck mid-bend has to land in tune, not snap on the next wheel move.
      if (bend) voice?.setBend?.(bend)
      if (mod) voice?.setMod?.(mod)
```

`src/renderer/js/playback/timeline-player.js:12-21` (window around line 17):
```js
// One note contract for both instrument kinds. Keep scheduling here; only
// delivery differs, so palette and rack timing cannot drift apart.
export function paletteInstrument(palette, ctx, output) {
  return (note, time, stopTime) => {
    const freq = 440 * Math.pow(2, (note.pitch - 69) / 12)
    const voice = palette.createVoice(ctx, output, freq, note.velocity ?? 0.8, time)
    voice.stop(stopTime)
  }
}

```
Note `paletteInstrument`'\''s signature is `(palette, ctx, output)` — it has no `instrument`/`params` in scope at all; a `params` argument has to be threaded in from its one caller, `instrumentFor` at `timeline-player.js:53` (`return palette ? paletteInstrument(palette, ctx, output) : null`), which does have `instrument` in scope (parameter at line 30).

## 7. Existing "instrument factory"

There is no file named `instrument-factory.js`. `tests/instrument-factory.test.js:1-2` imports `{ instrumentFor, liveInstrumentFor }` from `../src/renderer/js/midi/live-instrument.js` — that module is the factory the test file names. `liveInstrumentFor` (`live-instrument.js:24`, wraps `instrumentFor` at line 27) is the one factory serving keyboard/pad/MIDI-in play (`app.js:1437`) and the auditioner (`instruments/auditioner.js:5,29`) — the "one instrument factory serves audition, live play" rule in `specs/ui-shell.md`. Test structure: `paletteDeps()` helper (`instrument-factory.test.js:22-37`) builds a fake `palettes` map with `vi.fn()` `createVoice`/`createDrumVoice`, `fakeCtx()` (5-20) builds a minimal fake `BaseAudioContext`.

## 8. `tests/palettes.test.js` — current style

Full file is 38 lines. Imports the real `Palettes` default export from `src/renderer/js/palettes.js`, no mocking of the module itself, only a fake `ctx` (`makeCtx()`, 5-23, covers every node type the melodic palettes create: gain, biquad filter, oscillator, buffer, buffer-source). Single `describe.each(['classic', 'fm', 'pad'])('%s palette createVoice', ...)` (line 25) calling `Palettes[key].createVoice(ctx, output, 440, 1, 0)` (29, positional args, no params arg today) and asserting `stop`/`setBend`/`setMod` exist and do not throw (30-36). Drum and tr909 palettes are not covered by this file at all.

## 9. Existing `paletteDefaults` / `SetInstrumentParam`

Neither exists in `src/` today (grepped repo-wide). Both are named only in specs:
- `specs/palette-state.md:80-81` — `paletteDefaults(paletteKey)`, "returns a fresh copy, never the shared object."
- `specs/palette-state.md:86-94` — `SetInstrumentParam(trackId, key, value)`.
- `specs/daw-assistant.md:414-433` — Phase 5, explicitly blocked until `palette-state.md` lands: adds one assistant action `SetInstrumentParam` (`trackId, key, value`, table at 421-423), key validated via a new capability `capabilities.paletteParamKeys(paletteKey)` (428) injected the same way `moduleParamKeys` is today (`components/assistant-dialog.js:44-45`, `ASSISTANT_CAPABILITIES`), digest gains `instrument.params` per track (431-432). This phase-5 wiring (assistant `FACTORIES` map at `assistant-dialog.js:31-40`, `src/shared/daw-assistant/plan.js` schema/case/describe/toArray tables at lines 146/161, 413/426, 530/540, 570/580) is out of scope for phase 0/1 but is the next consumer once `SetInstrumentParam` exists.

## Open questions / risks not resolved by reading (flagging, not answering)

- `renderPaletteKnobs` (`app.js:611`) takes only `paletteKey`, not the armed track/instrument — needs a signature change to reach `track.id` and `instrument.params` for dispatch.
- `syncInstrumentUi`'s diff signature (`app.js:504`) already includes `track?.instrument`, so once `params` lives on `instrument` this should pick up patch changes for free.
- Two independent `instrumentFor` functions with the same name (section 2) — any params-threading change must be made in both `midi/live-instrument.js:27` and `playback/timeline-player.js:30`, they do not share code.
- Bounce currently drops palette-instrument tracks entirely (`timeline-player.js:234`, `palettes: null`) — spec's "Bounce parity" risk item implies this must be fixed as part of this work, since a bounce test is required to assert palette params survive the render.
