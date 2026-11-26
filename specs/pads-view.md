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
| 2 | Velocity scales gain only, so soft and hard hits are the same sound at two volumes. | `palettes.js` drum voices |
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
| LED feedback | Build only if phase 0 finds a usable protocol. It is the first MIDI-out use; it needs nothing from midi-bridge phase 5 beyond `output.send` | Build MIDI out when something on the other end needs it (AGENTS.md) — the pads now do |
| Lessons progress | `localStorage` behind try/catch, never project state | Per-user convenience, not a project fact |
| Lessons scoring windows | After latency calibration: ≤25 ms perfect, ≤50 good, ≤90 ok, else miss. Always show signed early/late bias | Rhythm-game windows (Rock Band 100 ms slop); bias teaches more than a score |
| Schema | Bump `CURRENT_VERSION` 6 → 7, add `state.kits{}`, migration seeds one default kit | `store/ProjectStore.js:16` |

**DECIDE** before phase 2: confirm recordings go to the armed track's clip
(recommended above) rather than a separate pad-pattern store like the 909's.

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

Phase 0 replaces the guesses with captured facts. Target layout:

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
| Button: Bank | hold: pads 1–4 = banks A–D, 5–16 = mute/solo grid | — |
| Button: Full | toggle Full | Ladder (pick parameter on pads) |

Fallbacks, decided now so missing buttons cannot block the plan:

- Fewer usable buttons than needed: keyboard twins (Space play, R rec, Q
  repeat, E wipe, B bank, F full) — they are the same commands in
  `ShortcutManager`.
- No aftertouch: Repeat velocity = velocity of the hit that started it.
- Relative vs absolute encoders: profile flag; absolute values are converted
  to deltas so knob twins never jump.
- Several USB ports: subscribe to every input of the chosen device, not just
  the first (`MidiController.js:56` holds one).

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
| **1 Feel fixes** (no new view) | hot-path cache + arm-time prewarm; `kit` instrument with a default 16-pad 909 kit; choke groups; velocity → timbre; all ports of the device | new tests green; manual: each of 16 pads a distinct sound, open hat chokes |
| **2 Pads view core** | F5 view, pad twins, loop strip on project transport, metronome + count-in, Layer / undo / Wipe, Snap, Groove, schema v7 kits | pure tests for groove + loop-record; jsdom view boot test extended |
| **3 Performance** | Repeat (+pressure), Full, Ladder, banks A–D, Overlay menus, knob twins, help overlay, controller learn dialog, LED mirror if available | manual pass with hardware against the mapping table |
| **4 Lessons** | calibration, scorer, lessons 0–10, progress, hints | scorer tests with synthetic early/late hit sets |
| **5 Samples** | drop WAV on pad, slice to 16 (transient detect, PURE), lesson 11 | slicer tests on synthetic buffers |

Phase 1 is shippable alone and should fix most of today's complaint.

## Constraints that still apply

- Web MIDI is secure-context only: on the LAN http route the Pads view works
  with mouse, touch and keyboard twins, not the controller.
- No worklet or secure-context API on the pad audio path.
- CSP `connect-src 'none'`: lessons and kits ship in the bundle.
- `requestMIDIAccess` stays `sysex: false` unless phase 0 shows LEDs need
  SysEx; that is a reviewed change.

## Open questions

- SMC-PAD MIDI map, aftertouch, LED protocol, and port roles: unknown until
  phase 0. No published map exists.
- Does Cube Suite (the vendor editor) expose a velocity curve good enough to
  skip ours? Ours ships regardless; it is per-device in software.
- Measured input-to-sound latency on Electron vs Chrome; record in phase 0.
