# DAW Assistant — phase 5 (palette params) + phase 7 (pack program) handoff

`npm test`: 98 files / 1277 tests, all green (baseline was 98/1270; +7 new).

## Files changed

- `src/shared/daw-assistant/digest.js`
  - `instrument()` gains `patchId` and `params` (via the existing `scalars()`
    cap, same rules as module params).
  - New `MAX_PACKS = 8`, `MAX_PATCHES = 64`.
  - New `packList(list, drop)` — projects the renderer's compiled-pack shape
    (`{ id, version, manifest: { name, patches } }`) into the digest's flat
    `{ id, version, name, patches: [{id,name}] }`. Used by `buildDigest`.
  - New `clampPackList(list, drop)` — mirrors `packList` but reads the
    already-flat shape a client-supplied digest carries (`digest.packs` is
    never nested under `manifest`). Used by `clampDigest`.
  - `buildDigest(state, { packs = [] } = {})` — second param is new.
  - Both `buildDigest`/`clampDigest` return shapes and their non-object/empty
    fallbacks now include `packs: []`.
- `src/shared/daw-assistant/plan.js`
  - SPECS: `SetInstrumentParam: { trackId: idOrRef, key: objectKey, value: scalar }`,
    `SetTrackInstrumentProgram: { trackId: idOrRef, packId: str(128), patchId: str(128) }`.
  - `validatePlan` switch: two new cases, both following the "capability
    missing = check skipped" rule — `SetInstrumentParam` needs
    `caps.paletteParamKeys(paletteKey)`; `SetTrackInstrumentProgram` needs
    `caps.packPatchIds(packId)` and refuses a `programFollow: 'pinned'`
    instrument outright (no capability needed for that check).
  - `describeAction(action, state, actions = [], packs = [])` — 4th param is
    new, used only to name a patch/pack by display name for
    `SetTrackInstrumentProgram`; every other call site is unaffected by the
    new optional arg.
  - `CALLS.SetInstrumentParam`, `CALLS.SetTrackInstrumentProgram` added.
    Neither creates an id, so no `REF_SLOTS`/`MINTED`/`project()` entries.
  - `planToCommands(plan, state, { makeId, packSelection } = {})` — new
    `packSelection` option, guarded exactly like the existing `makeId` guard:
    throws `TypeError` up front if the plan contains
    `SetTrackInstrumentProgram` and no `packSelection` function was injected.
- `src/renderer/js/components/assistant-dialog.js`
  - Imports `SetInstrumentParam`, `SetTrackInstrumentProgram` from
    `ProjectStore.js` and `paletteParamKeys` from `../palettes.js`.
  - `FACTORIES` gains both new command names.
  - `ASSISTANT_CAPABILITIES` gains `paletteParamKeys`.
  - New module-level `packPatchIds(packs)` and `packSelectionFor(packs)` —
    both read only `pack.manifest.patches` (id/name/address), never a file
    path. This is the one place a pack's manifest is read for the assistant
    path, so digest / capability / resolver cannot drift apart.
  - `AssistantDialog` gains a `packs` dep (`deps.packs`, default `() => []`),
    used in `showPlan` (→ `describeAction`), `runPropose` (→ `buildDigest`),
    and `runApply` (→ `applyPlan`).
  - `applyPlan(plan, store = ProjectStore, packs = () => [])` — new 3rd
    param, builds `packPatchIds` into the capabilities object it passes to
    `validatePlan` and `packSelection` into the options it passes to
    `planToCommands`.
- `src/renderer/js/app.js` — `new AssistantDialog({ store: ProjectStore, packs: () => _packCatalog })`.
  No other change; `_packCatalog` already existed (app.js:110) and is exactly
  the compiled-pack shape `digest.js`/`assistant-dialog.js` expect.
- `tests/daw-assistant.test.js` — allowlist assertion extended; new tests for
  digest `instrument.params`, capped/truncated `packs` (both `buildDigest`
  and `clampDigest`), `SetInstrumentParam` capability validation (bad key,
  non-palette track), `SetTrackInstrumentProgram` validation (pinned refusal,
  uninstalled pack, unknown patch, non-MIDI track, happy path), and
  `planToCommands` throwing without `packSelection` / building the selection
  correctly with one.
- `tests/daw-assistant-dialog.test.js` — one new test: a real
  `SetInstrumentParam` plan applied through `applyPlan` against the real
  `ProjectStore`, asserting the param actually changed and it was one batch
  (one `dispatchBatch` call, undo stack grew by exactly one).
- `specs/daw-assistant.md` — phases 5 and 7 marked `shipped`; phase 5's
  "Blocked until…" paragraph updated to past tense; coverage table rows 2, 4,
  8, 10 re-scored (10 to strong via ask mode, which had shipped earlier but
  the table was never updated for it; 2 and 4 to decent; 8 stays none —
  presets still need `specs/palette-state.md` phase 2).

## Public API surface added

- `digest.js`: `MAX_PACKS`, `MAX_PATCHES` exports; `buildDigest`'s new
  options bag; digest shape gains `packs: [{ id, version, name, patches: [{id,name}] }]`
  and `instrument.patchId`/`instrument.params`.
- `plan.js`: `ALLOWLIST` gains `SetInstrumentParam`, `SetTrackInstrumentProgram`;
  `describeAction`'s new optional 4th param; `planToCommands`'s new
  `packSelection` option.
- `assistant-dialog.js`: `AssistantDialog` constructor's new `packs` dep;
  `applyPlan`'s new 3rd param; `ASSISTANT_CAPABILITIES.paletteParamKeys`.

## Decisions / deviations

- **`programFollow` after an assistant-driven program change ends up
  `'midi'`, always** — `ProjectStore.SetTrackInstrumentProgram` hardcodes
  `programFollow: 'midi'` (ProjectStore.js:212) regardless of
  `selection.source`. The assistant's `packSelection` sets `source:
  'assistant'` for observability only; the store never reads that field. So
  an assistant-picked patch becomes exactly as "live" as one MIDI Program
  Change resolved — nothing pins it — which matches "pack program is picked,
  then MIDI can still steer it" and is consistent with every other program
  resolution path in the app. Flagging because it's easy to assume the
  assistant's choice sticks the way an audition/arm click
  (`programFollow: 'pinned'`) does; it does not.
- **`packSelection`/`packPatchIds` read `pack.manifest.patches` directly**,
  not `pack.byId` (a `Map` only `compilePackManifest` populates) and not
  `resolvePatch` (which resolves by MIDI address + channel profile, a
  different problem than "the model already named a patch id"). This keeps
  the assistant path's only two capability functions trivially testable with
  plain-object pack fixtures, and reuses exactly the fields
  `validatePackManifest` guarantees every patch has (`id`, `name`, `address`).
- **`str(128)`** was used for `packId`/`patchId` field checks rather than the
  `id` check the rest of the allowlist uses for internal ids. `id` also
  rejects `__proto__`/`constructor`/`prototype`; that's harmless here too
  (a real pack id is never one of those), so this is a wash — `str` was
  picked only because the brief's SPECS line literally reads
  `packId: str(...), patchId: str(...)`.
- **`describeAction`'s new `packs` param defaults to `[]`**, so every
  existing call site (including all of `tests/daw-assistant.test.js`'s
  `describeAction(action, state)`/`describeAction(action, state, actions)`
  calls) is unaffected.
- Did not touch `ASSISTANT_INSTRUCTIONS` / `ASSISTANT_PLAN_SCHEMA` in
  `src/web-discovery/index.js` beyond what `ALLOWLIST` already propagates
  automatically (the enum and the "action must be exactly one of" sentence).
  No per-action arg documentation exists there for any other action either,
  so the two new ones need none to stay consistent.
- Did not touch `runAsk()`'s `buildDigest(this.store.getState())` call in
  `assistant-dialog.js` to add `packs` — that is ask-mode code, out of scope
  per the brief. Net effect: ask mode's digest never carries `packs` or a
  track's `patchId`/instrument `params`, only plan mode's does. Both are
  optional/backward-compatible on `buildDigest`, so this is inert, not
  broken — worth a follow-up if ask mode should answer pack-related questions.

## Deferred / not done

- No changes to `specs/palette-state.md` (its phase 2, presets, is still
  `proposed` — untouched, not this task's scope).
- Scenario 8 in the coverage table stays "none": `SetInstrumentParam` can
  edit a sound but there's no save-as-preset action to close it.
- No audition path for `SetTrackInstrumentProgram` — per spec, deliberately
  out of scope ("the assistant proposes a patch; the person hears it after
  apply").
