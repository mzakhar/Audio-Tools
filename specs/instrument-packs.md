# Instrument Packs — GM Program Change and Bank Select

Load large playable instrument libraries without making Synth startup, project load, or normal MIDI play wait on a whole sound bank. General MIDI (GM) is the first compatibility profile; packs may define any bank/program map.

---

## Status

| Phase | State | Commit |
|---|---|---|
| 0 — Contracts and parser | done | `91ac5e8` |
| 1 — Pack manifest and GM starter pack | in progress — registry done | `adedcd4` |
| 2 — Lazy sample instrument | done | `ecd46d9` |
| 3 — Channel program state and routing | done | `d5fb36c` |
| 4 — Project persistence and UI | done | `d5fb36c` |
| 5 — Pack manager and `.sf2` import | done — local `.sf2` only | `57ca872` |

## Progress — 2026-08-25

- Selected MIDI tracks now use a dedicated Instrument inspector: unified Internal Synth / Pack / Rack source picker, MIDI channel, explicit bank/program selectors, incoming-program follow toggle, and C4 audition. Track headers retain only a compact source summary.
- Electron imports selected local PCM `.sf2`, validates pack files, then atomically publishes under user-data `instrument-packs/`. Renderer has list/import/sample-byte IPC only.
- Pack patches appear in track selectors. Missing selections remain saved, labeled, and silent. Bank Select/Program Change routes only MIDI-following pack tracks; channel 10 prefers GM percussion.
- Samples decode on first use into bounded LRU cache. Timeline and offline bounce use packs; bounce preloads required samples and reports missing identifiers.
- Manual pack and program choices now pin the patch by default; selected presets warm three representative octaves without eagerly decoding a whole bank.
- Legacy packs without envelope metadata keep SF2 loops shorter than 20 ms unlooped to avoid raw buzz.
- New `.sf2` imports retain basic volume envelopes so short sustain loops can play without becoming raw buzz; re-import older local packs to gain this metadata.
- Deferred: home-server catalog, remote download, zip install, enable/disable/remove UI. No static HTTPS catalog source, signed artifact, or zip extractor exists here; adding one would invent distribution/trust policy. Local `.sf2` remains first path.

## Product decisions

- MIDI channels remain zero-indexed internally. MIDI channel 10 is `channel: 9`.
- A Program Change selects an instrument **per incoming MIDI channel**, then applies it to every project MIDI track routed to that channel. Existing channel layering stays intact.
- GM uses bank `0:0`, programs `0–127`. Program `0` is Acoustic Grand Piano.
- Channel 10 gets a GM percussion patch by default. A selected non-drum patch is allowed; it disables GM drum-note labels rather than silently changing its program.
- Pack bytes never enter project files. Projects store stable pack and patch identifiers plus the received bank/program state. Missing packs remain editable and silent with a clear warning.
- Do not bundle a whole GM SoundFont in the Electron installer or web app. First shipped content is a small, legal starter pack; larger packs install separately from the home server and samples load on demand.
- The app may offer freely licensed packs with attribution/provenance caveats because this is a non-commercial fun project. Preserve each source license and notice; still reject NC and no-redistribution assets because the app redistributes them.
- Runtime format is Synth’s manifest plus individual compressed audio files. `.sf2`/`.sf3` are import sources, not playback formats: no SoundFont parser, synth engine, or licensing tangle on the audio hot path.

## Current fit

`parseMidiMessage()` already emits CC and channel-aware events; add Program Change there. `MidiController` already emits one `midi-event`. `routeChannel()` and `liveInstrumentFor()` already own per-channel live delivery. `ProjectStore` is schema version 4 and already persists tracks/instruments. Existing palette and rack instruments remain valid selections.

Use new pure modules under `src/renderer/js/instruments/`; keep the controller and app wiring imperative shells. No dependency required.

---

## 0 — Contracts and parser

### MIDI parser

Extend `src/renderer/js/midi/midi-message.js`:

```js
// status 0xC0–0xCF: one data byte
{ kind: 'program-change', channel, program } // program: 0..127
```

CC0 and CC32 remain ordinary `{ kind:'cc' }` parser events. State belongs outside the parser so byte decoding stays pure and stateless.

### Channel state core

**New:** `src/renderer/js/instruments/channel-program.js`

```js
export const DEFAULT_CHANNEL_PROGRAM = { bankMsb: 0, bankLsb: 0, program: 0 }

export function applyChannelMidi(stateByChannel, event, resolvePatch)
// -> { stateByChannel, change: { channel, bankMsb, bankLsb, program, patch } | null }
```

Rules:

1. CC0 changes only pending/current `bankMsb`; CC32 changes only `bankLsb`; both return `change: null`.
2. Program Change writes `program`, then resolves exactly `(bankMsb, bankLsb, program)`. This is the latch point. No voice is replaced merely by bank CC traffic.
3. Either bank CC may arrive alone, in either order, or after a prior Program Change. Preserve the other current bank byte. This handles real controllers and sequencers safely.
4. Program Change without bank CC uses that channel’s current values, initialized to `0:0`. This is normal GM behavior.
5. Web MIDI data is already 7-bit. Defensive pure-core callers clamp/reject invalid channel, controller, bank, and program values; invalid input produces no change.
6. Do not chase GM Reset SysEx. Web MIDI access is deliberately `sysex: false`.

Use a 16-entry array internally. Never infer program state from tracks: an incoming MIDI port owns it, then a resolved selection gets copied into routed tracks.

### Tests

`tests/channel-program.test.js`: initial PC; CC0 → CC32 → PC; reverse CC order; only CC0; only CC32; PC after a prior bank; PC with no bank; all sixteen channel isolation; invalid values; no resolve before PC.

---

## 1 — Pack manifest and GM starter pack

### Installed pack layout

Installed user-data directory, not `src/renderer`:

```text
instrument-packs/
  <pack-id>/<version>/
    manifest.json
    audio/<sample-id>.ogg
    LICENSE.txt
    NOTICE.txt
```

Electron owns installation and atomic replacement. The renderer receives a validated read-only catalog. Web deployment ships only packs explicitly included in build assets; later it can cache selected optional packs through the browser cache. One pack-version is pinned by each project selection.

### Manifest

```json
{
  "schemaVersion": 1,
  "id": "synth-gm-starter",
  "version": "1.0.0",
  "name": "Synth GM Starter",
  "license": { "spdx": "MIT", "noticeFile": "NOTICE.txt", "sourceUrl": "https://…" },
  "profiles": ["gm1"],
  "patches": [
    {
      "id": "gm-acoustic-grand",
      "address": { "bankMsb": 0, "bankLsb": 0, "program": 0 },
      "name": "Acoustic Grand Piano",
      "category": "Piano",
      "kind": "sample",
      "zones": [{ "keyLo": 0, "keyHi": 127, "rootKey": 60, "sampleId": "piano-c4" }]
    },
    {
      "id": "gm-standard-kit",
      "address": { "bankMsb": 0, "bankLsb": 0, "program": 0 },
      "channelProfile": "gm-percussion",
      "name": "Standard Kit",
      "kind": "drum-kit",
      "notes": { "36": "kick-1", "38": "snare-1", "42": "closed-hat-1" }
    }
  ]
}
```

Address plus optional `channelProfile` is unique. `gm-percussion` on channel 10 wins over same-address melodic patch; other channels use melodic. A custom pack can omit `profiles`, use any values in `0..127`, and define its own labels.

At catalog load, compile each manifest into `Map("msb:lsb:program:profile", patch)`. Validate zone ranges, sample references, duplicate addresses, license/notice files, and size quotas before exposing it.

### GM compatibility

Ship a constant GM Level 1 program-name table. It provides labels for all 128 `0:0` programs even when the selected pack has no corresponding patch. A pack claiming `gm1` must map all 128 melodic addresses and at least one `gm-percussion` kit. The first small starter pack may **not** claim `gm1`; it declares only what it actually contains.

---

## 2 — Lazy sample instrument

**New:** `src/renderer/js/instruments/sample-instrument.js`

```js
export function sampleInstrumentFor(patch, { ctx, output, sampleStore })
// -> { noteOn(pitch, velocity), noteOff(pitch), preload(), dispose() }
```

- `sampleStore.get(sampleId)` fetches and decodes only an addressed sample, deduplicates in-flight loads, and caches decoded `AudioBuffer`s with LRU byte budget.
- `noteOn` is async only until first sample availability. It queues the current note if sample loading begins; note-off before resolution cancels it. Never schedule an old note after release.
- One sample zone per note is MVP; honor `keyLo`, `keyHi`, `rootKey`, gain, loop points, and velocity range. Round-robin and release samples wait for actual demand.
- Per-note `AudioBufferSourceNode` is normal Web Audio. Stop/disconnect on note-off and `dispose()`.
- Keep decoder and cache policy behind `sampleStore`; initial budget recommendation: 128 MiB desktop, 48 MiB web. Actual ceiling remains configurable because hardware varies.

`liveInstrumentFor()` gains `instrument.type === 'pack'`, reusing this contract. Timeline playback gains same selection before adding any more render paths. Offline bounce resolves required samples before scheduling; report exact missing samples instead of silently rendering silence.

---

## 3 — Channel program state and routing

App shell handles `program-change`, CC0, and CC32 before existing note/CC/bend delivery.

```js
const result = applyChannelMidi(channelPrograms, event, resolvePatch)
channelPrograms = result.stateByChannel
if (result.change) {
  for (const trackId of routeChannel(midiTracks, event.channel, armedTrackId)) {
    ProjectStore.dispatch(SetTrackInstrumentProgram(trackId, result.change.selection))
  }
}
```

`selection` stores `{ packId, packVersion, patchId, bankMsb, bankLsb, program, source: 'midi' }`. Do not persist transient CC updates until a Program Change latches a selection.

### Fallback order

1. Exact pack address/profile match.
2. Same pack default: `pack.defaultPatchId` (for channel 10: `defaultDrumPatchId`).
3. Existing track instrument stays active; selection records `unresolved` address and UI warns. This avoids a surprise piano or an unrelated sonic change in a live set.

Never use “nearest GM category” as automatic audio fallback. Category is metadata, not a reliable sound substitute. UI may show the GM label for diagnosis.

### Drum machine interaction

The native TR-909 palette/rack stays a separate instrument. A MIDI Program Change on channel 10 chooses an installed drum-kit patch only when that routed track is `type:'pack'` or allowed to follow MIDI programs. It never overwrites a user-pinned 909 track. Add track policy: `programFollow: 'midi' | 'pinned'`, default `midi` for pack tracks, `pinned` otherwise.

---

## 4 — Persistence and UI

Schema bump to 5. Migration adds no program state to older tracks; their current palette/rack selection stays pinned.

```js
track.instrument = {
  type: 'pack', packId, packVersion, patchId,
  programFollow: 'midi',
  received: { bankMsb: 0, bankLsb: 0, program: 0 }
}
```

Save the effective resolved patch and received address. On load: resolve the pinned `(packId, version, patchId)` first. If unavailable, retain the object, render a missing-pack badge, and preserve it through save/export. Do not silently upgrade an old project to a newer pack version.

Track header adds one compact instrument selector plus read-only live label:

- `GM: Acoustic Grand Piano` for known `0:0` GM mapping.
- `Drums: Standard Kit` on channel 10.
- `My Pack / Bank 3: Patch 12` for custom mappings.
- `Missing pack — Bank 3: Patch 12` for unresolved selection.

Program Change messages must not create undo entries or dirty a project until user chooses “save incoming program changes.” Default: project becomes dirty because state changes are intentional and must restore reproducibly. Add an optional per-track `programFollow:'pinned'` before live performance workflows demand “audition only.”

---

## 5 — Pack manager and `.sf2` import

MVP manager: list installed packs, install a manifest-indexed pack from the home server or a local zip, enable/disable, remove unused version, license/notice viewer, and preload button. Validate archive paths and manifest sizes before extraction; cap pack compressed size, file count, decoded sample duration, and sample rate. Never execute pack code.

Home-server catalog is static JSON plus immutable pack zip URLs and SHA-256 hashes. The renderer lists it; Electron downloads to a temporary file, verifies hash, then atomically installs. The web build downloads directly, verifies before caching, and reports quota failures. HTTPS is required for remote pack downloads; local import remains available.

Import priority:

1. Synth pack zip — first-class, fully validated.
2. Directory of WAV/OGG plus authored manifest — developer workflow.
3. `.sf2` converter — **v1 Electron-only tool**, explicitly creates a Synth pack and records upstream license/notice. It parses presets, instruments, zones, generators, stereo links, loop points, and PCM samples; translates the supported subset into WAV/OGG samples and manifest patches. It must preserve Bank MSB/LSB where the source exposes them, program number, preset name, and source metadata. Emit an import report for unsupported modulators/generators instead of inventing sound behavior. Imported packs are local-only until a user explicitly exports them.

`.sf3` waits: Vorbis-in-SoundFont support adds a decoder and needs real source files. The user requested `.sf2`, so build `.sf2` first.

No cloud marketplace, pack download catalog, or arbitrary remote URLs in this feature. Install URL flow needs provenance, update, and trust policy; add only when pack distribution actually needs it.

---

## Test plan

| Sequence | Expected |
|---|---|
| `B0 00 00`, `B0 20 00`, `C0 00` | channel 1 resolves GM program 0 |
| `B0 20 02`, `C0 05` | resolves `0:2:5`; absent MSB stays 0 |
| `B0 00 03`, `C0 12`, `B0 20 04`, `C0 12` | first `3:0:18`, then `3:4:18`; second bank CC alone changes no sound |
| `C9 00`, note 36 | channel 10 resolves drum profile; kick plays |
| `C0 40` without banks | uses that channel’s existing bank or `0:0` |
| bank/program unknown | active instrument continues; unresolved badge/address persists |
| rapid bank + PC on two channels | isolated selections; no cross-channel patch bleed |
| repeated program and held notes | policy: held voices finish on old patch; new note uses new patch |
| sample still loading then note-off | no late voice starts |
| missing pack after project reload | no crash/audio; selection survives next save |
| offline bounce with missing sample | fails with pack/sample diagnostic |

Unit: parser, channel core, manifest validation/indexing, GM table, fallback resolver, sample-cache LRU. Integration: `MidiController` event, routed layered tracks, persistence migration, track label. Audio smoke: buffer nodes stop/disconnect and decoded-cache budget evicts unused buffers.

---

## Candidate source packs — licensing review required before shipping

| Source | Format / approximate size | License and fit |
|---|---|---|
| [FluidR3 / FluidR3Mono](https://github.com/musescore/MuseScore/blob/main/share/sound/FluidR3Mono_License.md) | GM `.sf2`; common mono build is roughly 70–150 MB depending release | **Best first full-GM candidate.** MIT permits commercial redistribution/modification if copyright and permission notice ship. Verify exact downloaded release, checksum, notices, and every included attribution before bundling. |
| [MuseScore General](https://ftp.osuosl.org/pub/musescore/soundfont/MuseScore_General/) | GM `.sf3` 38 MB, `.sf2` 206 MB | Good coverage; source mirror lists both sizes and license/source files. Treat as GPL-family/exception review, not default commercial bundle, until exact license terms and build obligations approved. |
| [GeneralUser GS](https://github.com/ROCKNIX/generaluser-gs/blob/main/LICENSE.txt) | GM `.sf2`; roughly 30 MB | Strong sound/reputation and author permits software use/modification, but license discloses uncertainty about some sample provenance. Good optional catalog pack for this non-commercial project; show its notice/provenance warning. |
| [Free Drum Samples](https://github.com/Boochi44/free-drum-samples/blob/main/README.md) | WAV one-shots; three trap/808-style kits, size varies | CC0 1.0; commercial bundling and modification allowed. Good for custom/Synth drum banks, not GM-complete; author says samples derive from CC0 TR-808 set. Curate/map notes yourself. |

Sound quality is subjective: FluidR3 and GeneralUser are long-standing GM banks; MuseScore General is broader/larger; the CC0 drum repository is niche beatmaker content. Run a listening pass and license/provenance review on the exact artifact before release. Do not use “royalty-free” sample packs that prohibit redistribution as app assets.

## Acceptance

- External GM sender selects exact programs on 16 independent channels, including a GM kit on channel 10.
- A project reloads with identical pack/patch selections, or a visible missing-pack state with no data loss.
- Enabling a 200 MB pack does not decode it on startup; first note only fetches its required sample zone.
- Custom bank addresses resolve without GM assumptions.
- Pack archive cannot write outside its install directory or execute code.
- `npm test` stays green; new pure logic has unit tests.

## Open questions

Resolved 2026-08-25:

1. Full GM pack is an optional home-server install, not installer payload.
2. Prefer free licenses; permit clearly disclosed attribution/provenance caveats for this non-commercial app. Never redistribute assets that prohibit it.
3. `.sf2` import lands in v1; `.sf3` does not.

Remaining: choose the first catalog GM pack after listening and checking the exact downloadable artifact’s notices.
