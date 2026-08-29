# SoundFont library — phase 3 handoff (folder library, Electron)

## Files

| File | Change |
|---|---|
| `src/main/soundfont-folders.js` | new — folder registry, incremental index cache, collision titles |
| `src/main/instrument-packs.js` | `importSf2Preset`; `publishPack`/`mergeIntoPack`/`sf2Source`/`checkConverted`/`noticeText` extracted; NOTICE carries `ICOP`/`ICMT` |
| `src/main/index.js` | 5 new `ipcMain.handle` registrations after `instrumentPacks:readSample` |
| `src/preload/index.js` | 5 new `electronFS` methods |
| `tests/soundfont-folders.test.js` | new — 5 tests |
| `tests/instrument-packs.test.js` | +5 tests (`per-preset SF2 import`) |
| `specs/soundfont-library.md` | phase 3 → done |

## IPC surface

Channel prefix stays `instrumentPacks:` for consistency with the existing three
channels — the spec's `packs:*` names are the semantics, not the wire names.

| `window.electronFS` method | Channel | Returns |
|---|---|---|
| `addSoundFontFolder()` | `instrumentPacks:addFolder` | `string[]` of folder paths, or `null` if the dialog was cancelled |
| `listSoundFontFolders()` | `instrumentPacks:listFolders` | `string[]` |
| `removeSoundFontFolder(folderPath)` | `instrumentPacks:removeFolder` | `string[]` (remaining) |
| `scanSoundFontFolders()` | `instrumentPacks:scanFolders` | `{ folders, banks, skipped }` |
| `importSf2Preset(sourcePath, presetIndex)` | `instrumentPacks:importPreset` | `{ id, version, manifest }` |

`addSoundFontFolder` takes **no argument**: main opens
`dialog.showOpenDialog({ properties: ['openDirectory'] })` itself, mirroring
`importSf2Pack`. The renderer never supplies a folder path (phase 4's browser
half is handle-based anyway, so nothing is lost).

Scan result:

```js
{
  folders: string[],          // registered paths, in registration order
  skipped: number,            // banks that failed to index or were not regular files
  banks: [{
    path, folder, fileName,   // absolute path, its folder, basename
    size, mtimeMs,            // the cache key
    title,                    // display title, collision suffix already applied
    info: { name, author, date, product, copyright, comment, software },
    presets: [{ bank, program, name }]
  }]                          // sorted by title, then path
}
```

**`presets` array position is the `presetIndex` for `importSf2Preset`** — it is
the phdr index, and patch ids stay `sf2-${phdrIndex}`. Phases 4/5 must not sort
or filter that array in place.

## On-disk cache format (under Electron `userData`)

- `soundfont-folders.json` — `{ version: 1, folders: string[] }` (resolved, deduped).
- `soundfont-index.json` — `{ version: 1, banks: { [absolutePath]: BankRow } }` where
  `BankRow` is a `banks[]` entry **with the raw title**, before collision suffixing.

Both are caches: deleting either costs a rescan and nothing else. A row is reused
verbatim when `size` and `mtimeMs` both match the file on disk; anything else is
re-indexed. The banks map is rebuilt from the registered folders each scan, so
removed folders/banks drop out without a separate prune.

Scan is **non-recursive** (`ponytail:` comment at the loop) — real collections are
one flat folder. A folder that cannot be read (unplugged drive) stays registered
and contributes zero banks, and does **not** count toward `skipped`.

Collision rule: `withDisplayTitles` counts raw titles across the whole index; a
title seen more than once becomes `` `${title} — ${info.author || fileName}` ``.
Two colliding banks with the same author still collide — acceptable, undefer if
real data shows it.

## Pack-merge semantics (`importSf2Preset`)

1. `sf2Source()` validates the IPC-supplied path: `.sf2`/`.sf3`, `lstat` regular
   file, not a symlink, ≤ `MAX_SF2_BYTES`. `importSf2Pack` now uses it too.
2. `importSf2(bytes, { id: basenameWithoutExt, presets: [presetIndex] })` — same
   id/version derivation as `importSf2Pack`, so every preset of one bank lands in
   one pack (`id` = filename slug, `version` = `1.0.0`).
3. Target `manifest.json` absent → `publishPack()` (unchanged staging + atomic
   rename). Present → `mergeIntoPack()`:
   - patches whose `id` is already present are dropped; **nothing left to add is a
     no-op** — returns the installed pack, does not rewrite the manifest;
   - `defaultPatchId` is only rewritten if it stopped naming a real patch (append
     never breaks it); `defaultDrumPatchId` is adopted from the new preset only to
     fill a gap, and deleted rather than left dangling;
   - order is **samples → asset existence check → manifest**. The manifest is the
     commit point.
4. Merge writes in place, not through staging. A failure mid-merge leaves orphan
   `audio/*.wav` and the previous manifest — the pack still validates.

`NOTICE.txt` is now `Imported from <file>.` + `source.info.copyright` +
`source.info.comment` (each when non-empty) + the existing verify line. Only
written on pack creation; a merge leaves the existing notice alone.

## Landmines / things phases 4/5 must mirror

- Sample files are written as `sampleFile(sample.id)`, i.e. **always `.wav`**, in
  both `publishPack` and `mergeIntoPack`, even for SF3 Ogg payloads. That is
  pre-existing behaviour (`assetPath` probes both extensions), and the merge path
  copies it deliberately so the two importers can never disagree on a filename.
- Registered folder paths are **not** subject to `within()` by design; every write
  still resolves through `within()` against the pack root, and `safePart()` still
  guards each id/version/sample-id path segment. Do not relax either in phase 4.
- The write-order guarantee is covered by
  `tests/instrument-packs.test.js > per-preset SF2 import > writes merged samples
  before the manifest that names them`, which makes the manifest read-only to
  force the failure. It chmods back before cleanup; keep that if you touch it.
- `scanSoundFontFolders` retries previously skipped banks on every scan (a few KB
  each). Cache the failures if a 500-file collection with many bad files gets slow.
- Phase 5's search index should be built from `banks[]` in the renderer; the main
  process returns everything it knows and does no filtering.

## Verify

`npx vitest run` → 83 files, 1089 passed (was 1079; +10).
