# FM-1 firmware emulator — design and implementation plan

Research and planning only. No implementation or performance claim is approved by this document. Companion visual overhaul: `specs/retro-instrument-ui.md`. Research: [[FM-1 emulation in Synth research]] in the Obsidian project `M-Vave FM1 Firmware`.

## Goal and acceptance

Use unmodified M-VAVE FM-1 firmware as a playable, stateful instrument in Synth. Browse an expanding firmware library, import a user's `.fwsc` packages, operate the emulated panel, play and record MIDI, and turn a firmware performance into an audio clip on a DAW track. Multiple tracks can use different firmware or independent instances of the same firmware. A saved project reopens with its exact selected firmware and device state, or clearly identifies missing assets without changing the project.

Completion means: a user imports a supported package; selects it on an armed MIDI track; plays from Synth's keyboard or MIDI; records and edits MIDI notes; plays them back through that same device; captures a sequenced or live device performance to a new aligned audio clip; saves, reloads, and bounces the project; and can add another firmware without a Synth release. Firmware-specific controls remain usable in a device dialog. Mixer routing, mute and solo follow ordinary track behavior.

This is a compatibility target, not a claim that every existing or future package works. The menu distinguishes installed, cataloged, user-imported, tested, untested, unavailable and failed packages. Compatibility is reported per exact package hash and platform.

## Status

| Phase | State | Exit |
| --- | --- | --- |
| 0 — Feasibility and source audit | **evidence in 2026-11-27**, decisions pending (see Phase 0 results) | Target matrix and runnable integration spike establish a viable runtime. |
| 1 — Firmware library | **built 2026-11-27**, not yet checked with real imports in a browser | Import, catalog, identity, storage and recovery work without a Synth release. |
| 2 — Device and live instrument | **built 2026-11-27** | Track-scoped instance plays through Synth and survives UI changes. |
| 3 — Arrangement and capture | **built 2026-11-28** | MIDI clips play and device audio becomes an aligned, durable audio clip. |
| 4 — Project persistence and portability | **built 2026-11-28** | Exact firmware and per-track flash restore safely; missing assets recover. |
| 5 — Offline bounce and transport | planned | Mixed projects bounce without silent omissions; supported sync is explicit. |
| 6 — Compatibility and release | planned | Real environment tests, licensing review and user documentation pass. |

Update this table and decisions after each completed phase. Phase 0 is a gate: no implementation architecture should be represented as verified before it passes.

## Existing Synth boundaries

- `ProjectStore.js` uses schema version 7. Add a new version and migration together when introducing persisted device descriptors; never renumber migrations. Validate all project imports and retain older tracks.
- `midi/live-instrument.js` owns live and audition instruments; `playback/timeline-player.js` currently has a separate scheduled-note adapter, despite the shared-factory direction in `instrument-browser.md`. Both call paths must reach one FM-1 session per track, with no second hidden device for live input during playback.
- `TimelinePlayer.play()` schedules notes via timers and a 50 ms start offset; its bounce creates an `OfflineAudioContext` and schedules ordinary Web Audio sources. A continuously running emulator needs an explicit timestamped event queue and a separate render path; creating an AudioWorklet inside a realtime context is not an offline-render solution.
- Track output goes through `MixerEngine`; `Recorder` currently captures the compressor/master using an AudioWorklet and downloads WAV, not an individual track clip. Track capture needs a dedicated per-track pre-fader tap and existing audio-store/project clip insertion, not a master recording workaround.
- Instrument selection follows the armed MIDI track; browser and settings are dialogs. The rack and pack systems already establish missing-asset and per-track routing conventions. Do not add a permanent rail.
- Static nginx deployment, Electron, LAN HTTP and the renderer's current `connect-src 'self'` CSP are existing constraints. No renderer fetch from public firmware sites; no dependence on Web MIDI for internal event delivery. The effective policy is the meta tag in `src/renderer/index.html` (`connect-src 'self'`, no `wasm-unsafe-eval`); nginx, Electron main and the k8s manifests add no CSP, COOP or COEP header (phase 0).

## Runtime and capability gates

Primary candidate: [fm1-emu](https://github.com/joakimeriksson/fm1-emu), MIT emulator core, Rust/WASM browser frontend; [upstream engineering log](https://github.com/joakimeriksson/fm1-emu/blob/master/PLAN.md) describes an AudioWorklet and runtime WASM JIT. Pin a reviewed commit and exact build toolchain; retain notices and audit transitive components separately. Do not copy a GPL firmware or submodule merely because the core is MIT. No iframe: Synth needs direct audio, MIDI, storage and transport ownership.

Phase 0 must establish on actual target builds whether CSP allows loading and compiling the shipped WASM and JIT-generated modules. Evaluate the narrow `wasm-unsafe-eval` policy and interpreter/JIT-disabled mode against current Chromium and Electron; do not add `unsafe-eval` or relax CSP without a deliberate reviewed decision. Test base URL and assets under `/synth/`. A module loading or worker mechanism must remain same-origin and work without external `connect-src`.

Upstream's browser runtime uses AudioWorklet, unavailable in insecure LAN HTTP. HTTPS and Electron are primary candidates; verify Electron's actual security context. A LAN live-audio solution is a separate gated experiment: worker-generated PCM scheduled into Web Audio buffers without AudioWorklet, bounded queue and measured latency. If it meets timing and stability criteria, ship it; otherwise display unavailable with a clear explanation and preserve ordinary Synth functionality. No promise that worker fallback, SharedArrayBuffer or cross-origin isolation exists. Offline firmware render and playback of already captured audio may work on LAN without live emulation, subject to phase 0 testing. Do not invent a privileged Electron-only shortcut that makes projects incompatible.

Before phase 1, record measured boot time, real-time factor, CPU, underruns, MIDI-to-audio latency and panel responsiveness for Felucca, SLOOP, stock V15 supplied by user, a sample firmware, and heavy FM1-Dock on representative hardware in Electron, HTTPS and LAN. Test one and multiple instances. Record exact firmware and emulator hashes, browser, device, sample rate and settings; declare pass/fail thresholds and reference machine before measurements. If runtime is too slow, report unavailable or overload; never silently change emulated clock or playback speed.

## Firmware library

Separate a **catalog entry** from an **installed immutable binary**. Library dialog and instrument picker share one searchable index. New local packages are immediately selectable after validation, without an app release or network connection. Catalog metadata can be updated independently by explicitly importing a versioned JSON catalog file; reconcile add/update/remove entries without deleting installed packages or breaking project references. This fulfills dynamically growing discovery without runtime requests. Optionally distribute refreshed same-origin catalog snapshots in app builds. Direct remote refresh is out of scope unless a separate network/CSP proposal is approved.

Catalog fields: stable publisher/id, display name, author, version label, device target, description, source and license links, package SHA-256 when known, distribution status, and compatibility status with test provenance. URLs are informational; no automatic code or firmware fetch. Reject malformed, oversized, duplicate-conflicting or non-HTTP(S) metadata links. Show unknown license/compatibility honestly. A catalog may list a package that must be obtained separately; selecting it explains how to import it. Never claim the catalog is exhaustive or that its hash proves trust.

Install flow: user picks a `.fwsc`; validate bounded size and container/target using the upstream parser or a bounded parser; hash bytes; derive metadata only from validated content or user/catalog labels; stage bytes, then atomically publish immutable package and index record. Duplicate hash is idempotent; same name or version with different hash remains distinct. Preserve imported bytes exactly. Reject unsupported target or corrupt package without altering existing assets. Use storage adapters appropriate to Electron and browser, following existing pack and audio-store patterns; do not expose arbitrary filesystem paths to renderer IPC. Report quota/permission errors and offer recovery. Catalog import never executes code or fetches URLs.

Storage identity is `sha256:<hex>`; name and version are display metadata, never identity. Removing an installed package warns about referencing projects; it cannot silently remove project flash or overwrite another version. Restrict bundled binaries to individually reviewed redistribution terms, attribution, source and matching version; official and third-party firmware rights are independent of emulator license. Manual import handles packages Synth may not redistribute.

## Track-scoped device contract

Persist MIDI track selection as an instrument descriptor conceptually `{ type: 'fm1', firmwareHash, midiChannel, flashAssetId }`; exact shape follows store validation and migration. MIDI channel is zero-based internally, chosen per track and visible in settings; defaults are advisory per known firmware, not a universal assumption. Firmware metadata cannot mutate an existing project's choice. The firmware may consume MIDI differently or expose a self-running sequencer.

One session manager owns one emulator per track ID, independent of whether panel dialog is open. Its interface must cover asynchronous create/ready/error, `sendMidi(bytes, audioTime)`, timestamped panel actions, connect/disconnect output, flash snapshot/restore, status, and dispose. A bounded, ordered queue maps AudioContext time to emulator sample frames; note-on/off and other supported MIDI must preserve channel and order. Define behavior for late events, queue overflow, suspend/resume, panic, duplicate notes, track deletion, switching firmware and transport stop. All-notes-off/panic and cleanup cannot leave hanging sound or running sources. Load and boot asynchronously before playback, surface failures, and never fall back silently to another instrument.

The live and timeline paths acquire the same track session. Audition gets a temporary isolated session and cannot modify track flash. UI renders device screen and interactive panel, including accessible names and keyboard operation; close dialog without stopping the device. Limit display updates and show boot, missing package, failure, overload and save status. Record panel actions only if explicitly supported; MIDI recording alone cannot reconstruct manual knob/button performances or internal sequencer state.

## DAW tracking and recording

**MIDI tracks:** route Synth keyboard/pads and existing MIDI controller into armed track session; record existing MIDI note clips with source timing. Playback uses timestamped events against the same track session and routes stereo device output to its mixer channel. Verify note velocities, overlaps, releases, channel selection and live input while transport runs. Existing clip schema is note-based: do not promise recording arbitrary CC, program changes, panel moves or firmware clock until their own representation exists. Playback must visibly report unsupported/missing device instead of silently skipping.

**Audio capture:** add a user-invoked “Record FM-1 to audio track” command reachable from existing menus. Select one source track and start at the arrangement playhead; tap its stereo device output before mixer fader/effects so the new clip does not double-apply source processing. Monitor through the original track, write the take into the existing project audio store, then add a new audio track/clip as one undoable project operation. Mute the source track when the take is committed only if the UI clearly offers that option; default leave it unchanged. Duration, start beat, tail, tempo and sample rate must be explicit. Compensate measured pipeline latency once when placing audio; test impulse alignment against a reference track. Stop/cancel, clipping indication, device underrun and save errors must be surfaced. Failed or canceled recordings must not leave a partial clip or destroy a previous take. If project storage cannot commit, retain/recover the recording instead of discarding it.

MIDI capture represents events; audio capture records the actual resulting performance including internal sequencers and manual panel movements. No implicit promise that a firmware's sequencer follows DAW tempo or that its pattern can be converted to MIDI. Provide usable manual/free-running capture before claiming clock synchronization.

## Timing, seek, and transport

Treat project tempo and AudioContext time as DAW authority. Emulator maintains its own sample counter and runs continuously while active. Timestamp MIDI relative to the playback anchor, not arrival time. Measure scheduling lookahead and buffering; expose latency/overload and prevent unbounded growth. Ensure the live and scheduled routes do not duplicate events. Existing `setTimeout` per note is insufficient as a guarantee of sample accuracy; deliver ahead of time into the emulator queue.

Firmware transport behavior is variable. Default **free run**: no automatic MIDI clock, start, stop or position commands. Later support opt-in MIDI clock/start/continue/stop only for verified firmware, at 24 pulses per quarter note using the same timed queue; expose capability and channel separately from device tempo. No claim of generic MIDI song-position or reset support. Stop sends note-offs/panic but does not unexpectedly erase device state or stop an independent firmware sequencer. Define and test loop/seek behavior: for MIDI-controlled sounds seek releases active notes and schedules upcoming notes; firmware internal sequence and transient state do not automatically seek. For reproducible results users capture audio, or use explicitly implemented replay from a known snapshot with documented cost. No false sample-accurate seek guarantee.

## Persistence, assets and failure recovery

Flash changes made through firmware save commands are persisted per project **and track instance**, not globally per firmware. Track state begins from a known initial flash snapshot; loading identical firmware on two tracks must not share writes. Unsaved firmware RAM is not equivalent to flash; tell users to save within the firmware before project save/capture. Persist snapshots atomically with checksums, bounded size, versioned format and last-known-good recovery; serialize writes and flush before project save/close when possible. Never treat partially written snapshots as committed. Document crash loss window. Copying a track clones its saved state, not a live reference. Undo and removing a track cannot delete data still needed by another project or undo history.

Project descriptor references exact firmware hash and flash asset; firmware library and project flash have distinct lifecycles. On open, preload and validate both before device boot. Missing firmware shows hash/name and relink/import action; hash mismatch cannot silently substitute a different version. Missing/corrupt flash reports error and preserves original bytes; reset is explicit and recoverable. Projects remain editable and existing audio clips playable if the emulator or asset is unavailable.

Portable project export must carry the project-owned flash and captured audio using the existing project adapter's asset strategy; include firmware bytes only when redistribution/sharing rights permit and the user opts in. Otherwise carry hash and provenance, and support relinking a locally imported matching binary. Specify and test both Electron and browser adapters, quotas, save-as, project move and interrupted writes before claiming portability. Do not store large binary firmware or flash as base64 inside project JSON.

## Offline bounce

Before `OfflineAudioContext` rendering, deterministically render each FM-1 track to PCM from a **cloned initial snapshot**, ordered timestamped MIDI events and explicit capture range; insert the resulting buffer into the corresponding track's existing bounce/mix path at the correct offset. Never mutate the live session or committed flash during bounce. Handle resampling between device output and project sample rate and align latency exactly once. Define duration, startup preroll and tail. Running from a later playhead requires replay from the known initial state or use a saved captured audio clip; do not seek by discarding firmware history.

Internal sequencer and panel gestures are reproducible only when their initial state and all relevant events are saved; otherwise offer realtime audio capture and explain the limitation. Bounce must fail with actionable track/asset details if firmware, initial state or renderer is unavailable, and never silently omit the track. Establish whether emulator stepping and randomness are deterministic across the pinned core before promising bit-identical exports. Integrate with current bounce, including its existing mixer/effect limitations; do not claim this feature fixes unrelated mixer behavior.

## Phase 0 results (2026-11-27)

Spike: `spikes/fm1/` on branch `mzakhar/fm1-spike` (README has rebuild and run commands; raw tables in
`spikes/fm1/results/`). Reference machine: Ryzen 7 2700X (8 cores), Windows 11, Electron 33.4.11 (Chromium 130),
node 20+. Real Chrome was not driven; Electron served as the Chromium host for localhost, LAN http and file://.

**Source and licence.** fm1-emu pinned at `69cb1ef46d86a2776112cc9279773ded3ffa293b` (MIT root and all crates). The
browser crate `fm1-web` depends only on `fm1-core` and `fm1-soc`; the GPL-mixed `fm1-sid` submodule is not in the wasm
build. Built with rustc 1.100.1, plain `cargo build -p fm1-web --target wasm32-unknown-unknown` (no wasm-bindgen):
3,542,489 B, sha256 `77bd2e2a…fd7f59`. Upstream ships no pinned prebuilt. Felucca, SLOOP and FM1-Dock are GPL-3.0 and
stock V15 provenance is unreviewed: user import only, nothing bundled.

**Runtime API.** Raw `extern "C"` exports. `fm1_render(frames ≤ 1024)` is a synchronous pull of 44.1 kHz stereo f32,
so a plain Worker can host it (no AudioWorklet, SharedArrayBuffer or COOP/COEP needed). One machine per wasm instance.
MIDI is `fm1_midi(byte)` with no timestamp: timing is the render-chunk boundary it is injected at. LCD 240×240 RGB565.
Flash 1 MiB, saved as 4 KiB sectors, restorable only before the first render; no RAM snapshot.

**Thresholds** (declared before measuring): RTF ≥ 1.5 pass, 1.0–1.5 marginal, < 1.0 fail; 0 underruns / 60 s;
note-to-audio ≤ 30 ms; boot < 3 s.

| Firmware | Interp RTF @240 (node) | JIT RTF @240 / @120 (browser free-run) | Boot to LCD | Determinism |
|---|---|---|---|---|
| Felucca 1.8.4 | 0.22 | 0.93 / 1.62 | 0.3 s | bit-exact |
| SLOOP 2.8.5 | 0.22 | 0.89 / 1.60 | 0.3 s | bit-exact |
| FM1-Dock 1.0.1 | 0.14 | 1.52 / 2.83 | 0.5 s | bit-exact |
| Stock V15 | 0.35 | 0.54 / 0.70 | 0.8–1.0 s | bit-exact |

Live hosts, 60 s (Path A) / 30 s (Path B):

| | Path A: Worker → AudioBufferSource queue | Path B: AudioWorklet |
|---|---|---|
| Works on | Electron, HTTPS, **LAN http** | Electron, HTTPS (secure context only) |
| Note-to-audio | lead + ~45 ms: 90–105 ms at lead 50, 115–128 at 80 | 10–20 ms at 120 MHz |
| Underruns @120 MHz, lead 80 | Felucca 3, SLOOP 7, Dock 0, V15 1591 | 0.7–1 % blocks over budget (V15 worse), 1–3 stalls / 30 s |
| Underruns @240 MHz | Felucca 54, SLOOP 967, Dock 0, V15 2531 | 15–58 % over budget except Dock |

Other findings: interpreter mode does not escape the CSP (the core wasm itself needs compile permission on the main
thread and in a worklet). A meta CSP does not govern a same-origin Worker, so Path A compiles and JITs under today's
CSP; any CSP response header would change that. Electron `loadFile` (file://) is a secure context with
`audioWorklet` present and no autoplay gesture. LAN http: `isSecureContext` false, no `audioWorklet`, Path A works. Two
Workers in the browser run independently (Felucca @240: 1.05 / 1.03); node's lower multi-instance numbers were a
worker_threads artifact. Offline bounce by reboot and replay: Felucca 4 bars + tail, 9 s of audio in 7.2 s, sha256
identical across three renders including a separate process.

### Decisions proposed (owner sign-off needed where marked)

1. **CSP — DECIDE.** Add `'wasm-unsafe-eval'` to `script-src` in `src/renderer/index.html`. It permits compiling
   wasm bytes (the shipped core and JIT blocks), not `eval` of JS. Path A works without it today only because meta CSP
   skips Workers; relying on that gap is fragile. No `unsafe-eval`, no `connect-src` change.
2. **JIT is mandatory.** The interpreter is 4–7× too slow at 240 MHz on the reference machine.
3. **Emulated clock defaults to 120 MHz**, per-track setting up to 240, shown in device settings with the measured RTF.
   This changes the emulated CPU speed, not playback speed: firmware audio timing is unaffected as long as the
   firmware keeps up, which is what the RTF columns measure. Overload is reported, never hidden.
4. **Secure contexts (Electron, HTTPS) use Path B** for live play (10–20 ms). **LAN http uses Path A**: sequenced
   playback is sent ahead by the lead and compensated, so it is on time; live keyboard/pad play has ~100 ms latency
   and the device dialog says so. This meets "ship if usable, else label it" without hiding the cost.
5. **Bounce = fresh boot + flash restore + replay from t = 0** in a Worker, chunked identically to the live
   scheduler's frame stamps. Bit-exact; costs ~1/RTF of the project length, slower firmware just bounces slower.
6. **Stock V15 is "unsupported live" on this class of CPU** (0.70 RTF at 120 MHz). Offline bounce and capture of
   other firmware are unaffected.

### Open gaps carried into phase 1–2

Real Chrome and Edge (autoplay gesture, worklet stalls); nginx `application/wasm` MIME on the deployed image and any
Traefik / Cloudflare-added headers; Path B underrun signal (its stats are proxies); 4 instances and 100 MHz in the
browser; a sample-oriented firmware; FM1 Open (no `.fwsc` published).

## Implementation phases and checks

### 0 — Feasibility

Audit upstream license, runtime API, package/flash formats, event timing, panel, sample import, WASM/JIT, worker/worklet requirements and build outputs. Pin immutable commit. Verify CSP, deployment paths and capability matrix. Build a disposable spike in a branch with no dependency on firmware distribution; run the performance matrix above. Decide secure-context behavior and offline stepping based on evidence. Deliver decision, numbers, known blockers and reproducible commands before production work.

### 1 — Library

Implement catalog import and validated local package install, immutable hashing, persistent Electron/browser storage, list/search/status and user import. Tests: malformed packages and catalogs, duplicate/version collision, interrupted install, quota error, library growth after startup, missing/reimport by hash, and no network requests. Manually verify both environments and licensing metadata.

Phase 1 notes (built 2026-11-27): `fm1/sha256.js` (pure; same code on LAN and HTTPS, 8 MiB in ~150 ms in node), `fm1/fwsc.js` (bounded validator ported from fm1-emu `web/fwsc.js`, MIT; accepts identity prefix `FM-1`, rejects `SMK-37*` as unsupported; 960 B..8 MiB; fuzzed), `fm1/catalog.js` (`synth-fm1-catalog@1`: parse, reconcile by `catalogId` with ISO-date `version`, rows, search; a malformed entry is skipped and counted, structural errors reject the file), `fm1/firmware-store.js` (IndexedDB `synth-fm1-firmware` in Electron and browser; package bytes and index record in one transaction; identity `sha256:<hex>`; duplicate import is a no-op), `components/fm1-library-dialog.js` (command `FM-1 firmware…`; search, status chips, Import firmware / Import catalog, two-step Remove). The seed catalog `fm1/seed-catalog.json` is generated by `scripts/build-fm1-catalog.mjs` from fm1-emu `web/firmwares.json` and 2bbb/fm1-firmware-collection (both MIT, notices in `fm1/CATALOG-NOTICE.md`): 205 entries, the four phase-0 packages marked tested, 199 upstream-ok, 2 broken; metadata and links only, no binaries; it ships inside the bundle so it needs no fetch. The CSP gains `'wasm-unsafe-eval'` (approved 2026-11-27). Known limits: Remove does not yet check project references (phase 4 adds them); hashing runs on the main thread; re-importing an equal-version catalog can re-add entries that a newer one tombstoned.

### 2 — Live device

Integrate pinned emulator and panel, bounded session lifecycle and audio routing. Extend instrument picker, live instrument and audition; share track session with scheduled path. Tests: isolation, note/channel/velocity, ordering, reconnect/dispose, panel close, errors and multiple tracks. Verify accessibility, CPU/latency, secure context and absence of regression to normal audio on HTTP.

Phase 2 notes (built 2026-11-27): the pinned wasm ships as `public/fm1/fm1_web.wasm` (sha256 pinned in `fm1/wasm-pin.js` and checked by a test; rebuild with `scripts/build-fm1-wasm.sh`; MIT notice in `public/fm1/NOTICE`). The main thread fetches it relative to `document.baseURI`, compiles once, and hands bytes to the host. Descriptor on `track.instrument`: `{ type:'fm1', firmwareHash, deviceChannel, mhz }` (no schema bump; `deviceChannel` is the firmware's channel, distinct from Synth's routing `track.midiChannel`). `fm1/session-manager.js` owns one session per track key (live play, timeline, step sequencer and the device dialog share it; audition uses isolated `audition:<n>` keys). Hosts: `public/worklets/fm1-worklet.js` (self-contained AudioWorklet, resamples 44.1 kHz to the context rate, boots at real-time speed so it never hogs the audio thread) is built and tested but **not used** since 2026-11-28 (see below), and `workers/fm1-worker.js` (module Worker resampling to the context rate, 1024-frame blocks scheduled sample-exact, lead ~0.13 s). Pure timing, queue, key-hold (100 ms emulated), resampler and boot rules live in `fm1/host-core.js`; the worklet carries inline copies. A session is **ready** at the first LCD redraw at least 100 ms after firmware audio starts (or 8 s, flagged), because firmware drops MIDI and panel input until its UI is up; stock V15 still needs ~0.8 s more for its boot animation. Panic never disposes; sessions are disposed on track deletion, descriptor change, project new/open, audition end and `pagehide`. Timeline and sequencer send FM-1 notes `leadSec` ahead with exact times; bounce refuses FM-1 tracks with a message (phase 5). UI: FM-1 rows in the instrument browser (audition on click only), FM-1 source in instrument settings (firmware, device channel, clock 60–240 MHz with catalog `minMhz` warning), and the non-modal `FM-1 device…` dialog (LCD, 49 keyboard-operable panel controls, status, path and latency note; closing keeps the device running). Flash saves are not kept yet (phase 4). Verified with real firmware in node (Felucca, SLOOP, Dock ready and sounding) and in Electron on file://, http://127.0.0.1 (worklet) and LAN http (worker).

### 3 — Tracks and capture

Connect arrangement scheduling and existing MIDI recorder, then implement per-track audio capture and asset/clip commit. Tests: live plus scheduled note deduplication, repeat/overlap and stop, timing with reference click, recording from nonzero beat, no master/double-processed audio, cancellation, save failure, undo and reload. Manual scenario: perform an internal firmware sequence and place it on an audio track.

Phase 3 notes (built 2026-11-28): **Record FM-1 to audio track…** (command `fm1-record`) opens a dialog: source FM-1 track, start beat, length in bars (project time signature; blank = until Stop), tail seconds, optional mute of the source. Capture happens at the emulator source (`session.startCapture`): the Worker path takes each block at its audible time, the worklet streams batched copies of its output; both are already at the context rate and pre-fader, and a real-firmware test shows the take matches the audible output sample for sample (latency compensation 0; the firmware's own ~10 ms note-to-sound delay is the instrument's). `TimelinePlayer.play()` returns the audible start time, takes `endBeat` and `fm1Lookahead` (recordings send FM-1 notes 1.5 s ahead so throttled timers cannot delay them) and `stop({ panic:false })` lets the tail ring. The take is encoded as 16-bit stereo WAV, written to `recordings/` and loaded before ONE undoable batch adds the audio track and clip (plus the optional mute); any failure, or a project without a folder (LAN), keeps the take pending with Retry and Save as WAV. Project New/Open, a deleted or changed source track, or a failed device cancel the recording with a message. Max take 10 min. Live and timeline notes on one device are counted per source inside the host at the frame they apply, so a note sounds until every source has released it. MIDI clips recorded with the existing MIDI-device recorder play back on FM-1 tracks (tested); recording the computer keyboard or pads into clips is not part of this phase. Fixed on the way (superseded 2026-11-28: every device now runs on a Worker, because one Felucca at 120 MHz uses 75–100 % of the audio thread and Chrome then stops delivering messages to the worklet — MIDI and LCD-on never arrive, so the device looks ready but is silent; live play costs the Worker lead, ~80–130 ms, everywhere; re-enable the worklet only with RTF headroom ≥ 2 or a lower catch-up budget): only **one** FM-1 device runs on the AudioWorklet (a second one overloaded the shared audio thread and both went silent while showing ready), further devices use Workers; `newId` no longer needs `crypto.randomUUID` (absent on LAN http). Verified in Electron (file:// worklet, LAN http worker).

### 4 — Persistence

Version/migrate ProjectStore, add project flash assets and portable handling, restore on reopen. Tests: two independent instances, copy/undo, flash updates, interrupted writes, missing/incorrect package, corrupted snapshot, save-as, portable export/relink, and old project migration. Test application restart in Electron and browser.

Phase 4 notes (built 2026-11-28): device flash is kept per track instance as the changed 4 KiB sectors against `fm1_flash_base()` (a real Felucca patch save is 1 sector, 4172 B on disk). Codec `fm1/flash-asset.js`: magic `SFM1`, version 1, firmware sha256, ≤ 256 records, trailing sha256; decode checks all of it and the firmware hash. On project save `snapshotAll()` asks each ready track device for its sectors (worker answers when the firmware is not busy and quiet 250 ms; 1.5 s timeout keeps the previous state with a toast); each changed track writes a NEW immutable `<project>/fm1/<id>.flash`, then `project.json` is written last as the commit point, then sessions are marked saved. `track.instrument.flashAssetId` is optional (no schema bump) and never part of device identity, so saving never reboots a device; a write failure of `project.json` rolls the store back. Open restores the sectors before the first render; a missing, damaged or wrong-firmware file fails visibly with that reason and the device dialog offers **Start from firmware defaults** (undoable; undo/redo re-boot the device into the restored state). Export / Import device state… use the same format as a `.fm1flash` file (import boots on a second worker and swaps only when ready; refused during an FM-1 recording); this is the path for LAN http and unsaved projects, where there is no project folder. Electron IPC (`src/main/fm1-flash-files.js`) only touches `<project>/fm1/*.flash` inside folders the main process's own open dialog returned (allow-list also applied to `saveRecording`; `readProject`/`writeProject`/audio import still accept any folder — noted), rejects Windows reserved names, symlinks and non-regular files, caps 2 MiB. Old asset files are never deleted. No duplicate-track command exists, so track copy is out of scope. Verified in Electron: save without reboot, restore after a fresh launch, missing/damaged messages, reset + undo/redo, export/import incl. wrong-firmware refusal, two tracks restoring independent states, non-FM-1 projects unchanged.

### 5 — Bounce and transport

Implement offline emulator stepping and PCM integration; add optional clock only after compatibility tests. Tests: deterministic repeated note renders where supported, correct event ordering and alignment at multiple sample rates, no live-state mutation, seek/preroll, missing assets fail loudly, heavy firmware limits, plus explicit unsynchronized behavior. Compare offline output with a captured realtime reference under controlled state.

### 6 — Release

Run unit/integration tests, `npm test`, `npm run build`, Electron, HTTPS and LAN smoke tests; document limitations and hardware-specific firmware results. Audit licenses/notices and source offers. Update user guide, catalog provenance and phase table. Release only after project data recovery and audio capture are demonstrated.

## Non-goals and unresolved decisions

No physical FM-1 flashing, BLE/USB peripheral emulation promise, external catalog fetching, universal firmware support, automatic sample-to-MIDI extraction, full panel automation or universal tempo sync. Future work may add these after independent decisions.

Open gates: proven WASM/JIT CSP policy; viable insecure-HTTP audio fallback; source and licensing of bundled packages; snapshot/flash format and asset location; offline stepping and deterministic event ordering; capture API and practical latency; supported firmware clock protocol. Phase 0 supplies evidence, not assumed answers.
