# Modular Rack — Implementation Plan

Build order for `specs/modular-rack.md` + `specs/modular-rack-modules.md`. Each phase ends on a working, committable, testable state. No phase leaves the app broken.

Ground rules for every phase:

- Pure logic (layout, CV math, polyphony resolution, patch IO, euclid) goes in its own module with unit tests; the view and the engine stay as thin imperative shells.
- Module factories take `ctx` as an argument and read no globals — this is what makes offline bounce and tests possible.
- Nothing on the basic-voice path may be worklet-tier.
- `npm test` green before each commit; conventional commit messages (`feat:`, `fix:`, `refactor:`).

---

## Status

| Phase | State | Commit |
|---|---|---|
| 0 — Foundations | **done** | `cc1c7d3` |
| 1 — Engine + P0 modules | **done** | `dc0446a` |
| 2 — Rack view, panels, cables | **done** | `7faf785` |
| 3 — Clock, sequencing, transport | **done** | `4a8e50f` |
| 4 — Full DAW citizen | not started | |
| 5 — Persistence and presets | not started | |
| 6 — Remaining modules, polish | not started | |

Landed on `feature/arrange-ux`. Suite at 511 tests / 27 files green.

**Deferred out of phases 0–1** (each marked with a `ponytail:` comment at the site):

| Item | Where | Add when |
|---|---|---|
| VCO `PW` (two-saw phase-difference trick) and `SYNC` (oscillator recreation at a scheduled time) | `modules/vco.js` | the panel UI exists to show them |
| Stereo `OUT` (currently a mono sum of L/R) | `modules/out.js` | the engine can tell a module which of its inputs are patched |
| VCA normalling driven by patch state (`setNormalled` exists, engine never calls it) | `modules/vca.js` | same engine capability as above |
| `utils/impulse.js` extraction out of `audio-engine.js` | phase 1 plan row | `REVERB` lands in phase 6 and becomes the second caller |
| Module `bypassed` flag honoured by the engine | `rack-engine.js` | phase 2, when the right-click menu can set it |

**Deviations from the spec as written:**

- Registry validation does **not** reject a param key that matches a port id — a `RES` knob beside a `RES` CV jack is correct eurorack, and params/ports are separate namespaces.
- `VCA` is two serial gain stages (knob → CV) rather than knob and CV summed into one `gain` param: summing makes them add instead of scale and leaves an unpatched VCA above unity.
- `LFO` retires a replaced oscillator until its scheduled stop instead of disconnecting it immediately, because a `RESET` event arrives ~100 ms ahead of its time.

---

## Phase 0 — Foundations (state, layout math, CV math) ✅

No UI, no audio. Pure functions and store schema only.

**New files**

| File | Contents |
|---|---|
| `src/renderer/js/utils/cv.js` | `midiToPitchCv`, `pitchCvToHz`, `voltsToCents`, `hzToPitchCv`, `gateFromVelocity`, `clampCv` |
| `src/renderer/js/rack/rack-layout.js` | `hpToPx`, `pxToHp`, `moduleWidthHp`, `firstFreeSlot`, `canPlace`, `packRail`, `tidyRack` |
| `src/renderer/js/rack/modules/index.js` | Registry map + `validateRegistry()` (throws on duplicate types/ports, missing defaults, missing worklet URLs) |
| `tests/cv.test.js`, `tests/rack-layout.test.js`, `tests/rack-registry.test.js` | |

**Changed files**

- `src/renderer/js/store/ProjectStore.js` — add `racks: {}` to `DEFAULT_STATE`, bump `version` to 2, add commands `AddRack`, `RemoveRack`, `RenameRack`, `AddModule`, `RemoveModule`, `MoveModule`, `SetModuleParam`, `SetAttenuverter`, `SetModuleBypass`, `Connect`, `Disconnect`, `SetCableColor`, `LoadRackPatch`. `RemoveModule` must also drop every cable touching it.
- `tests/rack-store.test.js` — new; `tests/serialization.test.js` — extend for the v1→v2 migration (`version < 2` gets `racks: {}`, nothing else changes).

**Acceptance:** a rack patch can be built, mutated and undone entirely in state, with zero audio or DOM code involved.

---

## Phase 1 — Engine and the P0 module set ✅

**New files**

| File | Contents |
|---|---|
| `src/renderer/js/rack/rack-engine.js` | `mount(ctx, rackState, { output })`, `update(handle, nextState)`, `setParamLive`, `unmount`; id-keyed diff, cycle detection with `DelayNode(0)` insertion |
| `src/renderer/js/rack/poly.js` | `resolveChannels(rackState, registry) → Map<moduleId, n>` (pure) |
| `src/renderer/js/rack/modules/{vco,noise,vcf,adsr,lfo,vca,mix,att,out}.js` | First 9 P0 modules |
| `tests/rack-engine.test.js`, `tests/rack-poly.test.js` | Fake `BaseAudioContext` with create*/connect counters, in the style of `tests/effect-chain.test.js` |

**Changed files**

- `src/renderer/js/audio-engine.js` — add `hasWorklet()` alongside the existing `hasRecorder()`.
- `src/renderer/js/utils/impulse.js` (new) — extract `_buildImpulseResponse` out of `audio-engine.js`; `audio-engine.js` and the future `REVERB` module both call it.

**Acceptance:** a hand-written patch JSON mounts on a real `AudioContext` and makes sound through `AudioEngine.getMasterInput()`. Moving a module produces zero node churn. `unmount` returns the created-node count to baseline.

---

## Phase 2 — Rack view, panels, cables

**New files**

| File | Contents |
|---|---|
| `src/renderer/js/components/rack-view.js` | Shell, toolbar, rails, zoom, drag/drop placement, selection, keyboard patching |
| `src/renderer/js/components/rack-panel.js` | Panel renderer driven by the registry's `ports`/`params` — one generic implementation, not one file per module UI |
| `src/renderer/js/components/rack-cables.js` | Canvas overlay: bezier sag, hit-testing, colours, drag preview, cached background layer |
| `src/renderer/js/components/module-browser.js` | Grouped, searchable drawer; hides worklet-tier modules when `!AudioEngine.hasWorklet()` |
| `tests/rack-view.test.js` | jsdom: panels render, jack ARIA labels, keyboard patch sequence, worklet-tier hiding |

**Changed files**

- `src/renderer/index.html` — third `.tool-btn` (`data-tool="rack"`, title "Rack (F3)") and `<section id="rack-view" style="display:none">`.
- `src/renderer/js/app.js` — `switchMode('rack')` branch; mount/unmount the view; suspend its poll loop when hidden, mirroring `startArrangeLoop`/`stopArrangeLoop`.
- `src/renderer/js/shortcuts.js` usage in `app.js` — register `F3`.
- `src/renderer/style.css` — rack panel, rail, knob, jack, cable-canvas styles.

**Acceptance:** the starter patch loads on first open and plays from the on-screen keyboard and MIDI. Patching by mouse and by keyboard both work. 64 modules stay under 8 ms frame time during a cable drag.

**Skipped here on purpose:** signal-activity animation, tidy, patch-list panel — phase 6.

---

## Phase 3 — Clock, sequencing, transport sync

**New files**

- `src/renderer/js/rack/rack-clock.js` — transport → 24 PPQN events; internal clock mode.
- `src/renderer/js/rack/scheduler.js` — the 25 ms tick / 100 ms lookahead loop, **extracted** from `sequencer.js` and `tr909-view.js` so all three share one implementation instead of three copies.
- `src/renderer/js/rack/euclid.js` — pure Bjorklund; `tests/euclid.test.js` asserting E(3,8), E(5,8), E(7,16), rotation.
- Modules: `clock`, `seq8`, `clkdiv`, `euclid`, `quant`, `ad`, `rnd`.

**Changed files**

- `sequencer.js`, `components/tr909-view.js` — switch to `rack/scheduler.js`. Their existing tests must stay green; that is the regression guard for the extraction.

**Acceptance:** `CLOCK` in transport mode stays locked to the arrangement over a 5-minute run with no drift. `SEQ8` steps survive save/load. Gate events reach `ADSR` sample-accurately with `hasWorklet() === false`.

---

## Phase 4 — Full DAW citizen

**Changed files**

- `src/renderer/js/playback/timeline-player.js` — extract the MIDI branch's note scheduling into a strategy (`paletteInstrument` / `rackInstrument`) **before** adding the rack case, so the two never diverge into copies.
- `src/renderer/js/store/ProjectStore.js` — `track.instrument = { type:'palette'|'rack', … }`; `AddEffect` accepts type `rack`.
- `src/renderer/js/audio/effect-chain.js` — effect type `rack` returning `{ input, output }` from a mounted rack; passthrough + warning badge when the patch has no `AUDIO IN`.
- `src/renderer/js/audio/mixer-engine.js` — no change needed beyond a rack getting its own channel via the existing `ensureChannel`.
- Modules: `midi-in` (voice allocator, with `tests/rack-midi.test.js` on the pure `allocateVoice`), `audio-in`, `param-out`.
- `timeline-player.js` bounce — mount racks into the `OfflineAudioContext`; `await offlineCtx.audioWorklet.addModule(...)` for worklet-tier modules before rendering.

**Acceptance:** a MIDI track hosting a rack plays back from the arrangement and bounces to a WAV identical to what the live path produces (within float tolerance). A rack inserted on a channel processes audio. A `PARAM OUT` LFO visibly moves a mixer fader.

---

## Phase 5 — Persistence and presets

**New files**

- `src/renderer/js/rack/patch-io.js` — `exportPatch(rack) → json`, `importPatch(json, registry) → { rack, warnings }`, tolerant of unknown modules and missing fields.
- `src/renderer/presets/racks/*.json` — 8–12 shipped patches (starter, poly pad, FM bell, generative euclid, kick, acid line, drone, CV bench, mixer-modulation demo).
- `tests/rack-patch-io.test.js` — round trip, unknown-module preservation, **every shipped preset imports clean** (this test is what stops preset rot).

**Changed files**

- `src/renderer/js/io/FileAdapter.js` — `.synthrack` import/export.
- `rack-view.js` toolbar — patch menu (new / load preset / import / export / save as preset).

**Acceptance:** a patch built on `https://synth.zakharhome.org` (worklet tier available) opens on `http://themachine/synth/` with the worklet modules as labelled placeholders, saves, and re-opens on HTTPS fully intact. No data loss in either direction.

---

## Phase 6 — Remaining modules, instrumentation, polish

- Remaining P1 modules: `fmop`, `drum`, `drive`, `fold`, `slew`, `s&h`, `math`, `mult`, `sum`, `comp`, `reverb`, `chorus`, `ringmod`, `scope`, `cv-mon`, `tuner`.
- Shared 30 fps poll loop for scopes, meters and cable signal-activity; suspended when the view is hidden.
- `tidy` (rail repack), patch-list panel, cable opacity/hide, module/cable/voice count badge with the warning thresholds from §7 of the main spec.
- Performance pass against the budgets table; the leak test (mount → 100 random edits → unmount → node count baseline) runs in CI.

---

## Sequencing notes

- Phases 0–2 are the vertical slice that proves the whole design; if the cable-drag frame budget or the reconciler diff fails there, the rest of the plan is re-scoped before more modules get written.
- Phase 3's scheduler extraction touches existing, tested code (`sequencer.js`, `tr909-view.js`). Do it in its own commit, with those suites green, before any rack code depends on it.
- Phase 4's `timeline-player` strategy extraction is the one refactor that must not be deferred — deferring it is how the palette and rack note paths become two divergent copies.
- Worklet-tier modules (phase 6) land last on purpose: everything shippable works without them, so a worklet problem can never block the release.
