# Palette presets (phase 2) + assistant `SavePreset` — handoff

Implements `specs/palette-state.md` phase 2 and the one assistant action phase 5
of `specs/daw-assistant.md` names for scenario 8.

## Files changed

- `src/renderer/js/store/ProjectStore.js` — `DEFAULT_STATE.presets = []`;
  `migrate()`'s unconditional tail backfills `next.presets ||= []` (comment
  notes no version bump needed, `CURRENT_VERSION` stays 6). New commands
  `SavePreset(trackId, name, id = null)`, `ApplyPreset(trackId, presetId)`,
  `RemovePreset(presetId)`, inserted next to `SetInstrumentParam`.
  `ApplyPreset` re-derives params from `paletteParamKeys`/`clampPaletteParam`
  so an undeclared/stale key never survives, backfilling any missing key from
  `paletteDefaults`.
- `src/renderer/js/instruments/patch-index.js` — `presetRow()` + `buildIndex`
  gains a `presets = []` param, pushed after packs/palettes/racks. A preset
  row carries `kind: 'preset'`, `presetId`, and an `instrument` (palette +
  params) used only for audition.
- `src/renderer/js/components/instrument-browser.js` — new `preset` scope
  chip (appended after RECENT, so existing scope-cycling behaviour and its
  test are untouched); `index()` reads `deps.presets()`; new `savePreset()`
  (armed track via `ensureTrack()`, rejects a non-palette instrument,
  dispatches `SavePreset`) wired to `#ib-save-btn`/`#ib-save-name`;
  `assign()` branches on `row.kind === 'preset'` to dispatch `ApplyPreset`
  instead of `SetTrackInstrument`; `renderRow()` swaps the state/status cell
  for a "✕ remove" control on preset rows, calling new `removePreset(row)`.
- `src/renderer/index.html` — one `.dlg-row` (existing class) added to the
  instrument browser dialog: `#ib-save-name` text input + `#ib-save-btn`
  button, between the scope chips and the list.
- `src/renderer/style.css` — `.ib-preset-remove` (cursor/hover) and
  `.dlg-row .ib-search { flex: 1; width: auto }` so the name input sits next
  to the save button inside the existing flex row.
- `src/renderer/js/app.js` — `InstrumentBrowser` deps gain
  `presets: () => ProjectStore.getState().presets || []`.
- `src/shared/daw-assistant/plan.js` — `SPECS.SavePreset: { trackId: idOrRef,
  name: str(64) }`; `validatePlan` case (track exists, instrument is a
  palette); `describeAction` case (`Save the sound on <track> as "<name>"`);
  `CALLS.SavePreset` mints via `ids.presetId`; `MINTED.SavePreset: mint => ({
  presetId: mint('preset') })` (picked up by `MINTS_IDS` automatically). No
  `REF_SLOTS`/`CREATING`/`CREATED_NOUN` entry — nothing references a preset.
- `src/renderer/js/components/assistant-dialog.js` — `SavePreset` added to
  the `ProjectStore` import and to `FACTORIES`.
- `specs/palette-state.md` — phase 2 row → `shipped`.
- `specs/daw-assistant.md` — phase-0 allowlist table gains a `Presets` group
  (`SavePreset`); "deliberately excluded" list gains `ApplyPreset`,
  `RemovePreset` with the one-line reason (only saving was ever requested);
  also dropped `SetTrackInstrumentProgram` from that excluded list since
  phase 7 already shipped it (pre-existing drift, fixed in passing on the
  same line I was editing). Scenario 8 coverage row re-scored to "decent".
- Tests: `tests/palette-state.test.js` (presets describe block + a
  presets-backfill migrate test), `tests/daw-assistant.test.js` (ALLOWLIST,
  validatePlan, describeAction, planToCommands cases),
  `tests/daw-assistant-dialog.test.js` (real-store apply-as-one-batch case),
  `tests/patch-index.test.js` (preset row shape), `tests/instrument-browser.test.js`
  (markup gains `#ib-save-name`/`#ib-save-btn`; preset listed beside packs;
  save/apply/remove behaviour).

## Verify

`npm test` — 98 files / 1293 tests, all green (baseline 98/1277 + 16 new).

## Decisions / deviations

- `SavePreset`'s rejection path (missing track or non-palette instrument)
  returns the original `state`, matching the same pattern used by
  `SetInstrumentParam`/`SetTrackInstrument`.
- The instrument browser's "preset" scope chip is appended **after** RECENT
  rather than inserted earlier, specifically so the existing
  `tests/instrument-browser.test.js` Tab-cycle assertions (which only walk
  the first 4 tabs) needed no change to their expected sequence.
- A preset row's remove control reuses the row's existing status cell
  (rightmost column) rather than adding a 6th grid column, so no other row
  kind's layout changes.
- No new dialog: save/apply/remove all live in the existing instrument
  browser `<dialog>`, per `specs/instrument-browser.md`'s "one selection
  concept" and the spec's explicit "no new surface" instruction.
- Per the brief, only `SavePreset` was added to the assistant vocabulary;
  `ApplyPreset`/`RemovePreset` are intentionally absent from
  `plan.js`/`assistant-dialog.js` and from the allowlist.

## Deferred / not done

- A user-level preset library that outlives one project — explicitly out of
  scope per `specs/palette-state.md` ("What this unblocks" / phase 2 text).
- Nothing else from the brief was deferred.
