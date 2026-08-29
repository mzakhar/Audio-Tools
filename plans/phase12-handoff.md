# SoundFont library — phases 1 & 2 handoff

## Files

| File | Change |
|---|---|
| `src/shared/sf2-index.js` | new — bank index, pure + one injected `read` |
| `src/shared/sf2-import.js` | exports RIFF primitives; `presets` option; INFO via `sf2-index` |
| `tests/helpers/sf2-bytes.js` | new — RIFF byte builders + `multiPresetFixture`, shared by both test files |
| `tests/sf2-index.test.js` | new — 12 tests |
| `tests/sf2-import.test.js` | builders moved to the helper; 4 tests added |
| `specs/soundfont-library.md` | status rows 1 & 2 → done; `readBankIndex` signature corrected |

## Exported signatures

```js
// src/shared/sf2-index.js
parseInfo(view, infoChunk) -> { name, author, date, product, copyright, comment, software }
bankTitle(info, fileName = '') -> string
readBankIndex(read, { fileName = '', byteLength = Infinity }) -> Promise<{ title, info, presets }>
//   read: (offset, length) => Promise<Uint8Array>   (short read at EOF throws)
//   presets: [{ bank, program, name }]

// src/shared/sf2-import.js — newly exported, previously module-private
text(view, off, len), name(view, off, len), chunks(view, start, end), fail(message)
importSf2(input, { id, version, presets = null, license })
```

`infoChunk` is the **LIST** chunk that holds the `INFO` fourCC — `{ data, size }` where
`data` points at the fourCC, matching `chunks()` output. `parseInfo` skips the first 4 bytes itself.

## Deviations from the brief / spec

- Spec said `readBankIndex(view, { fileName })`; implemented the brief's `read`/`byteLength`
  form and corrected the spec text. Nothing else in the repo called it yet.
- `fail` is exported too (brief listed only `chunks`/`text`/`name`) — the alternative was
  duplicating the `Invalid SF2:` prefix, which would let the two modules drift.
- `manifest.name` is now `bankTitle(bankInfo, id) || sourceName`; `manifest.source.name`
  still holds the raw INAM (or `'Imported SoundFont'`), and `manifest.id` is unchanged:
  `idFor(id || sourceName, 'imported-sf2')`. So a generic-INAM bank changes its display
  name but never its identity.
- `manifest.source.info` always present (all seven keys, `''` for missing).

## Landmines

- **`sf2-import.js` and `sf2-index.js` import each other.** The cycle is safe only because
  every cross-module use is inside a function body. Do not add a top-level `const` in
  either file that is computed from the other's exports.
- `readBankIndex` stops walking as soon as it has both INFO and pdta, so a malformed chunk
  after pdta is never noticed. Deliberate: the point is to not read the rest of the file.
- The chunk-header read is `Math.min(12, riffEnd - pos)` — 12 bytes so a LIST's type
  fourCC arrives with its header. An Electron `read` that returns fewer bytes than asked
  is treated as EOF and throws; a caller wrapping `fs.read` must loop until satisfied or
  genuinely at EOF.
- Per-preset import still parses every phdr record's *header* (it only skips zone work),
  and still takes the whole bank as a buffer — streaming sample reads remain deferred.
- `MAX_SAMPLES`/`MAX_PACK_BYTES` in `src/main/instrument-packs.js` are untouched; phase 3
  is what threads `presets` through `importSf2Pack`.
- Patch ids stay `sf2-${phdrIndex}`, asserted by
  `tests/sf2-import.test.js > per-preset import > keys patch ids on the phdr index`.
  The append-to-pack model in phase 3 depends on it.

## Verify

`npx vitest run` → 82 files, 1079 passed (was 1063; +16).
