# Palette state — phase 0+1 handoff

Implements `specs/palette-state.md` phases 0 and 1. Phase 2 (presets) untouched.

## Files changed

- `src/renderer/js/palettes.js` — every `createVoice`/`createDrumVoice` takes a
  trailing `params` argument, `const p = params || this.params`. Drum
  palette's `createVoice` forwards `params` into `createDrumVoice`. Added
  exports `paletteDefaults`, `paletteParamKeys`, `clampPaletteParam`.
- `src/renderer/js/store/ProjectStore.js` — `CURRENT_VERSION` 5→6, new gated
  `< 6` migration block (after the unconditional tail loop) backfills
  `params`, falls back an unknown `paletteKey` to `classic`, prunes
  undeclared keys. New command `SetInstrumentParam(trackId, key, value)`.
  `AddTrack`, `SetTrackInstrument`, `RemoveRack`'s palette fallback now seed
  `params: paletteDefaults(...)`.
- `src/renderer/js/midi/live-instrument.js` — resolves `instrument.params`
  (falling back to `paletteDefaults`) and passes it to
  `createVoice`/`createDrumVoice`.
- `src/renderer/js/playback/timeline-player.js` — `paletteInstrument` and
  `instrumentFor` thread `params` through. `bounce()` gains a `palettes`
  param (defaults to `null`, same as before if the caller doesn't pass one)
  and forwards it to `instrumentFor` instead of hardcoding `palettes: null` —
  this is the bounce-parity fix from the spec.
- `src/renderer/js/app.js` — `bounce` command call now passes
  `palettes: Palettes`. `armedInstrument()` fallback seeds `params`.
  `renderKnobPanel`/`renderPaletteKnobs` signature changed to
  `renderPaletteKnobs(panel, instrument, trackId)`; reads/writes go through
  `instrument.params` and `SetInstrumentParam` dispatch instead of the shared
  `Palettes[key].params` object. Knobs commit on `event: 'change'`
  (pointer-up), reverb keeps a separate immediate `'input'` listener calling
  `AudioEngine.setReverb()` directly (engine state, not store state).
- Tests: new `tests/palette-state.test.js`. Updated
  `tests/store-midi.test.js`, `tests/tr909-patterns.test.js`,
  `tests/rack-store.test.js`, `tests/daw-assistant-dialog.test.js` for the
  `CURRENT_VERSION` bump and instruments now carrying `params`.
  `tests/palettes.test.js`, `tests/instrument-factory.test.js`,
  `tests/arrange-ux.test.js` needed no changes — none of them assert on
  `createVoice`'s arg count or exact instrument shape in a way the new
  trailing arg/field breaks.

## Verify

`npm test` — 98 files / 1270 tests, all green (baseline 96/1238 + this
phase's additions).

## Decisions / deviations

- `clampPaletteParam` coerces knob values with `Number(value)`; a
  non-numeric knob value returns `undefined` (rejected), matching the "key
  not declared" rejection path in the store command.
- `paletteParamKeys` used inside the v6 migration to know which keys to
  keep/backfill, and exported for phase 5 (assistant) per the brief.
- `SetInstrumentParam`'s rejection path returns the original `state` object
  (not a clone), mirroring `SetTrackInstrument`'s rack-rejection pattern.
- `renderPaletteKnobs`'s reverb special case: kept the render-time side
  effect (pushing `params.reverb` into `_reverbAmount`/`AudioEngine`) as-is,
  just repointed it from `p.params` to the resolved `params`, per the brief
  ("must read from instrument.params, not p.params") — did not move it to a
  store-subscription-driven effect as the spec's prose suggests, since the
  brief's explicit instruction only asked for the read-source fix, not a
  bigger control-flow change. Flagging this as a narrower interpretation of
  spec line 102-105; a full store-subscription-driven reverb sync is
  deferred.
- Added a `ponytail:` comment on the coalesced-knob-commit ceiling (notes
  struck mid-drag play the pre-drag value) at
  `src/renderer/js/app.js` in `renderPaletteKnobs`.

## Deferred (explicitly out of scope)

- Phase 2 presets.
- Full "reverb reaches the engine no matter who made it" store-subscription
  wiring described in spec lines 102-105 — see deviation note above.
