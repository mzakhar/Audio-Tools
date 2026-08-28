# UX Evaluation Scenarios — synth and DAW workflows

This app spans five surfaces (synth view, arrange view, modular rack, TR-909,
instrument packs) plus an attached external controller (Synido TempoKEY K25:
25 keys, 8x2 pads, 8x2 knobs, pitch/mod strips, transport buttons, onboard
arpeggiator). Feature specs (`specs/instrument-browser.md`,
`specs/midi-bridge.md`, `specs/ui-shell.md`, `specs/tr-909-*.md`,
`specs/instrument-packs.md`) describe what exists. This spec describes
**what a person is trying to do**, independent of which module handles it, so
we can tell whether the pieces add up to a usable instrument instead of a pile
of correctly-implemented parts.

Research grounding:

- Patch browsing/auditioning conventions on hardware and in librarian software
  — pin-and-arrow-key auditioning, category/tag browsing so a session doesn't
  become "trawl through hundreds of non-relevant patches":
  [Reason — Sounds, Patches and the Browser](https://docs.reasonstudios.com/reason12/sounds-patches-and-the-browser),
  [Sound on Sound — Just Browsing](https://www.soundonsound.com/techniques/just-browsing),
  [KVR — hardware synth workflow thread](https://www.kvraudio.com/forum/viewtopic.php?p=4436503).
- Controller onboarding (firmware/setup assistant, arpeggiator octave/gate/rhythm
  controls, scale/chord modes, standalone operation without a computer):
  [Novation — Using the Launchkey's built-in features](https://userguides.novationmusic.com/hc/en-gb/articles/27537167308562-Using-the-Launchkey-s-built-in-features),
  [Novation Launchkey MK3 User Guide (PDF)](https://fael-downloads-prod.focusrite.com/customer/prod/downloads/Launchkey%20MK3%20User%20Guide%20v6%20-%20EN.pdf).
- DAW recording/quantize/editing baseline and where Ableton/Bitwig diverge on
  MIDI editing depth (per-note modulation vs. speed-first note folding):
  [Unison — Bitwig vs Ableton](https://unison.audio/bitwig-vs-ableton/),
  [MusicTech — Bitwig Studio 6 vs Ableton Live 12](https://musictech.com/guides/buyers-guide/bitwig-studio-6-vs-ableton-live-12-which-daw-should-you-choose/).
- Project recall as a named, unsolved pain point in DAW UX (browsing old
  sessions by preview/metadata because the DAW itself doesn't help):
  [SessionDock — Find and Preview Your DAW Projects](https://sessiondock.com/),
  [UX Booth — Discovering the Table Stakes and Delighters](https://uxbooth.com/articles/discovering-table-stakes-delighters/).
- Modal overload and hidden state as named failure patterns, plus a concrete
  "which thing is actually playing" failure in a shipped music app:
  [NN/g — UI Modes and Modals](https://www.nngroup.com/videos/ui-modes-modals/),
  [Eleken — Mastering Modal UX](https://www.eleken.co/blog-posts/modal-ux),
  [Interaction Reimagined — Dangers of Modal User Interfaces](https://medium.com/interaction-reimagined/dangers-of-modal-user-interfaces-316828de8161),
  [Apple Community — Apple Music doesn't indicate what's playing](https://discussions.apple.com/thread/256299013).

---

## Scenario 1 — First sound out of a fresh load

**Persona**: someone who just opened the app with no project loaded and no
controller plugged in yet.

**Trigger**: curiosity — "what does this thing sound like."

**Steps expected**:
1. Load the app.
2. Click a key on the on-screen keyboard (or a drum pad).
3. Hear sound immediately.

Expected action count: **1** (after load) to first sound.

**Success criteria**: sound plays on the very first click, at a sane default
volume, with a visible indication of which instrument is live.

**Failure modes to watch for**: silent first click because
`AudioContext` needs a second user gesture the UI didn't ask for; the app
looks fully loaded but audio is suspended with no visible cue; default patch
is jarring (too loud, ugly default waveform).

**Priority**: table-stakes.

---

## Scenario 2 — Finding a specific kind of sound

**Persona**: someone who wants "something like a warm pad" and doesn't know
the instrument library yet.

**Trigger**: has an idea in their head, not a specific patch name.

**Steps expected**:
1. Open the instrument/patch browser (`Ctrl+I`).
2. Filter or scan by name/category.
3. Arrow through 3-5 candidates, each auditioning on highlight or on a key
   press, without closing the browser between tries.
4. Confirm selection; browser closes; the confirmed patch is what now plays.

Expected action count: **4-6**, all without a modal round-trip per candidate.

**Success criteria**: auditioning a candidate never requires closing and
reopening the browser; the sound that was playing during audition is exactly
the sound left active on confirm — no silent swap.

**Failure modes to watch for**: audition-vs-actual desync (the classic "two
selection concepts" bug pattern — a preview state that never syncs to the
real one); browser has no keyboard-only path and forces mouse scrolling
through a flat list; closing the browser stops sound entirely.

**Priority**: table-stakes.

---

## Scenario 3 — Playing the attached controller for the first time

**Persona**: someone who just plugged in the Synido TempoKEY K25 and has never
used it with this app.

**Trigger**: bought/borrowed the controller, wants it to just work.

**Steps expected**:
1. Plug in the K25.
2. Enable MIDI in the app / pick it from a device list (once).
3. Press a key — hear the currently selected instrument, not silence and not
   an error.
4. Try a pad — hear a drum voice.
5. Try a knob — see or hear something change (or a clear "unmapped" state,
   not nothing).

Expected action count: **2-3** beyond plugging in (enable MIDI, select
device, play).

**Success criteria**: keys, pads, pitch/mod strips, and transport buttons all
produce an observable effect the first time they're touched, without a
manual mapping step. Octave/transpose on the K25 (if it sends anything for
that) is reflected in the pitch actually heard.

**Failure modes to watch for**: MIDI permission/device selection is a hidden
prerequisite the user doesn't know to look for; pads send notes but nothing
maps them to drum voices; knobs are silently no-ops because CC mapping is
deferred (`specs/midi-control-surface.md` — Phase A is intentionally not
built) with no in-app message saying so; transport buttons on the controller
do nothing and give no feedback that they're unhandled.

**Priority**: table-stakes for keys/pads; expected (not blocking) for knobs
and transport, since this app deliberately defers full control-surface
mapping — but "does nothing, silently" is still a failure even when the
feature itself is out of scope.

---

## Scenario 4 — Holding a sound while tweaking it

**Persona**: someone with a key held down (sustain pedal or held note),
turning a knob to shape the sound in real time.

**Trigger**: wants to hear a parameter change against a sustained note, the
standard synth-programming loop.

**Steps expected**:
1. Hold a note (mouse, key, or controller + sustain pedal / CC64 hold).
2. Move a knob in the knob panel.
3. Hear the change immediately on the held note, not only on the next
   note-on.

Expected action count: **2** (hold, then turn).

**Success criteria**: parameter changes audibly affect the currently sounding
voice, not just future voices; releasing the note behaves normally
afterward.

**Failure modes to watch for**: knob changes only apply to notes triggered
after the change (common bug in voice-per-note architectures); sustain pedal
holds visually but the engine already released the voice; UI shows a value
change with no audible correlate, leaving the user unsure if it worked at
all.

**Priority**: expected.

---

## Scenario 5 — Recording a short musical idea

**Persona**: someone with a synth sound picked, wants to capture 8-16 bars
before they forget it.

**Trigger**: just found a good sound or riff, wants a take down now.

**Steps expected**:
1. Arm the track (or the transport is already record-ready in synth view).
2. Press record.
3. Play.
4. Press stop.
5. Hear the take play back immediately without an export/import round-trip.

Expected action count: **3** (arm/record, play, stop) — playback should be
free (no separate step).

**Success criteria**: what plays back matches what was heard while playing,
including timing; the take is visibly present afterward (in the arrangement,
or as a saved recording) — not silently discarded if the user forgets to
explicitly save.

**Failure modes to watch for**: unclear whether record is armed before
playing (transport ambiguity: pressing "record" when already recording, or
recording silently because MIDI wasn't routed to the armed track); latency
between what's played and what's captured is audible; closing the app or
navigating away loses the take with no warning.

**Priority**: table-stakes.

---

## Scenario 6 — Getting a drum pattern down

**Persona**: someone who wants a basic beat going, either via the 8x2 pads/
step sequencer or the TR-909 view.

**Trigger**: wants rhythm underneath the idea from Scenario 5.

**Steps expected**:
1. Open the drum surface (909 view, or step sequencer in synth view).
2. Pick a kit/kick+snare+hats sound set.
3. Click/tap steps for kick, snare, hihat across 16 steps.
4. Press play; pattern loops in time with the rest of the project tempo.
5. Adjust one step (accent, velocity, or remove) without losing the rest.

Expected action count: **~6-10** (one per placed hit plus play), which is the
expected floor for 16-step programming — not evaluated as a single-action
scenario the way sound-triggering is.

**Success criteria**: the pattern audibly locks to the same clock as
everything else in the project (no drift, no double-tempo confusion between
the 909 view and the main transport); editing a step doesn't require
re-entering the whole pattern.

**Failure modes to watch for**: two independent transports (909 internal
clock vs. project BPM) that can silently disagree; step edits require a
modal per step; accidentally clearing an entire pattern with no undo;
switching from 909 view back to synth/arrange stops playback without saying
why.

**Priority**: table-stakes.

---

## Scenario 7 — Comping a part in the piano roll

**Persona**: someone who recorded a keyboard part with timing mistakes and
wants a clean version.

**Trigger**: the live take was close but not right.

**Steps expected**:
1. Open the piano roll on the recorded clip.
2. Quantize (whole clip or selection).
3. Fix 1-3 wrong notes by dragging pitch/time.
4. Optionally record a second take and pick the better one (comping).
5. Play back to confirm.

Expected action count: **4-6** for a simple fix; comping across multiple
takes is inherently more, and that's expected, not a defect.

**Success criteria**: quantize strength is adjustable, not all-or-nothing;
edited notes look edited (visual diff from the original take) so a user
doesn't lose track of what they changed; playback reflects edits without a
manual "commit" step.

**Failure modes to watch for**: quantize snaps everything including
intentionally swung notes with no undo; dragging a note in the piano roll
doesn't audibly preview the new pitch; no comping/take-lanes at all, forcing
manual copy-paste between clips — acceptable to be absent (advanced
feature) but should not be *implied* by the UI.

**Priority**: comping itself is nice-to-have; basic quantize and note-drag
editing are table-stakes for anything calling itself a piano roll.

---

## Scenario 8 — Locking in a sound worth keeping

**Persona**: someone who spent 10 minutes turning knobs on a patch until it
sounded right, and doesn't want to lose it.

**Trigger**: happy accident while sound-designing.

**Steps expected**:
1. Notice the current sound is good.
2. Save/name it as a preset (distinct from just leaving it active on the
   current track).
3. Reopen the instrument browser later in the same session and find it by
   name.

Expected action count: **2** to save, **2-3** to retrieve later.

**Success criteria**: the saved preset reproduces the sound exactly (all knob
values, not a partial snapshot); it appears in the same browser used for
factory patches, not a separate hidden list.

**Failure modes to watch for**: no save path exists at all, so the only way
to "keep" a sound is to never touch another track (a real hidden-state trap);
saved preset silently omits some parameters (e.g. effects send) and sounds
different on recall; presets vanish on reload because they're session-only
state, not persisted with the project or a user library.

**Priority**: expected — hobbyist users hit this within the first session.

---

## Scenario 9 — Coming back to a project the next day

**Persona**: same person, a day later, reopening yesterday's project.

**Trigger**: wants to continue where they left off.

**Steps expected**:
1. Open the app / open the project (from a list or file picker).
2. See the same tracks, same instruments, same drum pattern, same mix levels
   as when they left.
3. Press play; it sounds the same as it did yesterday.
4. Find the custom sound from Scenario 8 still assigned and still playable
   live from the keyboard.

Expected action count: **1-2** (open project, press play).

**Success criteria**: nothing requires re-setup (re-picking instruments,
re-loading packs, re-arming MIDI); the project file alone is enough — no
reliance on the browser's local state (`localStorage`) that could be cleared
between sessions if that's the only persistence path.

**Failure modes to watch for**: instrument pack references saved but the pack
itself resolves to nothing (missing selections play back silently per
`specs/instrument-packs.md`, which is correct behavior but must be
*visible*, not silent); MIDI device has to be re-selected every load; mixer
levels or effect sends don't round-trip through save/load.

**Priority**: table-stakes.

---

## Scenario 10 — Recovering from silence

**Persona**: anyone, at any point, when they press play or a key and nothing
happens.

**Trigger**: an inevitable dead end — muted track, suspended audio context,
disconnected MIDI device, wrong channel routing.

**Steps expected**:
1. Notice nothing is audible.
2. Look for a reason without leaving the current view (mute indicator, level
   meter, connection status).
3. Fix the one likely cause (unmute, reconnect, pick correct channel).
4. Confirm sound is back within the same view.

Expected action count: **2-3**, ideally without opening a settings/debug
panel.

**Success criteria**: at least one always-visible signal (a meter, an
activity indicator, a mute/solo state) lets the user self-diagnose without
guessing; muted or soloed-elsewhere tracks are visually distinct from
working ones.

**Failure modes to watch for**: this is the canonical modal-overload /
hidden-state failure — the true cause (AudioContext suspended, MIDI
permission never granted, channel mismatch, a solo left on somewhere else)
has no visible surface at all, so the user's only tool is trial and error
across every panel in the app.

**Priority**: table-stakes — this is the failure mode research repeatedly
calls out as the most damaging because it has no natural end state; the user
just gives up.

---

## Scenario 11 — Bouncing a session to a file

**Persona**: someone finished a short arrangement and wants a WAV to share.

**Trigger**: idea feels done, wants to send it to someone.

**Steps expected**:
1. Trigger export/bounce (record-to-file or offline render).
2. Confirm scope (whole project vs. a loop range) if that choice exists.
3. Wait for render.
4. Get a file (download, or a save dialog in Electron).

Expected action count: **2-3**.

**Success criteria**: bounce matches what was heard during playback,
including levels and any master effects (reverb/compressor); the exported
file is easy to find (browser download or explicit save path in Electron),
not buried in a temp location.

**Failure modes to watch for**: bounce silently omits a track that was
playing live (e.g. a MIDI-only rack instrument that isn't part of the render
graph); render is real-time only with no progress indicator on a longer
project, making it look hung; secure-context-only APIs used for the
save/download path silently fail on the plain-HTTP LAN route with no
fallback message (this app's own documented constraint).

**Priority**: table-stakes for "download a WAV"; offline/faster-than-realtime
bounce and range selection are expected, not table-stakes.

---

## How to use this

Each scenario above is an **evaluation script**, not a feature backlog item —
do not read "Scenario 6" and go build a 909-clock-sync ticket from it in
isolation. To evaluate the app:

1. Pick a scenario. Actually perform the numbered steps in the real app (or
   a build under test), starting cold (fresh load, no prior state) unless
   the scenario says otherwise.
2. Count real actions against the expected count. A big gap either direction
   is a signal — too few and something was skipped or defaulted in a way
   that hides state; too many and something is friction.
3. Check the success criteria literally — they're pass/fail, not vibes.
4. If a failure mode fires, write down which one — the categories repeat
   across scenarios on purpose (transport ambiguity, hidden state, audition/
   actual desync, silent data loss) so a single fix often clears several
   scenarios at once.
5. Priority tells you what a failure means: table-stakes failing blocks
   ship; expected failing is a real bug to schedule; nice-to-have failing is
   a backlog note, not an incident.

This spec does not track phase/status the way the other `specs/*.md` files
do, because it isn't building anything — re-run it whenever a surface
changes enough that the old walkthrough no longer matches the UI.
