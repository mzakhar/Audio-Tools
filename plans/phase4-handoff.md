# SoundFont library — phase 4 handoff (folder library, browser)

## Files

| File | Change |
|---|---|
| `src/renderer/js/instruments/soundfont-folder-web.js` | new — `canBrowseFolders()` + `createFolderLibrary()` |
| `src/renderer/js/instruments/pack-store-idb.js` | `appendPack()` + pure `mergeManifests()`; `request`/`done` now exported |
| `src/renderer/js/instruments/pack-import-web.js` | `parseInWorker` exported and takes `presets` |
| `src/renderer/js/workers/sf2-worker.js` | parse message carries optional `presets` |
| `tests/soundfont-folder-web.test.js` | new — 12 tests |

Nothing in `src/main/**`, `src/preload/**`, `src/shared/**` or `components/**` was touched.

## Exported surface

```js
canBrowseFolders() → boolean          // showDirectoryPicker && indexedDB, feature detect only

createFolderLibrary({ idb?, packStore?, pickDirectory?, parse? }) → {
  listFolders()                       → [{ id, name, granted }]
  addFolder()                         → same, or null if cancelled   // user gesture
  requestAccess(folderId)             → boolean                      // user gesture
  removeFolder(folderId)              → [{ id, name, granted }]
  scan()                              → { folders, banks, skipped }
  importPreset(bankPath, presetIndex, { onProgress }) → { id, version, manifest, bytes }
}
```

`idb` defaults to `indexedDB`, `pickDirectory` to `showDirectoryPicker({ mode: 'read' })`,
`parse` to `parseInWorker`. `packStore` must be the app's `webPackStore()` — without
it `importPreset` throws the same "no IndexedDB" message the web import uses.
Construction itself touches no global and no permission; `showDirectoryPicker` is
only called inside `addFolder`.

Bank row, deliberately the phase 3 shape plus `folderName`:

```js
{ path, folder, folderName, fileName, size, mtimeMs, title, info, presets }
```

- `path` = `` `${folderId}/${fileName}` `` — the browser's stand-in for the Electron
  absolute path, and the first argument to `importPreset`. Same field name so phase 5
  handles both halves' rows with one code path.
- `folder` = folder id (slug of the directory name, `-2` suffixed on collision),
  `mtimeMs` = `File.lastModified`.
- **`presets` array position is still the `presetIndex`** (phdr index → patch id
  `sf2-N`). Do not sort or filter it in place.
- `folders` in the scan result is `[{ id, name, granted }]`, **not** the Electron
  `string[]`.

## IDB schema

New database, so the packs DB keeps `DB_VERSION 1` and no migration exists:

| | |
|---|---|
| `synth-soundfont-folders` v1, store `folders` | key = folder id, value `{ id, name, handle }` — the `FileSystemDirectoryHandle` is stored raw (structured clone) |
| same DB, store `banks` | key = `path`, value = the bank row above (raw title, before collision suffixing) |

Cache semantics mirror Electron: a row is reused verbatim when `size` and `mtimeMs`
both match, anything else is re-indexed, rows of removed folders and removed banks are
pruned. **Difference:** rows of a folder we could not read this scan are *kept*, because
"permission not granted yet" is the normal state after a reload and would otherwise wipe
the index on every startup. Such a folder reports `granted: false` and contributes zero
banks and zero to `skipped`.

Indexing feeds `readBankIndex` with `file.slice(offset, offset + length).arrayBuffer()`;
`sdta` is never sliced (asserted by recorded slice ranges in the test).

## Worker message change

`{ type: 'parse', id, bytes, name, presets? }` — `presets` is a list of phdr indices,
omitted/null converts the whole bank, so every existing caller is unchanged.

## Pack merge

`packStore.appendPack(manifest, samples)` — creates the pack when absent, otherwise
merges by patch id with the exact `mergeIntoPack` rules (re-import is a no-op returning
the installed pack; `defaultPatchId` only rewritten if it stopped naming a real patch;
`defaultDrumPatchId` adopted only to fill a gap, else deleted). Samples and manifest go
in **one** IndexedDB transaction, so the Electron write-order guarantee is free here —
there is no half-written state to protect against. `savePack` is unchanged.

## What phase 5 must call

1. `canBrowseFolders()` — false means render no folder UI at all (Electron renderer,
   LAN http). Electron keeps using `window.electronFS.*SoundFontFolder*`.
2. Build one library per app, `createFolderLibrary({ packStore: webPackStore() })`.
3. List: `await lib.listFolders()`; add on a click: `await lib.addFolder()` (null =
   cancelled); a row with `granted: false` needs a button calling
   `lib.requestAccess(id)` from the click, then a re-`scan()`.
4. Search: `const { banks, skipped } = await lib.scan()` and flatten
   `banks.flatMap(bank => bank.presets.map((preset, i) => ({ bank, preset, presetIndex: i })))`.
   No filtering happens in this module.
5. Import: `await lib.importPreset(bank.path, presetIndex, { onProgress })` — the
   progress stages are `reading|parsing|storing|done`, the same keys
   `library-dialog.js`'s `PROGRESS` map already has. Then `refreshPackCatalog()`.
6. "Already imported" is `packCatalog()` lookup by `patch.id === 'sf2-' + presetIndex`
   inside the pack whose id is the bank filename slug.

## Deviations / deferred

- **No `app.js` wiring** (phase 5 owns it): nothing constructs the library yet.
- `withDisplayTitles` is duplicated from `src/main/soundfont-folders.js` rather than
  shared — that file imports node builtins and cannot enter the renderer bundle. The
  copy is behaviourally identical and carries a comment saying so; change both or
  neither.
- Scan is non-recursive, matching Electron (`ponytail:` comment at `bankFiles`).
- Failed banks are retried every scan, as in Electron. Same cache-the-failures note
  applies if a bad-file-heavy collection gets slow.
- Import still reads the whole bank into memory (`MAX_SF2_BYTES` 128 MB, shared with
  the web whole-bank import), which is the phase-2 streaming deferral, unchanged.
- `packState()` in `app.js` never checks the idb origin (pre-existing, flagged in
  `plans/soundfont-library-surface.md` §2) — an imported-from-folder pack will report
  `unavailable` in Electron-less builds until phase 5 fixes that check.

## Verify

`npx vitest run` → 84 files, 1102 passed (was 1089; +13).
