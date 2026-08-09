# TR-909-Style Virtual Rhythm Composer Specification

## 1. Purpose

Add a TR-909-style virtual drum machine to Synth as a first-class instrument and pattern editor. The goal is not a branded clone or a pixel-for-pixel recreation. The feature should capture the workflow users expect from a classic 16-step rhythm composer: immediate drum programming, per-instrument tone shaping, accent/shuffle/flam timing, and pattern clips that can be arranged in the DAW.

This spec is based on the original Roland TR-909 layout/functionality and current Synth architecture. Source references are listed at the end.

## 2. Product Fit

Target users are hobbyist producers who want fast house/techno drum programming without leaving the app.

The rhythm composer should live in two places:

- **Synth mode:** a dedicated "909" palette/tool panel for playing, editing, and auditioning kits and patterns.
- **Arrange mode:** pattern clips that reference saved drum patterns and can be repeated, moved, trimmed, bounced, and mixed like other project content.

The implementation should reuse the existing Electron/Vite renderer, Web Audio engine, `ProjectStore`, mixer channels, and sequencer scheduling style. It should not introduce a third-party audio engine for MVP.

## 3. Research Summary

The original TR-909 is a hybrid rhythm composer introduced in 1983. Roland's current product material describes the sound architecture as analog-style circuits for kick, snare, clap, and toms, with digital samples for cymbals. Roland's technical specification lists 16 steps per measure, tempo range of quarter note 37-290, 48 rhythm patterns per bank set, four song tracks per bank, and these sound sources:

- Bass Drum: level, tune, decay, attack
- Snare Drum: level, tune, tone, snappy
- Low Tom: level, tune, decay
- Mid Tom: level, tune, decay
- High Tom: level, tune, decay
- Rim Shot: level
- Hand Clap: level
- Closed/Open Hi-Hat: level, tune
- Crash Cymbal: level, tune
- Ride Cymbal: level, tune

The same Roland specification marks bass drum, snare, toms, and closed/open hi-hat as accent-capable. It also lists the core physical controls: start, stop/continue, tempo, track selectors, pattern group selectors, bank buttons, scale, instrument selector, shuffle/flam, last step, total accent, and 16 main step keys.

For Synth, the important behaviors to preserve are:

- A 16-step grid as the primary interaction.
- Instrument selection plus 16 main step buttons.
- Per-instrument sound controls and level.
- Total accent and per-hit velocity/accent behavior.
- Shuffle and flam as timing modifiers.
- Last-step and scale controls for non-default loop length and rhythmic resolution.
- Pattern bank storage and pattern clips in the arranger.

## 4. User Experience

### 4.1 Layout

Use a hardware-inspired but app-native layout. Avoid Roland branding, exact panel artwork, and copied labeling beyond generic instrument/function names.

Recommended desktop structure:

```text
Rhythm Composer Header
  Transport: play, stop, record/overdub, tempo, swing/shuffle, pattern selector
  Pattern Controls: bank, pattern slot, copy, clear, randomize, last step, scale

Instrument Mixer / Voice Panel
  10 instrument strips:
    BD, SD, LT, MT, HT, RS, CP, CH, OH, CY/RD
  Each strip shows level, mute/solo, select button, and compact tone controls.

Step Editor
  16 fixed-width step buttons grouped by beats 1-4, 5-8, 9-12, 13-16
  Active instrument lane shown large; optional all-lanes grid toggle
  Accent lane and flam lane visible below the instrument lane
```

Mobile/tablet structure:

- Transport and pattern selector pinned at top.
- Instrument selector as a horizontal segmented strip.
- 16-step editor below, split into two rows of eight if width is constrained.
- Voice parameters in a collapsible bottom sheet.

### 4.2 Modes

- **Play:** pattern playback, live pad triggering, mute/solo changes.
- **Write:** step entry, clear, copy, paste, randomize.
- **Instrument edit:** selected voice controls are prominent; step grid remains visible.
- **All-lanes edit:** full drum grid for fast comparison across instruments.

### 4.3 Controls

Global controls:

- Tempo/BPM: use project BPM by default; allow local audition BPM only when no project is open.
- Shuffle: 0-100%, implemented as delayed off-beat sixteenth steps.
- Flam amount: 0-100%, mapped to a short secondary hit delay.
- Scale: at least 16th and 32nd note divisions for MVP; 8th triplet can be post-MVP.
- Last step: 1-16, per pattern for MVP; per-instrument last step post-MVP.
- Total accent amount: 0-100%.

Instrument controls:

| Instrument | MVP controls | Post-MVP controls |
|---|---|---|
| Bass Drum | level, tune, decay, attack | drive, pitch envelope amount |
| Snare Drum | level, tune, tone, snappy | noise decay, body decay |
| Low/Mid/High Tom | level, tune, decay | pan, body color |
| Rim Shot | level | tone |
| Hand Clap | level | spread, reverb send, noise decay |
| Closed Hi-Hat | level, tune, decay | choke group controls |
| Open Hi-Hat | level, tune, decay | choke group controls |
| Crash Cymbal | level, tune, decay | sample/wavetable selector |
| Ride Cymbal | level, tune, decay | sample/wavetable selector |

## 5. Sound Design

### 5.1 MVP Approach

Build a 909-inspired kit without shipping copyrighted ROM samples.

- Analog-modeled voices use Web Audio oscillators, noise buffers, filters, envelopes, gain staging, and optional waveshaping.
- Cymbal/hi-hat voices should be synthetic or generated assets in-repo, not copied from Roland ROMs or commercial sample packs.
- Provide defaults that are punchy and recognizable, but expose enough parameters for users to shape the kit.

### 5.2 Voice Architecture

Create a new module, likely `src/renderer/js/drums/tr909-kit.js`, with a clear factory:

```js
export function createTr909Voice(ctx, output, instrumentId, params, event, time) {
  return { stop(time) {} }
}
```

`event` should include:

```js
{
  velocity: 0.0,
  accent: false,
  flam: false,
  probability: 1.0
}
```

Each voice output must be able to route to either the master input for the current synth UI or an arrange/mixer channel when rendered as a project track.

### 5.3 Choke Behavior

Closed and open hi-hats share a choke group. Triggering closed hi-hat must stop or rapidly attenuate an active open hi-hat voice. Other instruments can overlap by default.

## 6. Sequencer Behavior

### 6.1 Pattern Model

Add a drum pattern data shape under `ProjectStore.state.patterns`.

```json
{
  "id": "pattern-909-1",
  "type": "drumMachinePattern",
  "engine": "tr909",
  "name": "909 Pattern 1",
  "steps": 16,
  "scale": "1/16",
  "shuffle": 0.0,
  "flam": 0.0,
  "lastStep": 16,
  "kitId": "kit-909-default",
  "lanes": {
    "bd": [{ "on": true, "velocity": 0.9, "accent": true, "flam": false }],
    "sd": [],
    "lt": [],
    "mt": [],
    "ht": [],
    "rs": [],
    "cp": [],
    "ch": [],
    "oh": [],
    "cr": [],
    "rd": []
  }
}
```

Use fixed-length lane arrays internally. Serialization may omit default/off steps if needed, but loaded state must normalize back to 16 step objects per lane.

### 6.2 Clip Integration

Pattern clips should reference the pattern:

```json
{
  "id": "clip-909-1",
  "type": "PatternClip",
  "patternId": "pattern-909-1",
  "startBeat": 0,
  "duration": 4,
  "repeatCount": 4
}
```

Double-clicking the clip in Arrangement View opens the rhythm composer editor, not the piano roll.

### 6.3 Scheduling

The existing 16-step `Sequencer` schedules with lookahead; the TR-909 scheduler should reuse that pattern but accept richer events:

- Per-step velocity and total accent.
- Shuffle timing offsets.
- Flam secondary trigger.
- Last-step wrap.
- Hi-hat choke state.

Playback must be sample-accurate enough for groove work by scheduling Web Audio events against `AudioContext.currentTime`; DOM updates can remain on `requestAnimationFrame`.

## 7. State, Commands, and Persistence

Add command factories:

- `AddDrumPattern(engine, name)`
- `SetDrumStep(patternId, laneId, stepIndex, patch)`
- `SetDrumPatternParam(patternId, param, value)`
- `SetDrumKitParam(kitId, instrumentId, param, value)`
- `DuplicateDrumPattern(patternId)`
- `ClearDrumPattern(patternId)`

Project serialization must preserve:

- Pattern lane data.
- Kit parameter values.
- Clip references.
- Mixer routing and sends.

Undo/redo must treat each user gesture as one command. Dragging multiple step values should collapse into one history entry.

## 8. Mixer and Routing

MVP can route the full drum machine to one mixer channel.

Post-MVP should support optional multi-output routing:

- BD
- SD
- Toms
- Hats
- Cymbals
- Percussion/clap/rim

When multi-out is enabled, create child mixer channels tied to the parent drum machine track. Muting/soloing the parent should affect all children.

## 9. Implementation Plan

### Progress Notes

- 2026-06-08: Added the first synth-mode TR-909 view behind a new `909` palette tab. It includes the 11 MVP lanes, 16-step selected-lane editor, accent/flam lanes, all-lanes toggle, last-step, scale, shuffle, total accent, randomize/clear, per-instrument parameter controls, live instrument triggering, Web Audio scheduling, generated 909-inspired voices, and closed/open hi-hat choke behavior. Arrange-mode pattern clips, ProjectStore persistence, and undo/redo commands remain to be implemented.

### Phase A - Spec and Data Model

- Add this spec and root `SPEC.md` pointer.
- Define pattern/kit data shapes in `ProjectStore`.
- Add tests for normalization, serialization, undo/redo commands, and clip references.

### Phase B - Sound Engine MVP

- Add the `tr909-kit` voice factory.
- Implement BD, SD, toms, rim, clap, closed hat, open hat, crash, and ride.
- Add choke handling for hats.
- Add unit-level smoke tests where practical and audio graph lifecycle tests for returned `stop()` handles.

### Phase C - Step Editor UI

- Add a "909" tab or tool in Synth mode.
- Build instrument selector, 16-step editor, accent/flam lanes, pattern selector, and compact parameter controls.
- Keep fixed dimensions for step buttons and transport controls to prevent layout shifts.

### Phase D - Arrange Integration

- Add drum-machine pattern clips.
- Open the rhythm composer from Arrangement View.
- Route playback through the project timeline and mixer.
- Ensure bounce/export includes drum pattern output.

### Phase E - Polish

- Add copy/paste, randomize, clear lane, clear pattern, and optional per-instrument last step.
- Add multi-output mixer routing.
- Add MIDI note mapping for live triggering and pattern start/stop.

## 10. Acceptance Criteria

- A user can create a TR-909-style drum pattern with all 11 named lanes: BD, SD, LT, MT, HT, RS, CP, CH, OH, CR, RD.
- Pattern playback supports 1-16 step loops, project BPM sync, shuffle, accent, flam, and hi-hat choke.
- Each MVP instrument exposes its required controls and persists parameter changes in the project.
- A drum pattern can be placed as a clip in Arrangement View, repeated, moved, saved, loaded, and bounced.
- Undo/redo works for step edits, pattern parameter edits, and kit parameter edits.
- The UI remains usable at desktop and narrow widths without text overlap or step grid resizing during interaction.
- The implementation uses original synthesized/generated sounds or user-provided samples, not Roland ROM dumps or commercial sample-pack assets.

## 11. Open Questions

- Should the first implementation replace the existing "Drum Machine" palette or sit beside it as a separate "909" palette?
- Should kit parameters be stored globally per project, per track, or per pattern? Recommended: per track/kit, with pattern clips referencing a kit id.
- Should arrangement playback render a single stereo drum-machine track first, then add multi-out later? Recommended: yes.
- Should the UI expose the original-style single active instrument lane first, or all lanes by default? Recommended: single lane plus all-lanes toggle for MVP.

## 12. Sources

- Roland technical specification for TR-909 sound sources, controls, memory, tracks, step count, tempo range, and rear-panel routing: https://support.roland.com/hc/en-us/articles/201921899-TR-909-Technical-Specifications
- Roland original TR-909 owner's manual PDF archive: https://cdn.roland.com/assets/media/pdf/TR-909_OM.pdf
- Roland TR-909 Software Rhythm Composer product page describing the hybrid analog/digital design: https://www.roland.com/us/products/rc_tr-909/
- Roland Cloud TR-909 plugin quick start noting software sequencer features such as sub outputs, MIDI/audio drag, and advanced shuffle: https://support.roland.com/hc/en-us/articles/26349420840475-Roland-Cloud-TR-909-Plugin-Quick-Start
