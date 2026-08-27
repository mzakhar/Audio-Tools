# MIDI Control Surface — deferred

**Status: not planned. Do not build any of this without a fresh decision.**

Stashed so the research is not lost. A Synido TempoKEY K25 arrived (25 keys, 8×2
pads, 8×2 knobs, bend/mod strips, 6 transport buttons, onboard ARP). Its
*playing* surface is covered elsewhere; what lives here is the part that turns
the app into a control-surface host — knob mapping, transport buttons, a monitor,
clock sync. That is a DAW feature, and this app is not trying to be a DAW.

| Phase | State |
|---|---|
| A — CC learn map | deferred |
| B — Transport buttons | deferred |
| C — MIDI monitor | deferred |
| D — Clock in / out | deferred (clock in is also `specs/midi-bridge.md` Phase 4) |

## What is NOT deferred

These are playability, not control surface, and belong to the normal MIDI path:

| Item | Home |
|---|---|
| Sustain pedal, CC64 hold | `specs/midi-bridge.md` |
| Pitch bend + mod wheel reaching pack and palette voices, not only racks | `specs/midi-bridge.md` |
| Channel aftertouch `0xD0` / poly aftertouch `0xA0` parsing | `specs/midi-bridge.md` |
| Pads playing the selected instrument | `specs/instrument-browser.md` |

## Trigger to revisit

Build a phase here only when a concrete need exists, not because the hardware has
the button:

- **A** — when a knob move has a destination worth reaching for mid-take and the
  mouse is genuinely in the way.
- **B** — when transport-by-mouse actually interrupts recording takes.
- **C** — when a mapping bug takes more than one session to find.
- **D** — when the onboard arpeggiator is used against project tempo and the drift
  is audible.

---

## A — CC learn map

Pure module `src/renderer/js/midi/midi-map.js`:

```js
// map: { [`${channel}:${cc}`]: target }
// target: 'mixer.<channelId>.volume' | 'mixer.<channelId>.pan'
//       | 'track.<trackId>.<paramKey>' | 'rack.<rackId>.<moduleId>.<paramKey>'
export function applyCc(map, event)        // -> { target, value01 } | null
export function learn(map, event, armed)   // -> next map (pure)
```

Rules that matter:

- The map is **project state**, schema-versioned like everything else in
  `ProjectStore`. A controller map that does not survive save is a toy.
- Learn is arm-a-target-then-move-a-knob, never move-then-pick. The reverse
  ordering makes an idle LFO-driven CC steal the mapping.
- One CC may drive one target. Re-learning a mapped CC replaces it and says so.
- Values arrive 0–127; the map stores min/max per target so a knob's own range
  limits (the K25 has them per knob) never have to be understood by the app.

Knobs may also be configured on the device as channel aftertouch or pitch bend.
That is a parser gap, listed above as not-deferred.

## B — Transport buttons

K25 factory CC map, transport set to CC mode:

| CC | Button | Action |
|---|---|---|
| 114 | Rewind | playhead to zero (no scrub) |
| 115 | Fast forward | +1 bar |
| 116 | Play/Pause | toggle transport |
| 117 | Stop | stop |
| 118 | Loop | toggle loop |
| 119 | Record | toggle MIDI record arm |

- **Opt-in, default off.** An app that starts playing because a foreign device
  sent CC116 is a support ticket — same rule as external clock.
- **MMC is out of scope.** The device can send MMC instead, but MMC is SysEx and
  `MidiController.requestAccess()` asks for `{ sysex: false }` deliberately.
  Widening the permission prompt for six buttons is a bad trade. Document
  "set the K25 transport to CC mode" instead.

## C — MIDI monitor

A read-only list of the last ~50 parsed events: timestamp, channel, type, data,
and the resolved destination (`→ Lead cutoff`, `→ unmapped`). Filters for
notes / cc / bend / clock / unmapped-only.

Cheap and the only thing that makes A and B debuggable. If any phase here is
built first, build this one.

## D — Clock

- **Clock in** — follow an external clock. Already specced as
  `specs/midi-bridge.md` Phase 4, opt-in, `estimateBpm` pure with an outlier
  guard.
- **Clock out** — send `0xF8` at 24 ppq plus start/stop so the K25's onboard
  arpeggiator and note repeat lock to project tempo. This is the more useful
  direction for this device: the app stays master, and the ARP stops
  free-running against its own tap tempo.

Needs `MIDIOutput` handles, which `MidiController` does not enumerate today
(`specs/midi-bridge.md` Phase 5).

## Constraint that applies to all of it

Web MIDI is secure-context only. None of this exists on the LAN route
(`http://themachine/synth/`) — only in Electron and on
`https://synth.zakharhome.org`. Nothing here may sit on the critical path of
core audio or of the UI shell.
