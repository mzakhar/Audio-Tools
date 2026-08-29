# SoundFont Library — browsing a folder of banks

Point Synth at a directory of `.sf2`/`.sf3` files and play any preset in any of
them, without converting a single byte you did not ask for.

Companion to `specs/instrument-packs.md` (pack format, GM routing, import
pipeline) and `specs/ui-shell.md` (the Library dialog this lands in). This file
owns only the "many banks on disk" problem.

---

## Status

| Phase | State |
|---|---|
| 0 — Non-mono, ROM, SF3 samples | done |
| 1 — Bank index (`sf2-index.js`) | done |
| 2 — Per-preset import | done |
| 3 — Folder library (Electron) | done |
| 4 — Folder library (browser) | done |
| 5 — Browse and search UI | done |

`specs/music-discovery-agent.md` adds an optional research UI above this local
index. It must call the phase-5 preset handoff rather than create another
importer or read sample bytes for remote recommendations.

## The measurement this plan is built on

Taken from `E:\Audio Projects\Packs\500-soundfonts-full-gm-sets` (the archive.org
"500 Soundfonts Full GM Sets" collection), 2026-08-29:

| | |
|---|---|
| Banks | 495 `.sf2` |
| Total size | 46 GB |
| Over the 128 MB browser cap | 88 |
| Over the 256 MB Electron cap | 47 |
| Banks containing stereo samples | ~48% (24 of a 50-file sample), and near 100% above 20 MB |
| Banks containing ROM samples | ~12% |
| Largest bank | 1.9 GB, 5608 samples, 150 presets |
| Most presets in one bank | 905 |

Bank metadata, from the `INFO` chunk of all 500 files:

| Field | Present | Notes |
|---|---|---|
| `INAM` name | 100% | 101 files share a colliding name — "User Bank" alone appears 21× |
| `IENG` author | 79% | the field that actually separates one "User Bank" from another |
| `ICOP` copyright | 81% | currently discarded at import |
| `ICMT` comment | 70% | 242 files carry more than 40 characters of it |
| `ICRD` date | 54% | |
| `IPRD` product | 43% | usually the target hardware, e.g. `SBAWE32` |

Only one file has a blank or generic name, but 62 have `.sf2` inside the name
itself ("sc-55.sf2", "8mbgmgs.sf2, please use this filename.") and 54 run past
32 characters.

Two conclusions follow, and everything below is downstream of them:

1. **Whole-bank import is the wrong unit of work.** Converting one 46 GB
   collection into per-sample audio would produce ~46 GB of pack storage. The
   caps are not the problem; the unit is. One preset out of a 90 MB bank is
   2–5 MB.
2. **A bank must be searchable before it is converted.** Nobody picks an
   instrument by reading 495 filenames. The index has to exist separately from
   the audio.

## Product decisions

- A folder is registered, not copied. Synth reads banks in place and stores only
  what it converts.
- The unit the user picks is a **preset**, not a bank. "Import whole bank" stays
  for banks that fit, because a GM bank is worth having whole — Program Change
  across 128 programs is the reason packs exist.
- Per-preset import **appends to one pack per bank**, keyed by the bank file.
  Importing three presets from `ChoriumRevB.sf2` yields one pack with three
  patches, not three packs. Projects reference `packId` + `patchId`, so
  appending is safe and repeatable; the manifest write is the commit point.
- The index is a cache, not state. Deleting it costs a rescan and nothing else.
  Key each entry on path + size + mtime.
- No new dependency. The parser already reads every table this needs.

## Naming

The collection's own `!SF2info.txt` says to open each bank in Polyphone to find
out who made it and when. That information is in the file — Synth just throws
most of it away today, keeping `INAM` as the pack name and nothing else. Reading
the rest costs nothing extra, because phase 1 already reads the whole `INFO`
chunk to get the name.

Rules, each one earned by a number in the table above:

- **Identity stays the filename.** `INAM` collides across 101 of 500 files, so
  it can never be the pack id. This is already how import works; do not "improve"
  it.
- **Display title is `INAM`, with two fallbacks to the filename**: when it is
  blank or generic, and when it contains `.sf2`/`.sf3` (62 files — the names
  there are file-handling instructions, not titles). Do not try to repair such a
  string; the filename is already the better title.
- **Disambiguate only on collision.** When two indexed banks resolve to the same
  title, append the author (`IENG`), else the filename. 399 banks keep a short
  clean name; the 101 ambiguous ones get "User Bank — Yingchun Soul".
- **Author and date are index fields, not decoration.** They are what makes a
  75k-preset search usable: the preset name is "Acoustic Grand Piano" in 400
  banks, so the bank title and author are the only discriminators on the row.
- **`ICOP` and `ICMT` go into the pack's `NOTICE.txt`.** Today it reads
  "Verify upstream license and attribution before redistribution" while the
  source file is carrying a copyright string 81% of the time. Preserving each
  source's notice is already a stated product decision in
  `specs/instrument-packs.md`; this is where the text comes from.

Manifest gains an optional `source.info` holding the raw fields — name, author,
date, product, copyright, comment, software. Raw, not prettified: the display
rule can change later without a reimport.

## Non-negotiables

- `importSf2` stays pure: bytes in, manifest + samples out, no filesystem, no
  globals. The folder walking, caching and IPC live in `src/main/`.
- A bank that fails to index is skipped and logged, never fatal to the scan. The
  collection contains malformed files; one of them must not cost you the other
  494.
- The LAN route (`http://themachine/synth/`) is not a secure context, so the
  browser half of this (phase 4) does not exist there. Electron and
  `https://synth.zakharhome.org` get it; the LAN route keeps manual file import.
- Index entries are metadata only. No sample bytes, no decoded audio, no growth
  proportional to bank size.

---

## 0 — Non-mono, ROM and SF3 samples — done

Prerequisite, shipped ahead of the rest: ~half the collection could not be
imported at all.

- Stereo pairs (`sfSampleType` 2/4, linked by `wSampleLink`) merge into one
  interleaved stereo WAV at import. `zoneFor()` returns only the first matching
  zone, so merging at import is the one way both sides are audible without
  touching the runtime.
- ROM samples (`0x8000`) name E-mu hardware waves that are not in the file; the
  zone is dropped.
- SF3 Ogg Vorbis sample data (`0x10`) passes through uncompressed — its
  `dwStart`/`dwEnd` are byte offsets into `smpl`, and `decodeAudioData` decodes
  Vorbis natively. Samples on disk are `.wav` or `.ogg`; the manifest names
  neither, so the reader tries both.
- A zone the parser cannot honour is skipped rather than fatal. Junk loop points
  cost a sample its loop, not its zone.

Verified by importing every one of the collection's 384 banks under 80 MB: 384
succeeded, 0 failed, 681,874 zones and 6,564 merged stereo samples.

## 1 — Bank index

New pure module `src/shared/sf2-index.js`:

```js
readBankIndex(read, { fileName, byteLength }) → {   // read(offset, length) → Promise<Uint8Array>
  title,             // per the naming rules above
  info: { name, author, date, product, copyright, comment, software },
  presets: [{ bank, program, name }]   // from phdr, terminal record dropped
}
```

Only `INFO` and `pdta/phdr` are needed. Both are small; `sdta` is the whole file
and must not be read. The chunk walk already exists in `sf2-import.js` — export
`chunks()` and `text()` rather than writing a second one.

`importSf2` should read `INFO` through this same function, so an imported pack
and its index row can never disagree about what a bank is called.

In Electron, feed it from positional reads: read the 12-byte RIFF header, walk
chunk headers 8 bytes at a time seeking past `sdta`, then read `pdta` whole.
Reading a 1.9 GB bank's index costs a few MB, not 1.9 GB.

**Check:** index the collection's largest bank and assert peak RSS stays under
~50 MB.

## 2 — Per-preset import

`importSf2(bytes, { presets })` — when `presets` is an array of phdr indices,
skip every other preset. Sample emission already keys off the zones that were
kept, so the sample set shrinks automatically. Roughly a `continue` in the
existing preset loop plus the option plumbing.

The `MAX_SAMPLES` cap (4096) is per-import, so it stops being the binding
constraint the moment imports are per-preset: the 5737-sample banks are only a
problem when taken whole.

**Check:** importing one preset of `ChoriumRevB.sf2` emits fewer than 5% of the
samples the whole-bank import emits, and its zones are byte-identical to the
same preset's zones in the whole-bank manifest.

## 3 — Folder library (Electron) — done

- Renderer IPC: `packs:addFolder(path)`, `packs:listFolders()`,
  `packs:removeFolder(path)`, `packs:importPreset(path, presetIndex)`.
- `src/main/soundfont-folders.js` walks a registered folder for `.sf2`/`.sf3`,
  indexes each file via phase 1, and caches the result as one JSON file under
  userData keyed by path + size + mtime. Rescan is incremental.
- `importPreset` reuses `importSf2Pack`'s staging/publish, with one change: when
  the target pack version already exists, write the new sample files first and
  the merged manifest last. The manifest is the commit point, so a crash leaves
  orphan audio, never a manifest naming audio that is not there.
- Folder paths are user-chosen and escape the `within()` sandbox by design —
  they are read-only inputs. Everything written still goes through `within()`
  against the pack root.

**Check:** a scan of the 495-file collection completes, reports its skip count,
and the cache makes the second scan near-instant.

## 4 — Folder library (browser)

`showDirectoryPicker()` gives a `FileSystemDirectoryHandle` that persists in
IndexedDB across sessions. Same index, same per-preset import, same on-demand
conversion; the handle replaces the path.

Secure-context only — feature-detect and hide the entry point where it is
missing, exactly as the AudioWorklet recorder does. Re-prompting for permission
after a browser restart is expected; treat a denied handle as an absent folder.

## 5 — Browse and search UI

Extends the Library dialog from `specs/ui-shell.md`, no new top-level view.

- One search field over every indexed preset across every registered folder:
  ~500 banks × ~150 presets ≈ 75k entries. Filter, then render the first 200
  — no virtualization until a real list is slow.
- A row is `preset name · bank title · author · GM program`. The preset name is
  the GM name in most banks, so the bank title and author carry the distinction.
  Enter imports and arms it.
- Show which presets are already imported, so a second click is a no-op rather
  than a surprise reconversion.
- Audition before import needs the sample bytes, so it *is* the import. Import,
  then audition; do not build a separate preview path.

---

## Deferred, with the trigger that would undefer it

- **Streaming sample reads.** Phase 2 still reads the whole bank into memory to
  import one preset. That covers 448 of 495 files. Undefer when the >256 MB
  banks are worth having: the parser would take `readSampleBytes(start, end)`
  instead of a whole buffer, and `smpl` would never be resident.
- **SF3 in Safari.** Safari's `decodeAudioData` has no Vorbis. Undefer if Safari
  becomes a target; the fix is decoding to PCM at import, which needs a decoder
  dependency.
- **Pan generator (17).** A mono sample panned by its zone still plays centre.
  Merged stereo pairs are unaffected. Undefer when something audibly wrong is
  traced to it — it needs a manifest field and a `StereoPannerNode` per voice.
- **Eviction / storage budget.** Per-preset import makes runaway growth unlikely
  enough to wait for evidence. Undefer when the Library dialog's usage figure
  gets uncomfortable.
- **Modulators, filters, LFO generators.** The importer reads volume envelopes
  and nothing else from the SF2 modulator model. Unrelated to browsing; listed
  so nobody mistakes an imported preset for a faithful SoundFont render.
