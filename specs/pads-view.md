# Pads view — MPC-style pad performance and lessons

Status: plan, not built. Owner decision needed only where marked **DECIDE**.

Research behind this plan (sources, confidence tags) lives in the vault project
`20 Projects/Synth Pads View/` — hardware, MPC workflow/teaching, and the
2026-11-26 drum-path audit. This file holds the decisions.

## Problem

A 16-pad controller (M-Vave SMC-PAD, USB-C, 16 RGB pads, 8 endless encoders,
~10 buttons) is attached, and drumming on it is unsatisfying. The audit found
why, in order of how much each one hurts:

| # | Cause | Where |
|---|---|---|
| 1 | 16 pads collapse onto 4 synth voices. Six tom notes all play the kick, crashes play the clap. Notes outside GM 35–59 are silent, and nothing tells you. | `instruments/pad-map.js:46`, `midi/live-instrument.js:135` |
| 2 | Velocity scales gain only, so soft and hard hits are the same sound at two volumes. Worse: the SMC-PAD only sends 69–109, which `velocityGain` maps to gain 0.78–0.94, so the whole dynamic range is about 1.6 dB. | `palettes.js` drum voices, `utils/velocity.js` |
| 3 | No choke: open-hat tails stack under closed hats. Drum `stop()` is a no-op. | `palettes.js:256` |
| 4 | The good drums (909 kit, 11 voices, hat choke) are not MIDI-playable at all. | `components/tr909-view.js:420` |
| 5 | Hot path does a `ProjectStore.getState()` deep clone plus `JSON.stringify` per hit, against 6 ms of scheduling slack. First hits also pay lazy builds (rack mount, pack decode). | `app.js:1419`, `utils/midi-clock.js:4` |
| 6 | No pads-to-pattern workflow: MIDI record is wall-clock from beat 0, no metronome, count-in, loop, overdub, quantize or swing. The 909 has its own clock and no input. | `midi/MidiController.js:68`, `app.js:~1306` |
| 7 | Aftertouch parsed then dropped; no monitor, learn, remap or LED output; one input port only. | `app.js:~1394`, `MidiController.js:56` |

Fixing 1–5 needs no new view. Fixing 6–7, and making the hardware feel like
an instrument, does.

## Goals

1. Hitting a pad is immediate, loud/soft feels like loud/soft, and every pad
   is a different sound.
2. A loop-based workflow where the music never stops: play, record, overdub,
   wipe, undo, swing, repeat, all from the hardware.
3. The screen mirrors the hardware: every physical control has an on-screen
   twin that lights when touched.
4. A lessons mode that teaches the workflow on the user's own hardware, with
   timing feedback, and doubles as onboarding.

Non-goals: Akai branding, art, screen layouts or terms (original names below);
microphone sampling (AGENTS.md: `audio-in` never requests the mic); song mode
(the arrange view already is one).

## Vocabulary (original names)

| Here | MPC-world concept | Behavior |
|---|---|---|
| **Kit** | program | 64 pad slots (banks A–D × 16), each a sound plus tune/decay/level/pan/choke group |
| **Loop** | sequence | 1–8 bars on the project clock; recordings land here |
| **Layer** | overdub | record pass that adds to the loop without stopping |
| **Wipe** | erase | hold Wipe + pad: removes that pad's hits as the playhead passes |
| **Repeat** | note repeat | hold Repeat + pad: retriggers at the chosen rate, swung |
| **Groove** | swing | 50–75 %, MPC-style math, one knob |
| **Snap** | time correct | quantize grid 1/8 … 1/32T with strength 0–100 % |
| **Full** | full level | every hit at velocity 127 |
| **Ladder** | 16 levels | last-hit pad spread across all 16 pads by velocity, tune, decay or filter |
| **Overlay** | shift/pad modes | hold a function button: the 16 pads become a temporary menu |

## Decisions taken

| Question | Decision | Why |
|---|---|---|
| New view or mode of an existing one | New view `pads`, tool button + **F5**, beside synth/arrange/rack/tr909 | 909 precedent (`specs/instrument-browser.md:259`); `switchMode` is `app.js:932` |
| Where recordings live | A MIDI clip on the armed track, notes at the kit's pad pitches | One selection concept and one instrument factory (AGENTS.md); arrange view plays it with no new code path; scenario 6 wants project-clock lock |
| What plays the pads | New instrument type `{ type: 'kit', kitId }` in `live-instrument.js` | Same factory serves audition, live and timeline. Kit slots point at 909 voices, palette drums, or pack/user samples |
| Clock | Project BPM and transport only. The Pads view never owns a transport | Scenario 6 lists the 909's separate clock as a failure |
| Groove math | One pure module shared by Snap, Groove and Repeat; 909 shuffle migrates to it later | Three features, one grid |
| Swing formula | Second 16th of each pair lands at `swing × eighth`; delay = `(swing − 0.5) × eighth`. Knob snaps to 50/54/58/62/66/70/75 with Shift for fine | Linn's definition; 66 % = triplet feel |
| Velocity | Software curve per device: threshold (ghost-hit floor), curve (linear/soft/hard/compress), Full toggle. Velocity also drives timbre (decay, tone, accent on 909 voices) | Cheap pads have narrow uneven ranges; gain-only velocity is cause 2 |
| Hardware map | Device profile = data (`pads/profiles/*.js`) resolving raw MIDI to semantic actions; MIDI learn writes the same shape | No generic controller abstraction beyond the one device plus learn |
| LED feedback | Yes: note-on/off to the device's first out port (captured). One colour, so the state is coded by blink pattern (see LED vocabulary). It is the first MIDI-out use; it needs nothing from midi-bridge phase 5 beyond `output.send` | Build MIDI out when something on the other end needs it (AGENTS.md) — the pads now do |
| Lessons progress | `localStorage` behind try/catch, never project state | Per-user convenience, not a project fact |
| Lessons scoring windows | After latency calibration: ≤25 ms perfect, ≤50 good, ≤90 ok, else miss. Always show signed early/late bias | Rhythm-game windows (Rock Band 100 ms slop); bias teaches more than a score |
| Schema | Bump `CURRENT_VERSION` 6 → 7, add `state.kits{}`, migration seeds one default kit | `store/ProjectStore.js:16` |

**Decided 2026-11-26 (user):** recordings go to the armed track's MIDI clip,
not a separate pad-pattern store.

## Screen

Only things that change while you play stay on screen (`specs/ui-shell.md:51`).

```
┌─ Pads ──────────────────────────────────────────────────────────────┐
│  LOOP  bar 2/4  ▸▸▸▸▸▸▸▸▸▸▸▸|▸▸▸▸▸▸▸▸▸▸▸▸▸▸▸▸   [● LAYER]  GROOVE 58% │
│  ─ hits drawn per pad row; ghost targets in lessons; playhead ─     │
│                                                                     │
│   ┌────┐┌────┐┌────┐┌────┐      ◯ GROOVE  ◯ RATE   ◯ TUNE  ◯ DECAY  │
│   │ 13 ││ 14 ││ 15 ││ 16 │      ◯ FILTER  ◯ LEVEL  ◯ SNAP  ◯ BPM    │
│   └────┘└────┘└────┘└────┘      (8 twins of the 8 encoders)         │
│   ... 4×4, bank letter, pad flashes at hit velocity, choke tint     │
│                                                                     │
│   OVERLAY: none | REPEAT 1/16 | WIPE | BANK | MUTE      FULL  LADDER│
└─────────────────────────────────────────────────────────────────────┘
```

Dialogs (via `⋯` and shortcuts, `ui/dialog.js`): Kit editor, Pad test
(velocity histogram, threshold, curve), Controller map / learn, Latency
calibration, Lessons picker.

The selected pad (last hit) is what the TUNE/DECAY/FILTER/LEVEL knobs edit —
no separate select step.

## Hardware mapping

### Captured facts (2026-11-26, factory defaults, USB)

Probe: python-rtmidi on all ports, ~3 min of play. USB: vendor string `SINCO`,
VID 4353 / PID 4B4D, bcdDevice 1.00, class-compliant (Microsoft `usbaudio`).

| Control | Message | Notes |
|---|---|---|
| 16 pads | note-on/off **ch 10**, notes **36–51** chromatic | note-off velocity always 64; gate median 20 ms (pad releases fast) |
| Pad velocity | observed **69–109** only, median 85, on the factory curve | The device has 4 curves (SHIFT + Pad 9–12). Measured soft to hard on pad 1: **Pad 9 = 24–104**, Pad 10 = 60–116, Pad 11 = 72–119, Pad 12 = fixed 127. Lessons step 0 tells the user to pick Pad 9. The software curve stays (per device) but only lifts the top end |
| Pad pressure | **channel aftertouch** `D9`, ch 10, seen 5–45 | mono, not poly. Enough for pressure-driven Repeat velocity |
| 8 encoders | **CC 30–37, ch 1**, absolute 0–127, exactly ±1 per message, no acceleration, clamps at 0 | knobs 1→8 (as turned) = CC **36, 37, 34, 35, 32, 33, 30, 31**, so the profile needs an explicit order map. The device holds the value; convert to deltas |
| 5 buttons | **CC 25–29, ch 1**, 127 press / 0 release, momentary | pressed in order 25→29. Labels still to confirm |
| Ports | `SMC-PAD` and `MIDIIN2` carry identical streams; `MIDIIN3` silent | open one input only |
| SysEx | universal identity request (`F0 7E 7F 06 01 F7`) gets no reply on any out port. The **M-VAVE vendor query** `F0 00 32 45 00 00 00 40 7F F7` on the first out port answers `SMC-PAD_004` | vendor protocol per github.com/spectalive/smc-pad (Apache-2.0): logical `00 59 cmd len24 data ~sum`, whole message bit-packed LSB-first into 7-bit bytes. That repo's unit was `SMC-PAD_003` and did not light from note-on; this one does, so firmware differs |
| Double triggers | none seen (one 40 ms retrigger was a real roll) | |
| Pad order | note 36 = bottom-left, ascending (row by row from the bottom assumed) | |
| Banks | hold the bank button: the pads turn blue (device-side menu); pick a bank on the pads. The button sends **no MIDI**. Bank 2 = notes 52–67, so bank *n* = `36 + 16(n−1)` on ch 10 | the note number tells the host the bank, so the host keeps no bank state. Banks 3–4 inferred |
| Pressure burst | every strike emits a channel-AT burst (up to ~106) that decays to 0 within ~30 ms | smooth or gate it before pressure drives Repeat |
| LEDs from host | note-on to `SMC-PAD` out port, **any channel, any velocity ≥ 1** lights the pad with that note; note-off clears it | colour is always the device's pink. Velocity, channel, poly AT and CC (tested) do not change it |

Still unknown: whether pad 2 is right of pad 1 or above it, the rest of the
buttons, and whether vendor SysEx (Cube Suite) can set colours. The next way
to find out is to sniff the editor with USBPcap + Wireshark.

### LED vocabulary (one colour, so time carries the meaning)

The host can only switch a pad between dark and pink, but it can switch it at
any rate. States are coded by pattern, never by colour:

| Pattern | Means |
|---|---|
| dark | empty slot |
| solid | slot has a sound |
| flash off ~80 ms on hit | played (live or by the loop playhead) |
| slow blink (1 Hz) | lessons: next target pad, or Wipe armed on this pad |
| fast blink (4 Hz) | muted |
| on, all others dark | Overlay menu item available |

The on-screen twins carry full colour and labels. The hardware carries the
pattern, so eyes can stay on the pads.

**Colour upgrade (unverified on this unit):** the vendor protocol has a per-pad
RGB write (`cmd 0x22`, address `profile*3539 + 211 + padIndex*26 + 5`). Per the
reverse-engineered app, it changes working memory only; persisting needs a
separate save command, which we never send. If that holds, the plan is to write
each pad's kit colour once on kit load and keep note on/off for the live
pattern, so the pink becomes the pad's own colour. It needs `sysex: true` (a
reviewed change) and a session (identity query, then config reads). Verify on
`SMC-PAD_004` before designing around it.

Config read on this unit (read-only, 2026-11-26): all four stored profiles are
identical. Pad records sit at the documented offsets: `00 09 <note> 00 7f R G B
ff`, ch10, notes 4–35, RGB `96 c8 f0` (pale blue) for pads 0–15 and `f0 f0 00`
(yellow) for 16–31. **None of that matches live behaviour** (notes 36–51, pink
host LEDs, blue on bank hold), so the active map is not the stored profile.
Profile select may be in region 4 (`78 00 32 04 00 00 02 00 02 01 06 00`), but
that is a guess. A working-memory colour write may therefore change nothing
visible. Replies over ~1 KB truncate in rtmidi/WinMM, so read in ≤400-byte
chunks.

**Colour upgrade: unresolved, lead found.** Writing green to records 0–31 of
profiles 0–3 was acked and read back, but the host-lit pads stayed pink. That
test missed the live bank. Each of the 8 profiles holds 128 pad records (8 banks
× 16 pads). Records 32–47 store notes 36–51 (the live bank 1) in `f0 00 f0`
(the pink we see). Records 48–63 store notes 52–67 in `00 00 f0`, which matches
the blue shown while the bank button is held. Next test: write records 32–47.
All writes so far were restored and verified, and no save was sent.

**Colour control proven (2026-11-26).** SHIFT + Pad 1–8 selects the preset
(per the Sinco manual): 1 = Performance, 2 = DAW, 3–8 = user presets. In a user
preset (SHIFT+Pad 3), idle pads show their stored record colour and send that
record's notes: bank 1 pad 1 = note 20 = record 16, stored yellow. Writing
`00 ff 00` to record 16 (profiles 0 and 1) turned pad 1 green **immediately**,
with no save. Region 4 tracks the mode: bytes 6/10 read `02/06` in Performance
and `01/01` in user preset 1.

Plan consequence: Pads view asks the user to select a user preset (SHIFT+Pad
3), confirms it by reading region 4, then writes each pad's kit colour on kit
load (16 writes, working memory only, never save). This needs `sysex: true` in
`requestMIDIAccess`, which is a reviewed change.

**User-mode LED facts (tested 2026-11-26):**

| Test | Result |
|---|---|
| Plain note-on, any note, channel or port | ignored; pads stay at their stored colour |
| Hit a pad | the pad flashes white by itself (free hit feedback) |
| Region 4 byte 10 | **active profile index**: writes to that profile show; writes to others do not |
| Colour writes at 4 per second, each acked | clean red/yellow blink on pad 1 |
| Identity query first | sent in every working run, and the official app does it, so keep it |

So in user mode, the host owns base colour and animation (target, mute and
Wipe blinks) through cmd 0x22. The target is profile = region4[10] and record
= bank*16 + pad (the bank → record mapping in user mode is unverified beyond
bank 1 = records 16–31). The device draws the hit flash itself. Re-read region
4 whenever the user may have changed preset; the official app polls it. Read
the note map from the records, never assume it.

Target layout:

| Control | Default role | Shift / hold role |
|---|---|---|
| 16 pads | play (velocity, aftertouch if present) | under an overlay: menu items |
| Encoder 1 | Groove | fine Groove |
| Encoder 2 | Repeat rate (1/4 … 1/32T) | — |
| Encoders 3–6 | Tune / Decay / Filter / Level of selected pad | same for whole kit |
| Encoder 7 | Snap strength | Snap grid |
| Encoder 8 | BPM | loop length (bars) |
| Button: Play | play/stop project transport | return to bar 1 |
| Button: Rec | arm Layer at next bar (count-in first time) | undo last pass |
| Button: Repeat | hold = Repeat; | latch |
| Button: Wipe | hold + pad = wipe pad; hold alone = wipe all at bar end | — |
| Device bank button | handled on the device (notes shift by 16 per bank); the host reads the bank from the note | — |
| Overlay button (TBD) | hold: pads = mute/solo grid | — |
| Button: Full | toggle Full | Ladder (pick parameter on pads) |

Fallbacks, decided now so missing buttons cannot block the plan:

- Fewer usable buttons than needed: keyboard twins (Space play, R rec, Q
  repeat, E wipe, B bank, F full) — they are the same commands in
  `ShortcutManager`.
- No aftertouch: Repeat velocity = velocity of the hit that started it.
- Relative vs absolute encoders: profile flag; absolute values are converted
  to deltas so knob twins never jump.
- Several USB ports: the SMC-PAD **mirrors** every message on `SMC-PAD` and
  `MIDIIN2`. Open exactly one input per device, or every hit plays twice.

**Help overlay:** hold Shift + touch any control → its on-screen twin shows
what it does right now. Every control explains itself.

## Lessons mode

Lessons run inside the Pads view: same pads, same loop strip, plus ghost
targets on the strip and a lesson card in a non-modal dialog. Nothing is
locked; finishing a lesson only marks it done and suggests the next.

Each lesson is data:
`{ id, title, concept, bpm, groove, bars, kit, targets: [{ pad, beat, vel? }], pass: { goodPct: 0.8 }, hints: [...] }`.

| # | Lesson | Teaches | Done when |
|---|---|---|---|
| 0 | Meet your pads | pad test + latency calibration (tap 16 clicks; offset = median error) | calibration saved |
| 1 | Soft and hard | velocity: hit targets at marked velocities | 80 % in velocity band |
| 2 | Kick and snare | placement against the click | 80 % good |
| 3 | First groove | kick 1 & 3-and, snare 2 & 4, hats 8ths | 80 % good, 2 loops |
| 4 | Hats with Repeat | hold Repeat; rate knob; open/closed choke | sustained repeat 2 bars |
| 5 | Layer it | record, overdub, undo, never stop | loop has 3 pads |
| 6 | Wipe | remove one pad's hits while playing | target pad empty |
| 7 | Groove | 50 → 54 → 62 → 66, hear the difference, pick one | A/B listened |
| 8 | Snap | record loose, apply strength 50 % vs 100 % | before/after compared |
| 9 | Ladder | play a melody from one sound across 16 pads | phrase matched |
| 10 | Mute performance | bank overlay mute/solo to build and drop | 4 mutes in time |
| 11 | Slice (after phase 5) | drop a loop, slice to 16, replay | new pattern recorded |

Feedback on screen while playing: each hit marks perfect/good/ok/miss, a bias
needle shows mean early/late, and a pad LED (or the on-screen pad) lights the
next target pad. Hardware-aware hints fire on patterns, for example "every hit
is 127 — Full is on, or the curve is too hard" or "you are 40 ms late on
average — recalibrate?".

## Architecture

Functional core, imperative shell. Every module marked PURE gets a vitest file
in `tests/`.

```
pads/profile.js        PURE raw midi-event + profile → { kind: pad|knob|button, ... }
pads/profiles/smc-pad.js  data from phase 0 capture
pads/velocity-curve.js PURE threshold + curve + Full + Ladder → velocity / params
pads/groove.js         PURE grid, swing, snap(t, grid, strength), repeat times in window
pads/loop-record.js    PURE (loop, event, transportPos, mode) → loop'; layer/wipe/undo passes
pads/kit.js            PURE kit model, choke-group resolution, default kits
pads/kit-voices.js     shell: kit → voices via tr909-kit, palettes, sample-instrument; choke = per-group gain duck
pads/lesson-score.js   PURE hits × targets × windows × offset → marks, bias, pass
pads/lessons.js        PURE data
components/pads-view.js shell: DOM, knob twins, overlays, lesson strip
```

Hot-path rule: a MIDI hit does no store read, clone, or stringify. The armed
track's resolved instrument is cached and rebuilt on store change, and
`ensureMounted` / sample decode happen when a track is armed, not on its first
hit.

## Phases

| Phase | Ships | Verify |
|---|---|---|
| **0 Capture** (needs the user, ~10 min) | `pads/profiles/smc-pad.js` and a hardware table appended here: per-port notes/CCs/buttons, encoder mode, aftertouch yes/no, LED protocol yes/no, velocity floor, double-trigger rate | capture log committed under `specs/hardware/` |
| **1 Feel fixes** (no new view) — **built 2026-11-26, awaiting hardware check** | hot-path cache + arm-time prewarm; `kit` instrument with a default 16-pad 909 kit; choke groups; velocity → timbre; all ports of the device | new tests green; manual: each of 16 pads a distinct sound, open hat chokes |
| **2 Pads view core** — **built 2026-11-26** | F5 view, pad twins, loop strip on project transport, metronome + count-in, Layer / undo / Wipe, Snap, Groove, schema v7 kits | pure tests for groove + loop-record; jsdom view boot test extended |
| **3 Performance** — **built 2026-11-26, awaiting hardware check** | Repeat (+pressure), Full, Ladder, banks A–D, Overlay menus, knob twins, help overlay, controller learn dialog, LED mirror if available | manual pass with hardware against the mapping table |
| **4 Lessons** — **built 2026-11-27, awaiting hardware check** | calibration, scorer, lessons 0–10, progress, hints | scorer tests with synthetic early/late hit sets |
| **5 Samples** — **built 2026-11-27, awaiting hardware check** | drop WAV on pad, slice to 16 (transient detect, PURE), lesson 11 | slicer tests on synthetic buffers |

Phase 1 is shippable alone and should fix most of today's complaint.

LED slice (built 2026-11-26, awaiting hardware check): `pads/smc-pad-sysex.js` (PURE
codec, byte vectors pinned to the probe that drove the device; no save command exists in
it) and `pads/smc-pad-link.js` (request/reply shell). `MidiController` asks for
`sysex: true` and falls back to plain access if refused. When the armed track plays a
kit and the SMC-PAD is in a user preset, `app.js` paints pad *i* of all 8 banks in the
active profile (region 4 byte 10) with its voice colour, writing only records whose
colour differs, and maps every stored record note to kit note `36 + rec % 16`. The mode
is polled every 2 s because the preset switch sends no MIDI. Performance mode is left
alone. Not built yet: host blinks (target/mute/Wipe) need the Pads view; transpose and
octave shift (SHIFT + Pad 13–16) move notes outside the record map and then play raw.

Phase 1 notes: the kit is `{ type: 'kit', kitId: 'default-909' }` (code data in
`pads/kit.js`, GM 36–51 distinct, no schema change). The velocity curve is applied in
`MidiController` per input (SMC-PAD: `inMax` 110, linear), so recordings store what was
heard. Mirror ports (`MIDIIN2 (SMC-PAD)`, `MIDIIN3 (SMC-PAD)`) collapse into one device
entry. Known leak: `tr909-kit.js` keeps the open hat in a module global, so a kit closed
hat can also choke the 909 view's open hat.

Phase 2 notes: in `pads` mode the global Play/Stop drive a loop player
(`pads/loop-player.js`) at the project BPM, as the Sequencer does in synth mode; the
view has no clock or play button. Swing (Groove) and Snap are baked into the notes at
record time, so playback never re-swings and the arrange view plays the loop clip as
heard. One pass (hits plus wipes between loop wraps, Layer off, or Stop) is one undo
step, labelled `Pads pass`. Undo discards a non-empty open pass; otherwise it undoes
the last store step only if that step is a Pads pass, else it does nothing (the button
is disabled). Count-in: Play with Layer on and count-in > 0 starts at a negative beat
with clicks only. Known ceilings: hits already scheduled in the lookahead (<= 100 ms)
still sound after Stop; migrated projects carry a copy of the default kit in
`state.kits`, which shadows later code-side kit changes (revisit with the kit editor
in phase 3); changing Bars does not truncate notes (they wrap into the shorter loop,
and the next commit resizes the clip).

Phase 3 notes: decisions. No MIDI clock out: Repeat is Synth's own engine (grid-locked
to the loop when it plays, free-running otherwise), so the SMC-PAD's own Note Repeat stays
off. Default button roles are CC 25 play, 26 layer, 27 repeat, 28 wipe, 29 full on channel
1; the hardware labels are unconfirmed, so learn can remap. Keyboard twins: G hold Repeat,
H Full, O hold Overlay, L cycle Ladder (keydown ignored while a dialog is open; a keyup
still ends a hold). Learn overrides live in localStorage per device name
(`synth_pads_map_<device>`), keyed by control (`cc:<ch>:<n>` or `note:<ch>:<n>`), knobs as
`knob:<n>`; learning an action onto a new control stores the profile's old control as
`null`, which means unbound. Knob tune is the `tuneSt` semitone key of the slot's `perf`
layer ({ tuneSt, decayMul, filterMul, level }), never the 909 `tune` float; `perf` is read
live by the kit instrument, is excluded from the instrument rebuild signature, and is
combined with the per-hit Ladder override. The controller router acts only in the Pads
view (elsewhere every control falls through to normal handling); the learn dialog works
anywhere. The LED mirror counts SysEx writes (8 per 125 ms tick; a pad is up to 8 writes),
advances only for acknowledged pads, follows the bank the view shows, and blinks at 1 Hz
instead of 4 Hz when more than 4 pads want the fast blink. Known limits: (a) one knob
detent is one undo entry (a long twist is many) and edits the project's copy of the kit,
seeded from code in the same batch if missing; (b) the Ladder records velocity only, so
tune/decay/filter ladder hits are live-only and recorded loop notes carry no per-hit
timbre; (c) a live strike within one tick of the next repeat point may double (the repeat
engine is not told about live hits); (d) the LED blink cap above.

Phase 4 notes: `pads/lesson-score.js` (PURE matcher, windows, calibration, hints),
`pads/lessons.js` (PURE lessons 0–10, evaluator, progress helpers), `pads/lesson-strip.js`
(PURE strip geometry), `pads/lesson-session.js` (shell), `components/lesson-card.js`.
LESSONS button in the Pads view or "Lessons…" in the ⋯ menu opens a non-modal card
(`openDialog(id, { modal: false })`, `data-nonmodal`, so pad keys and G/H/O/L keep working;
Escape or ✕ closes it and stops the lesson, as does leaving the Pads view). Starting a
lesson sets BPM, bars, groove, `full:false`, `ladder:null` plus the lesson's own setup in one
"Lesson setup" undo step, shows bank A, and restarts the loop. Scoring uses the raw pad hit
(before Ladder/Full) against ghost targets over the last 4 laps; a placement pass needs at
least one fully resolved lap. Calibration (lesson 0) takes 16 taps on the click; the median
error is the offset subtracted from every later score. Progress and calibration live in
localStorage `synth_pads_lessons`. The next target pad blinks on screen and, in a user
preset, on the device (LED `target`). Known limits: velocity is scored after the device
curve and Full; on a phone the card covers the lower pad rows (close it to play); Groove and
Snap lessons credit a setting once a non-empty loop wraps with it, they cannot tell whether
you listened.

Phase 5 notes: `pads/slicer.js` (PURE onset envelope, peak picking, 16 contiguous regions
snapped to zero crossings, bar/BPM estimate), `instruments/user-samples.js` (IndexedDB, works on
the LAN route; id = 64-bit FNV pair + byte length, no secure-context API), kit slot
`{ voice: 'sample', sampleId, name, start, end }` played as a region one-shot in
`pads/kit-voices.js` (velocityGain, perf tune/decay/level, missing sample = silent, failed ids
negative-cached until prewarm or a new put), `components/slice-dialog.js`, `pads/sample-drop.js`.
Drop an audio file on a pad (<= 10 MB, <= 60 s) to load it there; drop on the strip/grid or press
SLICE… to open the Slice dialog (<= 30 s): waveform, 16 markers, sensitivity, click a region to
audition, "Set BPM to N", Apply = one "Slice sample" undo step on the armed kit, pads 1–16 of bank
A. Play and bounce preload kit samples first. Lesson 11 "Slice" passes when a recorded pattern uses
4 sample pads. Known limits: samples live in this browser's IndexedDB and do not travel with a
saved project (a missing sample plays silent); a sample pad retriggers polyphonically (no self-choke);
very short or silent files are refused; sliceRegions may return fewer than 16 regions for short
material.

## Constraints that still apply

- Web MIDI is secure-context only: on the LAN http route the Pads view works
  with mouse, touch and keyboard twins, not the controller.
- No worklet or secure-context API on the pad audio path.
- CSP `connect-src 'none'`: lessons and kits ship in the bundle.
- `requestMIDIAccess` moves to `sysex: true`, **approved by the user
  2026-11-26** for SMC-PAD colour writes and region-4 reads. It lands with the
  LED work, not phase 1, and the PR must call it out. Never send the save
  command.

## Open questions

- SMC-PAD: pad grid order, banks, remaining buttons and LED protocol (see
  captured facts above for what is known).
- Device velocity curve: answered by the printed manual (SHIFT + Pad 9–12) and
  measured; see the captured facts. Also from the manual: on-device Note Repeat
  (rate, swing, latch, tap tempo, and sync that needs host MIDI clock) overlaps
  our Repeat. Decide whether the app sends clock or tells the user to leave
  device repeat off. Transpose and octave shift (SHIFT + Pad 13–16) move pad
  notes, so map pads from the records or by learn, never by fixed note.
- Measured input-to-sound latency on Electron vs Chrome; record in phase 0.