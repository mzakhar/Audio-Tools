# SoundFont library — phase 5 handoff (browse and search UI)

## Files

| File | Change |
|---|---|
| `src/renderer/index.html` | `#lib-browse` section inside the existing library dialog body (`hidden` by default) |
| `src/renderer/js/components/library-dialog.js` | browse/search/import UI: `library()`, `addFolder()`, `rescan()`, `matches()`, `installed()`, `activate()`, `renderBrowse()`, `renderResults()`, `folderRow()`, `presetRow()`, plus pure `presetRows()`/`packIdForFile()` |
| `src/renderer/js/app.js` | `folderLibrary()` adapter over both origins; `folders`/`importPreset`/`armPack` deps on `LibraryDialog`; `packState` fix |
| `src/renderer/js/instruments/pack-registry.js` | `packPatchState(pack, patchId, loaderFor)` — new export |
| `src/renderer/style.css` | `lib-browse`, `lib-folders`, `lib-search`, `lib-preset`, `lib-state` |
| `tests/library-dialog.test.js` | new — 11 tests |
| `specs/soundfont-library.md` | phases 4 and 5 → done (4 was still marked "not started" although it shipped) |

Nothing under `src/shared/**`, `src/main/**` or `src/preload/**` was touched. No new
component file, no new dialog, no new bar/rail/sidebar — the section lives in the
existing Library dialog, per `specs/ui-shell.md`.

## The one folder-library interface

`app.js` `folderLibrary()` (lazy singleton, above `importPack`) returns one shape or
`null`. Feature detection, in order:

1. `window.electronFS.scanSoundFontFolders` → thin adapter over the phase-3 IPC. The
   only impedance is `folders`: Electron returns `string[]`, so the adapter maps each
   path to `{ id: path, name: path, granted: true }` — the phase-4 browser shape wins,
   and the dialog has one code path.
2. else `canBrowseFolders()` → `createFolderLibrary({ packStore: webPackStore() })`.
3. else `null` → the browse section stays `hidden` and nothing is wired (the LAN http
   route). `LibraryDialog` returns from its constructor before touching any browse DOM.

Dialog deps added: `folders()`, `importPreset(path, presetIndex, onProgress)`,
`armPack(packId, packVersion, patchId)`. `importPreset` in `app.js` refreshes the pack
catalog; `armPack` builds `{ type: 'pack', packId, packVersion, patchId, programFollow:
'pinned' }` and puts it on the armed MIDI track via `ensureMidiTrack` +
`SetTrackInstrument` — the same one-selection concept the instrument browser uses.

## Search

- `presetRows(banks)` flattens to `{ path, presetIndex, packId, patchId, name, title,
  author, program, drums, hay }`. `presetIndex` is the array position in
  `bank.presets`, i.e. the phdr index; nothing sorts or filters that array anywhere.
  Bank order is whatever `scan()` returned (already title-sorted).
- `matches()` lowercases the query, splits on whitespace, requires every term in the
  precomputed `hay`, and **breaks at 200** — the scan cost is proportional to what is
  rendered, not to the 81k rows. No index structure, no virtualization.
- Input is debounced 120 ms (`SEARCH_DEBOUNCE`). Enter in the search field clicks the
  first row; each row is a `<button>`, so Enter on a focused row is native behaviour.
- Empty query lists the first 200 presets, which is the browse view.

## Already imported

`installed(row)` finds a catalog pack with `pack.id === row.packId` and
`pack.byId.get('sf2-' + presetIndex)`. `packIdForFile` duplicates `idFor()` from
`src/shared/sf2-import.js` (slug of the basename without extension) because that module
is the importer, not a renderer utility; the comment names the source. Change both or
neither. An installed row renders `imported` and its click only re-arms — it never
calls `importPreset`, so a second activation cannot reconvert a 90 MB bank.

## `packState` fix

Root cause: `packState` asked "is Electron here?" instead of "can this pack's samples be
read?". `sampleLoaderFor(pack)` already answers the real question for both origins, so
`packState` now delegates:

```js
packPatchState(packFor(instrument.packId, instrument.packVersion), instrument.patchId, sampleLoaderFor)
```

Callers checked: `app.js:437` (instrument slot state) and the `packState` dep passed to
`InstrumentBrowser` (`app.js`, used at `instrument-browser.js:182`). Signature unchanged,
both fixed at once.

`packPatchState(pack, patchId, loaderFor)` is a new pure export in `pack-registry.js`.
It exists so the rule is testable — `app.js` has no seam — and it keeps the
missing/ready/unavailable ordering in one place.

## Deviations

- The `packPatchState` tests live at the bottom of `tests/library-dialog.test.js` (the
  brief asked for the coverage there) rather than in `tests/pack-registry.test.js`.
- Extracting `packPatchState` is a one-caller helper; justified only by the test seam.
- Row detail column is `bank title · author · GM <program>` and `drums` instead of a GM
  number for bank 128 presets. The program number is the raw phdr value (0-based).

## Deferred

- No keyboard up/down navigation through results — Tab and native focus cover it; add
  arrow keys if a real list feels slow to walk.
- Scan runs on first open and on RESCAN only. A folder added outside the app needs a
  RESCAN click; the cache makes that near-instant.
- Electron's `requestAccess` is a constant `true`; only the browser half can lapse.
- No progress UI beyond the shared `PROGRESS` status line already used by whole-bank
  import.
- `scanSoundFontFolders` still retries previously skipped banks each scan (phase 3
  note); unchanged here.

## Verify

`npx vitest run` → 85 files, 1113 passed (was 1102; +11).
