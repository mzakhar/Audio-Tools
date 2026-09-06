# Palette state — knob values belong to the project, not to a module global

Turning a knob in the synth view mutates a shared object that lives for the life
of the page. It is not saved with the project, it is shared by every track using
that palette, and nothing outside `app.js` can see or change it. That single fact
is why there is no preset save, why two tracks on `classic` cannot have different
patches, and why the DAW assistant cannot touch the app's main sound-design
surface.

This spec moves those values into `ProjectStore` as data on the track's
instrument.

---

## Status

| Phase | State |
|---|---|
| 0 — params as data, `createVoice` takes them | shipped |
| 1 — schema v6 and the knob panel | shipped |
| 2 — presets | proposed |

## What is actually wrong

| Fact | Where |
|---|---|
| Palette params are a module-level mutable object | `palettes.js:30` (and one per palette) |
| The knob panel writes straight into it | `app.js:634`, `app.js:649` |
| `createVoice` reads it off `this` | `palettes.js:53` — `const p = this.params` |
| Voices are built from it on every path | `midi/live-instrument.js:136`, `playback/timeline-player.js:17` |
| The knob panel is **already** keyed to the armed track's instrument | `app.js:608` — `renderPaletteKnobs(panel, instrument.paletteKey)` |

That last row is the tell. The UI already behaves as though each track carries its
own patch; the state layer just does not back it. Arm track A, dial in a sound,
arm track B on the same palette, and B silently inherits A's knobs — while the
panel presents itself as belonging to B.

Consequences, in the order a user meets them:

- **Nothing survives a reload.** A patch is page state. `specs/ux-scenarios.md`
  scenario 8 ("locking in a sound worth keeping") has no path at all, and
  scenario 9 ("coming back the next day") cannot round-trip a sound it never
  stored.
- **Two tracks cannot differ.** One palette, one set of knobs, globally.
- **The assistant is blind to it.** `buildDigest` projects `ProjectStore` state,
  so the knob panel is invisible in the digest and unreachable by any action.
  Scenario 4 ("holding a sound while tweaking it") is out of reach for the same
  reason.
- **Offline bounce reads live UI state.** A render depends on whatever the panel
  happened to be set to, which is exactly the coupling the rack rules forbid for
  modules (`create(ctx, opts)` reads no globals) and which palettes never got.

## Design

### Params are data on the instrument

```js
track.instrument = { type: 'palette', paletteKey: 'classic', params: { … } }
```

`params` holds only keys the palette declares in its `knobs[]` and `selectors[]`.
Anything else is dropped on the way in — the palette definition is the schema.

### `createVoice` takes them

```js
createVoice(ctx, output, freq, vel, time, params)   // was: read this.params
```

The palette object keeps its `params` block, but demoted to **defaults** — a
template to seed a new instrument, never live state. This is the rule the modular
rack already follows and the reason its offline bounce and fake-context tests
work; palettes are the last place still reaching for a global.

Call sites to update: `midi/live-instrument.js:136`,
`playback/timeline-player.js:17`, the synth-view path in `app.js`, and the drum
path (`createDrumVoice` takes the same treatment). A missing `params` argument
falls back to the palette defaults, so nothing breaks mid-migration.

New pure helper, `paletteDefaults(paletteKey)` — returns a fresh copy, never the
shared object. Every caller that wants "a new instrument" goes through it.

### One store command

```js
SetInstrumentParam(trackId, key, value)
```

Validation belongs to the command, sourced from the palette definition, not from
the caller: `key` must be declared by that palette's `knobs[]` or `selectors[]`;
a knob value clamps to its `min`/`max`; a selector value must be one of its
`options`. `SetMixerParam` is the cautionary example here — it writes
`channel[param] = value` with no key check at all (`ProjectStore.js:322`), which
is why the assistant has to re-implement that guard itself.

### The knob panel

Dragging a knob keeps its immediate audio feedback, then commits one command on
pointer-up — the pattern `rack-engine.js` already uses (`setParamLive` during the
drag, a coalesced dispatch at the end). One drag is one undo entry, not sixty.

`reverb` keeps its special case: `app.js` calls `AudioEngine.setReverb()` when it
changes. After this move that call is driven from the store subscription rather
than from the input handler, so a change reaches the engine no matter who made it
— a drag, a preset recall, or the assistant.

### Schema v6

`CURRENT_VERSION` goes to 6 with one migration step appended — never renumbered:

- every `instrument` with `type: 'palette'` and no `params` gets
  `paletteDefaults(paletteKey)`
- an unknown `paletteKey` falls back to `classic`, matching the existing
  `RemoveRack` fallback behaviour
- keys the palette no longer declares are dropped; keys it declares and the
  project lacks are filled from defaults

A project saved before this change loads with exactly the sound it had, because
the defaults *are* what it was using.

## Presets — phase 2

Once a patch is data, saving one is copying it:

```js
{ id, name, paletteKey, params }
```

Stored in the project under `presets[]`, listed in the existing instrument
browser beside factory patches (`specs/instrument-browser.md` — "one selection
concept"), applied by writing `params` onto the armed track's instrument. No new
surface, no separate hidden list, which is the failure mode scenario 8 names.

A user-level library that outlives one project is deliberately **not** in this
phase. It needs a storage decision per platform (Electron `userData` vs. browser
IndexedDB) and the project-level version is what closes the scenario.

## What this unblocks

- `specs/ux-scenarios.md` scenario 8 — a sound worth keeping can be kept.
- Scenario 9 — a project reopens sounding the way it did.
- Scenario 4 — parameter changes become addressable state, so a held note can be
  shaped by anything that can write state, the assistant included.
- `specs/daw-assistant.md` phase 5 — palette param actions, which cannot exist
  until the params do.

## Risks worth stating

- **Shared-patch behaviour changes.** Two tracks on one palette stop sharing
  knobs. That is the fix, but it will look like a regression to anyone who
  learned the old behaviour.
- **Bounce parity.** Offline bounce must pass each track's `params`; a bounce
  that silently used defaults would sound different from playback, which is
  scenario 11's named failure mode. The bounce test asserts a non-default patch
  survives the render.
- **Every `createVoice` caller must be found.** A missed one keeps reading the
  defaults and silently ignores the user's patch. The fallback makes that quiet,
  so the migration is not done until every call site above passes params.

## Tests

- `paletteDefaults` returns a fresh object; mutating the result never touches the
  palette definition
- `SetInstrumentParam` rejects a key the palette does not declare, clamps a knob
  to its range, and rejects a selector value outside its options
- a v5 project migrates to v6 with defaults backfilled, and an unknown
  `paletteKey` falls back to `classic`
- two tracks on the same palette hold different params and each plays its own
- one knob drag produces one undo entry
- offline bounce of a track with a non-default patch differs from the same track
  at defaults
- `createVoice` called without params uses the defaults

## Verification

```sh
npm test
```

Manual: dial a patch on track A, arm track B on the same palette, confirm B is
unchanged. Save, reload, confirm A still sounds the same. Drag one knob, press
`Ctrl+Z` once, confirm the whole drag reverts.
