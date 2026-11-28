# Arrange MIDI recording — plan

Status: plan, not built. Owner decisions marked **DECIDE**.

## Problem

Today a MIDI clip can only be recorded from a hardware MIDI device, through the hidden `⏺ MIDI REC`
button in the MIDI setup dialog (`app.js` handler near `#midi-record-btn`, capture in
`midi/MidiController.js`). It:

- ignores the computer keyboard, the on-screen keys, the pads and the FM-1 panel note keys;
- times notes by wall clock at message arrival (`performance.now()`), not by audio time;
- always starts at beat 0 and is not tied to Arrange playback, so recording over a playing
  arrangement lands misaligned unless both are started by hand;
- makes two undo steps and leaves an empty clip when nothing was played.

The Pads view already records into its loop clip (pads phases 2–3) and stays as it is. This plan is
for Arrange.

## Goal

Record whatever the armed track plays — from any input — into a new MIDI clip on that track,
aligned to the arrangement, as one undo step. It works the same for palette, pack, rack, kit and
FM-1 tracks, on Electron, HTTPS and the LAN http route (no secure-context API involved).

## Design

**One tap where inputs converge.** Every note-on/off that reaches the armed track's live
instrument passes one function, `recordTap(trackId, { pitch, velocity, on, time })`, with `time`
in AudioContext seconds (the audible time the note was scheduled at, the same value passed to the
instrument). Sources: `handleMidiEvent` (MIDI devices), the `note-on`/`note-off` document events
(computer keyboard and on-screen keys), `padsNoteOn` when the view is not recording its own loop,
and the FM-1 device dialog's note keys (they are firmware keys, not MIDI: they are recorded only if
they are also routed as MIDI notes — **DECIDE**: record panel note keys as notes, or leave panel
play out of MIDI clips).

**Pure core** `midi/take-recorder.js`: `createTakeRecorder({ startTime, startBeat, bpm,
beatsPerBar, quantize? })` -> `{ note(event), sustain(down, time), finish(endTime) -> { notes,
startBeat, durationBeats } | null }`. Converts audio time to beats against the transport anchor,
pairs on/off per pitch (re-trigger closes the open note), bakes CC64 sustain into note lengths,
drops notes shorter than a floor, returns `null` for an empty take (no clip). Unit-tested with
synthetic events: nonzero start, tempo math, overlap, sustain, hanging notes closed at stop,
empty take.

**Transport link.** Recording starts Arrange playback through the guarded `transportPlay()` path
(phase 3 of FM-1 made it the single entry) and uses the start time `TimelinePlayer.play()` returns
as the anchor, so recorded notes and played-back notes share one clock. Stop ends the take.
Existing clips keep playing while recording (overdub by listening).

**Commit.** One `dispatchBatch` labelled `Record MIDI`: `AddClip(trackId, { type:'midi', name:
'Take N', startBeat, duration, notes })`. A take always becomes a new clip; nothing existing is
edited (**DECIDE**: new clip per take — simplest, non-destructive — vs. merging into a clip under
the playhead). An empty take adds nothing.

**Where the button lives — DECIDE.** The header `●` (`#rec-btn`, `data-cmd="record"`) records the
master to a WAV today. Options:
1. `●` becomes MIDI record in Arrange (the DAW convention); master WAV moves to the `⋯` menu as
   "Record master to WAV…". Recommended.
2. Keep `●` for WAV; add MIDI record as a command and shortcut only.

**Count-in — DECIDE.** Reuse the pads metronome click: optional 1-bar count-in, default off.

**Start position.** Arrange has no playhead or seek yet (play starts at beat 0). Recording starts
where play starts; when a seek/playhead lands, recording follows it with no change here. A
"start at bar" field is not added in this phase.

**The old recorder.** `#midi-record-btn` and the wall-clock capture in `MidiController` are removed
once the tap covers MIDI devices (one recorder, one behaviour).

## Out of scope

Pads loop recording (exists), quantize-on-record beyond an optional grid, punch in/out ranges,
loop recording with takes, recording CC/pitch-bend/aftertouch into clips (the clip schema is
note-only), recording FM-1 internal sequencer output as MIDI (the emulator has no MIDI out; use
**Record FM-1 to audio track…**).

## Phase

| Phase | Ships | Verify |
|---|---|---|
| **1 Arrange MIDI record** | `midi/take-recorder.js` (PURE) + tap at the input convergence points + transport-linked start/stop + one-step commit + chosen button placement + optional count-in; old MIDI REC removed | take-recorder unit tests; app tests that keyboard, MIDI and pad notes reach the tap with audio times; a recorded take plays back aligned (timeline test with fake ctx); Electron smoke: record keys over a playing arrangement on a palette track and an FM-1 track, undo once |

Estimated size: small-to-medium (one pure module, wiring in `app.js`, one button change, tests).
