# Instrument Browser — one picker, one selection, playable synth view

Choosing a sound today means six stacked `<select>`s in a 268 px sidebar that only
exists in the arrange view (`instrument-inspector.js:62-119`), and the synth view —
the part of the app that looks like an instrument — cannot reach the pack library
at all. Worse, there are **two selection concepts**: a track's persisted
`track.instrument`, and a module-global preview (`app.js:47-48`,
`_previewPack` / `_previewInstrument`) that never syncs to it, dies on reload, and
only plays when no MIDI track is routable.

This spec collapses that to one picker, one selection, and one instrument
factory, then rebuilds the synth view around it.

Depends on `specs/ui-shell.md` phases 1–2 (command bar and the `<dialog>` kit).

---

## Status

| Phase | State | Commit |
|---|---|---|
| 1 — Patch index + browser overlay | done | `66b7366`, `3db4997` |
| 2 — One selection, one instrument factory | done | `3db4997` |
| 3 — Instrument settings dialog | done | `3db4997` |
| 4 — Synth view: slot, pads, keys | done | `da2073d` |
| 5 — 909 promoted out of the palette axis | done | `da2073d` |

## Progress — 2026-08-27

All five phases are in.

- `Ctrl+I` opens one overlay over `buildIndex`/`searchIndex`; the highlighted row
  auditions through `instrumentFor` — the same factory that plays for real.
- The preview concept is gone. `armPlan()` (pure) decides when a note
  auto-provisions a MIDI track, so the rule is testable instead of buried in glue.
- `switchPalette` and `#palette-tabs` are deleted; internal engines are the
  Internal scope of the browser.
- Pads are 8 x 2 off `pad-map.js` and dispatch synthetic `midi-event`s, inheriting
  routing, sustain and mixer output. `PALETTE_DRUM_NOTES` maps GM percussion onto
  the internal drum palette's four voices.
- Keys keep a visible window that follows incoming notes by whole octaves
  (`keyboard-range.js`, pure), plus manual octave buttons for playing without
  hardware.

Deliberately not built: pack removal and disk-size reporting in the Library
dialog — the main-process IPC exposes neither, and inventing it here would be
guessing at install policy. `instrument.modDest` exists but has two values
(`default` / `off`); real destination switching needs engine work in
`palettes.js` and `sample-instrument.js`.

---

## Product decisions

- **Input and source are different axes.** Keys, pads, PC keyboard and external
  MIDI are *input*. Palette, pack patch and rack are *source*. Today the synth
  view's palette tabs conflate them (`switchPalette()`, app.js:176-214); they get
  separated.
- **One selection.** The active instrument is the armed MIDI track's
  `track.instrument`. There is no second preview concept. If the synth view is
  played with no MIDI track in the project, one is created — a person playing
  notes wants somewhere to record them.
- **Everything auditions through the same factory** that plays it for real. Three
  separate construction paths exist today (`auditionTrack` app.js:90,
  `auditionPack` app.js:103, `previewInstrumentFor` app.js:78); they become one.
- **The browser is momentary, not resident.** It takes the screen for a second and
  gives it back — no permanent rail. This is the `specs/ui-shell.md` rule applied.
- **A library view is cut.** Pack administration is a dialog (`Ctrl+L`,
  `specs/ui-shell.md` phase 3), not a fourth workspace.

---

## Phase 1 — Patch index + browser overlay

### The index (pure)

**New module** `src/renderer/js/instruments/patch-index.js`:

```js
export function buildIndex({ packs, palettes, racks })
// -> [{ key, kind: 'pack'|'palette'|'rack', label, sub, instrument, program }]
//    instrument is exactly the object SetTrackInstrument takes.

export function searchIndex(index, query, { scope, favourites, recent } = {})
// -> ranked subset
```

`buildIndex` iterates `_packCatalog` entries — compiled packs shaped
`{ id, version, manifest, byId, byAddress }` (pack-registry.js:86-92) — and
flattens `manifest.patches`, carrying `pack.id`/`pack.version` down into each
row, since they live one level above the patch. Palettes contribute one row per
`internalKeys` entry; racks one row each.

Ranking, no dependency and no fuzzy library: exact match, then label prefix, then
word-start, then substring; ties broken by `address.program`. Query tokens are
ANDed. `scope` filters by `kind`; `favourites` and `recent` are saved queries over
the same index, not separate stores.

**Test:** `tests/patch-index.test.js` — a two-pack catalog flattens with correct
pack ids on every row; `"warm pad"` ranks the exact patch first; scope filters;
an empty query returns favourites-then-recent-then-all.

### The overlay

New component `src/renderer/js/components/instrument-browser.js`, mounted once in
`boot()` and opened from anywhere by a `Ctrl+I` shortcut or a click on the
instrument slot. Native `<dialog>` through the `specs/ui-shell.md` dialog kit, so
focus trap, `Esc` and backdrop are free.

Contract:

| Key | Behaviour |
|---|---|
| typing | filters live |
| `↑` `↓` | move highlight, and audition it (debounced ~120 ms) |
| `Enter` | assign to the armed track, close |
| `Shift+Enter` | create a new MIDI track with it, close |
| `Esc` | close, assign nothing, stop any audition |
| `Tab` | cycle scope chips (All / Packs / Internal / Racks / ♥ / Recent) |

Rows show label, source and program number; a pack row also shows load state, so
an uninstalled or missing pack is visible rather than silently mute.

Assignment dispatches the existing `SetTrackInstrument` (ProjectStore.js:133-148)
— snapshot undo covers it for free (ProjectStore.js:870-885), so no new undo work.

---

## Phase 2 — One selection, one instrument factory

### Delete the preview path

Remove `_previewPack`, `_previewInstrument` (app.js:47-48), `previewInstrumentFor`
(app.js:78-88), `auditionPack` (app.js:103), `auditionRawPack` and the
`RAW WAV TEST` button (instrument-inspector.js), and `InstrumentInspector`'s
second `renderBrowser` mode entirely. The note-on/note-off fallbacks that consult
preview (app.js:474-478, 496-498, 1034-1039) collapse into the normal track path.

### Auto-provision

When a note is played and the project has no MIDI track, create one
(`AddTrack('midi')`, ProjectStore.js:82-114) and arm it. One track, once — not one
per note.

### One factory

`liveInstrumentFor(track, deps)` (live-instrument.js:8) currently takes a track.
Generalise it to take an instrument descriptor:

```js
export function instrumentFor(instrument, { palettes, ctx, output, racks, packFor, sampleStoreFor, mountRack, onStatus })
```

`liveInstrumentFor(track, deps)` becomes a one-line wrapper for compatibility with
`timeline-player.js`. The browser's audition, the armed-track live path
(`app.js:1061-1089`) and `auditionTrack` all call the same thing.

**Audition lifecycle:** one auditioner owns at most one instrument; a new
highlight disposes the old one and holds a token so a late-resolving sample does
not sound.

```js
// ponytail: sample-store has no cancellation (sample-store.js:36-45) — a
// superseded decode still completes and warms the cache. Only the voice is
// suppressed. Add an AbortController if fast arrowing through a large pack
// measurably stalls.
```

**Test:** `tests/instrument-factory.test.js` with the existing fake context —
same descriptor produces a working instrument for all three types; disposing an
auditioned instrument leaves no running source (mirror of the rack leak test).

---

## Phase 3 — Instrument settings dialog

Everything dense and occasional that the sidebar used to hold, in one `<dialog>`
opened from the slot's settings affordance. Tabs: **Patch / MIDI / Expression /
Output**.

| Field | Source of truth |
|---|---|
| Source (Internal / Pack / Rack) | `SetTrackInstrument` |
| Pack, bank, program | `SetTrackInstrument`, address from `patch.address` |
| On program change: pin vs follow | `instrument.programFollow`, latch honoured at ProjectStore.js:151-176 |
| MIDI channel / Omni | `SetTrackMidiChannel` (ProjectStore.js:116-131) |
| Bend range, mod destination, sustain behaviour | new instrument fields, consumed by `specs/midi-bridge.md` phase 3b |
| Mixer channel, level, pan | existing `track.mixerChannelId` |

The dialog shows the pack's licence line and sample weight — the honest place for
it, and the reason the Library dialog stays small.

Bank and program keep explicit selectors here. They are how a MIDI-following
track is verified, and a fuzzy search cannot express "program 89 of bank 0:0".

---

## Phase 4 — Synth view: slot, pads, keys

Delete `#header` / `#app-title` / `#palette-tabs` (index.html:103-114). The synth
view becomes:

```
[ ◈ Warm Pad · GM Main 089 · ch 1 · ● loaded ]   [ macro knobs for the source ]
[ 8 × 2 pad grid                              ]   [ bank A / B ]
[ octave window · 25 keys                     ]
[ step sequencer (unchanged)                  ]
```

### Slot

Reflects the armed track's instrument. Click or `Ctrl+I` opens the browser; a
settings affordance opens the phase-3 dialog. Switching views never changes what a
note plays.

### Knob panel follows the source

`renderKnobPanel()` (app.js:295-389) already rebuilds from
`currentPalette.knobs`. It gains two more cases: a pack patch renders
cutoff / resonance / attack / release / reverb / level, a rack renders its macro
params. Internal palettes keep exactly today's knobs.

### Pads

`DRUM_DEFS` (app.js:162-167) is four entries whose index is passed straight to
`Palettes.drum.createDrumVoice` (app.js:233) — pads bypass the instrument system
entirely. Replace with a pure map:

**New module** `src/renderer/js/instruments/pad-map.js`:

```js
export const GM_PERCUSSION   // note -> name, the standard channel-10 map
export function padBank(bank) // 'A'|'B' -> [{ slot, note, label, key }] × 8
export function padToNote(bank, slot)
```

Pads then call the phase-2 factory with a note number, exactly like a key does.
Two banks of eight mirror the K25 one-to-one. For the internal drum palette,
`createDrumVoice` keeps its 0–3 indices and the four GM notes 36 / 38 / 42 / 46
map onto them; other pad notes are silent on that palette and the pad reads as
unlit, which is honest rather than surprising.

PC keys `1`–`4` (app.js:272-280) extend to `1`–`8` and move into
`ShortcutManager` with a `synth` context — they currently bypass it entirely,
which will collide with dialogs (`specs/ui-shell.md` risk note).

### Keys

`START_NOTE = 48` / `END_NOTE = 72` are hardcoded (keyboard.js:11-12). They become
render options, and the view shows which window of the full range is on screen,
lighting the octave the hardware is currently sending. Incoming notes outside the
window scroll it rather than disappearing.

**Test:** `tests/pad-map.test.js` — bank A slot 0 is note 36; every bank row has 8
slots and unique notes; `padToNote` round-trips.

---

## Phase 5 — 909 out of the palette axis

`tr909` is a palette key today, so the synth view hides three sections for it
(app.js:204-207) and the global Play button has to be disabled from a combination
of `_currentMode` and `currentPaletteKey` (app.js:216-226). It is a machine, not a
patch: promote it to its own view in the sidebar (`F4`), and the palette axis
becomes four honest engines.

That deletes `updateGlobalPlayAvailability`'s two-variable hazard — Play is simply
owned by whichever view is active.

---

## Verify

```sh
npm test
npm run dev
```

Manual acceptance:

1. `Ctrl+I` from the synth view, type three letters, arrow down twice — each
   highlight sounds — `Enter`, and the keys play that patch.
2. Same flow in arrange assigns to the armed track, and the timeline plays it.
3. No sidebar inspector anywhere; no `RAW WAV TEST`; no second browser mode.
4. Pads play the selected pack's drum patch; bank B is eight different sounds.
5. Reload the project: the instrument that was playing is the instrument that
   loads. (Today's preview selection silently does not survive this.)
6. A missing pack still shows its patch name and stays silent, as
   `specs/instrument-packs.md` requires.

## Risk notes

- `app.js`'s audition, preview, catalog and drum-pad code has **zero test
  coverage** today. Phases 1, 2 and 4 each add a pure module with tests, which is
  the point: the logic moves out of the untested glue file as it is rewritten.
- `sampleStoreFor` returns `null` outside Electron (app.js:55-62) — the browser
  must render pack rows as unavailable there rather than throwing.
