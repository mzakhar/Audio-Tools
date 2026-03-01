# Audio Tools — Browser Synthesizer

A browser-based synthesizer with a 16-step sequencer and WAV recorder. No build step, no dependencies — open `index.html` directly.

## Features

- **4 synthesis engines:** Classic (subtractive), FM, Drum Machine, Pad/Ambient
- **On-screen piano** (C3–C5, 25 keys) with mouse, touch, and PC keyboard support
- **16-step sequencer** with per-track palette and note assignment, variable BPM
- **WAV recorder** — captures the final mixed output as a stereo 16-bit PCM WAV for DAW import

## PC Keyboard Mapping

| Keys | Notes |
|------|-------|
| `a w s e d f t g y h u j` | C3–B3 (white + black) |
| `k o l p ; ' ] z [ x - c v` | C4–C5 |
| `1 2 3 4` | Kick / Snare / Hi-Hat / Clap (Drum mode) |

## Recording

1. Click **● REC** — audio capture begins immediately
2. Play keys or run the sequencer
3. Click **■ STOP & SAVE** — a `.wav` file downloads automatically

## Sequencer

Each track independently selects a palette (CLSC / FM / DRUM / PAD) and a note or drum voice. Click cells to toggle steps. The playhead highlights the current step in real time.

- **+ Track** adds a new track
- **✕ Clear** clears all steps across all tracks
- BPM range: 40–220
