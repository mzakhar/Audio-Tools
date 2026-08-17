# MIDI Bridge — external sequencer integration

Make the app a real MIDI citizen so an external node/step sequencer (Midinous, hardware, any DAW via a loopback port) can drive it: per-channel routing to different instruments, CC/bend into racks, live playing of rack instruments, optional clock sync, optional MIDI out.

Motivating case: [Midinous](https://midinous.com) creates two virtual ports at startup — **Midinous Port** (16 channels of note + CC) and **Midinous Clock Port** (clock + start/stop). Everything valuable about it is per-channel and CC-shaped, which is exactly what this app currently throws away.

---

## Status

| Phase | State | Commit |
|---|---|---|
| 1 — Pure message parser | done | `3665564` |
| 2 — Channel routing + live instruments | done | `c9ddf05` |
| 3 — CC + pitch bend into racks | done | `76214f1` |
| 4 — Clock in (optional) | not started | |
| 5 — MIDI out (optional) | not started | |

Phases 1–3 are the bridge. Phases 4–5 are opt-in; do not build them speculatively — build 4 when transport drift actually bites, build 5 when there is real gear or software on the other end.

---

## Ground rules

- Parsing, routing and clock estimation are **pure functions in their own modules with unit tests**. `MidiController` stays the imperative shell that owns the Web MIDI handles and dispatches DOM events. Same functional-core split the rack already uses.
- No new dependency. Web MIDI + existing `RackEngine` cover all of this.
- `npm test` green before each commit. Conventional commits (`feat:`, `fix:`, `refactor:`).
- Each phase ends committable and does not break the existing MIDI record path.

### Deployment constraint (read before testing)

Web MIDI is `[SecureContext]`. `navigator.requestMIDIAccess` is **undefined** on `http://themachine/synth/`, so this whole feature is dead on the LAN route by design — same class of limitation as the AudioWorklet recorder. Test on:

| Target | Web MIDI |
|---|---|
| Electron (`npm run dev`, and packaged `file://`) | works — both secure contexts, `src/main/index.js` registers no `setPermissionRequestHandler` so Electron default-grants |
| `https://synth.zakharhome.org` | works in Chrome/Edge; Firefox prompts; Safari has no Web MIDI |
| `http://themachine/synth/` | never — leave the existing "not supported" message |

Nothing in phases 1–5 may end up on the critical path of core audio.

---

## Current state — where the gaps are

| Fact | Where |
|---|---|
| Channel nibble discarded — `status & 0xf0` only | `src/renderer/js/midi/MidiController.js:107` |
| Only `0x80`/`0x90` handled. No CC, bend, clock | `MidiController.js:112-136` |
| Live MIDI goes straight to `currentPalette.createVoice`, one mono-timbral destination, racks unreachable | `src/renderer/js/app.js:829-847` |
| Rack instruments only playable from the timeline | `src/renderer/js/playback/timeline-player.js:21-36` (`rackInstrument`, `instrumentFor`) |
| `midi-in` module already exposes `mod` and `pb` outputs and already accepts `{type:'mod'}` / `{type:'pitch-bend'}` events — nothing ever sends them | `src/renderer/js/rack/modules/midi-in.js:34-35`, `:90-93` |
| No MIDI out anywhere — `access.outputs` untouched | — |
| Project schema is at **version 4**, `migrate()` at `store/ProjectStore.js:38` (note: CLAUDE.md still says version 2 — it is stale) | `store/ProjectStore.js:18,38-70` |
| MIDI toolbar markup: enable button, status, device select, rec button | `src/renderer/index.html:55-60` |
| Existing tests to extend, not replace | `tests/midi-controller.test.js`, `tests/rack-midi.test.js`, `tests/store-midi.test.js` |

Web MIDI always delivers complete messages, so **running status does not need handling**.

---

## Phase 1 — Pure message parser

**New:** `src/renderer/js/midi/midi-message.js`

```js
export function parseMidiMessage(bytes) // Uint8Array|number[] -> event | null
```

Returns exactly one of, or `null` for anything unhandled (sysex, aftertouch, program change):

| Return | From |
|---|---|
| `{ kind:'note-on', channel, pitch, velocity }` | `0x90`, velocity > 0. `velocity` stays 0–127 raw |
| `{ kind:'note-off', channel, pitch }` | `0x80`, **or** `0x90` with velocity 0 |
| `{ kind:'cc', channel, controller, value }` | `0xB0`, `value` 0–127 raw |
| `{ kind:'pitch-bend', channel, value }` | `0xE0`, 14-bit `(msb<<7)\|lsb` normalised to **-1..1**, centre 8192 → exactly `0` |
| `{ kind:'clock' }` / `'start'` / `'stop'` / `'continue'` | `0xF8` / `0xFA` / `0xFC` / `0xFB` |

`channel` is `status & 0x0f`, **0-indexed** (Midinous channel 1 = `channel: 0`). Document that once at the top of the file and never re-index anywhere else.

**Change:** `MidiController.js:105` `_onMidiMessage` delegates to `parseMidiMessage` and dispatches a single `midi-event` CustomEvent carrying the parsed object plus `time: e.timeStamp`. Keep dispatching the existing `midi-note-on` / `midi-note-off` events unchanged so nothing downstream breaks in this phase; recording (`MidiController.js:66-97`) keeps working off the parsed note events and stays channel-agnostic.

**Test:** `tests/midi-message.test.js` — one `describe` per kind. Must cover: note-on with velocity 0 is a note-off; bend centre is 0 and extremes are ±1; unknown status returns `null`; channel nibble survives on all channel messages.

---

## Phase 2 — Channel routing + live instruments

The payload phase. Sixteen Midinous channels must be able to hit sixteen different instruments, and rack instruments must be playable live.

### 2a. Routing (pure)

**New:** `src/renderer/js/midi/midi-routing.js`

```js
export function routeChannel(tracks, channel, armedTrackId) // -> trackId[]
```

Rules, in order:

1. Tracks with `track.midiChannel === channel` win. Return **all** of them — layering two instruments on one channel is free and someone will want it.
2. If no track anywhere declares a `midiChannel`, fall back to `[armedTrackId]` (omni behaviour — preserves today's "plug in a keyboard and it just plays").
3. Otherwise return `[]`. Silence is correct: the user has declared a routing map and this channel is not in it.

`track.midiChannel` is a new **optional** field, `0`–`15` or absent. Absent is the default, so **no schema bump and no `migrate()` step** — read it as `track.midiChannel ?? null`.

**Test:** `tests/midi-routing.test.js` — each of the three rules, plus two tracks on one channel returning both.

### 2b. Live instruments (shell)

**New:** `src/renderer/js/midi/live-instrument.js`

```js
export function liveInstrumentFor(track, { palettes, ctx, output, racks, mountRack })
// -> { noteOn(pitch, velocity), noteOff(pitch), send(event), dispose() } | null
```

- **Palette track** — `palette.createVoice(ctx, output, freq, velocity/127, ctx.currentTime)`, keep a `pitch → voice` map, `noteOff` calls `voice.stop(ctx.currentTime)`. Same maths as `app.js:833-838`; move it here rather than duplicating it.
- **Rack track** — mount the rack, find the `midi-in` module the way `timeline-player.js:33` does:
  `[...handle.mods].find(([, entry]) => entry.def?.type === 'midi-in')?.[0]`
  then `RackEngine.sendEvent(handle, moduleId, 'note', { type:'note-on', note: pitch, velocity, time: ctx.currentTime })` and the matching `note-off`. Note the argument name is `note`, not `pitch` — `midi-in.js:66` reads `event.note ?? event.pitch`.
- `send(event)` forwards `{type:'mod'|'pitch-bend'}` straight through to the same module (phase 3 uses it; wire the pass-through now, it is two lines).
- Copy the mount options from `timeline-player.js:64-71` (`output`, `getBuffer`, `onParam`).

**Live mounts are separate from `TimelinePlayer._instrumentRackHandles`.** During playback the same rack ends up mounted twice — timeline notes on one, live notes on the other. Audio is correct, CPU is doubled. Mark it:

```js
// ponytail: live rack mount is independent of TimelinePlayer's, so a rack
// played live during transport is mounted twice. Share handles if CPU bites.
```

Lifecycle: mount lazily on first note for that track, dispose when the track's `instrument` changes or the track is removed.

### 2c. Wiring

Replace the `midi-note-on` / `midi-note-off` listeners at `app.js:829-847` with one `midi-event` listener that calls `routeChannel(...)` and dispatches to each returned track's live instrument. Armed track is already tracked as `_midiTargetTrackId` (`app.js:768`, kept in sync by the `track-selected` handler at `app.js:856`).

UI: a channel selector per MIDI track — smallest thing that works is a `<select>` (Omni + 1–16) in the track header next to the existing instrument control. Writing it dispatches a `SetTrackMidiChannel(trackId, channel)` command in `ProjectStore` alongside the other track commands near `store/ProjectStore.js:74`.

**Test:** extend `tests/store-midi.test.js` for the new command; the live-instrument shell needs no test beyond the routing and parser units — the pure parts carry the logic.

---

## Phase 3 — CC + pitch bend into racks

Small once phase 2 lands: in the `midi-event` handler, map `kind:'cc'` with `controller === 1` (mod wheel) to `send({ type:'mod', value: value/127 })` and `kind:'pitch-bend'` to `send({ type:'pitch-bend', value })`. `midi-in.js:91-92` already consumes both, and `pb` is already scaled by the module's `bendRange` param — do not scale it twice at the call site.

Other CC numbers: ignore for now. Generic `CC → rack param` mapping is a bigger feature and belongs with a learn-mode UI.

```js
// ponytail: only CC1 mapped. Add a CC-learn map when a second controller matters.
```

**Test:** extend `tests/rack-midi.test.js` — assert a `mod` event moves the `mod` ConstantSource offset and that bend of `1` lands at `bendRange/24`.

---

## Phase 4 — Clock in (optional, build only if drift bites)

**New pure module:** `src/renderer/js/midi/midi-clock.js`

```js
export function estimateBpm(tickTimes)  // last N clock timestamps (ms) -> bpm | null
```

24 pulses per quarter note: `bpm = 60000 / (meanInterval * 24)`. Use a rolling window (8–24 ticks), return `null` until the window is full, and median-filter the intervals — one jittery tick must not yank the tempo.

Shell: `start`/`continue` starts `TimelinePlayer` from the current beat, `stop` stops it, `clock` feeds `estimateBpm` and updates BPM when the estimate moves more than ~0.5 BPM. External sync must be **opt-in via a toggle**, defaulting off — an app that silently follows a foreign clock is a support ticket.

**Test:** `tests/midi-clock.test.js` — steady 120 BPM tick stream returns 120±0.1; one outlier tick does not move the estimate.

---

## Phase 5 — MIDI out (optional)

`MidiController` gains `getOutputs()`, `selectOutput(id)`, and `send(bytes, timestamp)` mirroring the input side (`MidiController.js:43-62`). A track's `instrument` gains `{ type: 'midi-out', portId, channel }`, handled in `instrumentFor` (`timeline-player.js:28`) so timeline playback emits note-on/off to hardware. Use the `timestamp` argument of `MIDIOutput.send` for scheduling — do **not** `setTimeout` note-offs.

Do not build this until something is actually listening on the other end.

---

## Verify

```sh
npm test          # unit suite, all phases
npm run dev       # Electron — the only local secure context
```

Manual acceptance (phase 2 done):

1. Start Midinous. Confirm **Midinous Port** appears in the app's device select.
2. Two MIDI tracks: one palette on channel 1, one rack instrument on channel 2.
3. Points in Midinous on channels 1 and 2 play the two different instruments simultaneously.
4. Mod wheel CC1 from Midinous moves the rack's `MOD` output (phase 3).

Windows note: Midinous claims it auto-creates its ports; Windows has no native virtual MIDI, so it must ship its own driver. If the ports do not appear, install [loopMIDI](https://www.tobias-erichsen.de/software/loopmidi.html) and point Midinous at a loopback port. Verify with the itch.io demo before buying.

---

## Explicitly out of scope

| Item | Why | Revisit when |
|---|---|---|
| Node/path grid sequencer inside the app (Midinous clone) | Weeks of canvas UI. Buy the $25 tool first | The bridge proves the workflow sticks — then the cheap 20% is a `NOUS` rack module emitting into the existing event domain, reusing `RackEngine.sendEvent`, clock and poly |
| MPE | No hardware, no demand | Ever asked for |
| Sysex | `requestMIDIAccess({ sysex: false })` stays | Never, ideally |
| Generic CC-learn mapping to rack params | Needs a learn-mode UI to be usable | A second controller shows up |
| MIDI on the LAN route | Not a secure context. Not fixable in app code | Never |

---

## Suggested agent split for a fresh session

| Step | Agent | Scope |
|---|---|---|
| Phase 1 | `cavecrew-builder` | 2 files (`midi-message.js`, `MidiController.js`) + 1 test file |
| Phase 2 | `cavecrew-implementer` | Multi-file: routing, live-instrument, `app.js` wiring, store command, track-header UI. Brief must carry the `file:line` table above |
| Phase 3 | `cavecrew-builder` | 1 file + test extension |
| Review | `cavecrew-reviewer` | Diff per phase, before commit |

Main thread orchestrates and commits. Do not let an agent read `app.js` whole — point it at line ranges.
