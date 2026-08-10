# Shared transport header

Status: spec, not built.

## Problem

BPM, master volume and transport are scattered and inconsistent. What exists
today:

| Control | Where | Element | Wiring |
|---|---|---|---|
| BPM (slider) | synth view, bottom of `#sequencer-section` | `#bpm-slider` | `app.js:291` `initBPM()` |
| BPM (number) | arrange toolbar | `#arr-bpm` | `app.js:710` `initArrangeTransport()` |
| Master volume | synth `#header` only | `#master-vol` | `app.js:268` `initMasterVolume()` |
| Transport | synth `.transport` | `#play-btn` `#stop-btn` `#clear-btn` | `app.js:738` |
| Transport | arrange toolbar | `#arr-play-btn` `#arr-stop-btn` | `app.js:673` |
| Transport | 909 view | rendered inside `tr909-view.js:58` | component-local |

Consequences: BPM is two different input types bound to the same
`ProjectStore.state.bpm`; the rack view has no BPM or volume at all; master
volume disappears when you leave the synth view; and the play button physically
moves depending on which tool is open.

## Design

One header row, `#global-header`, placed inside `#main` **above** `#project-bar`,
visible in every view:

```
#main
  #global-header    ← BPM | master volume | transport | (view-specific slot)
  #project-bar      ← project/audio/MIDI/bounce — unchanged
  #arrange-view / #rack-view / #app
```

Contents, left to right:

- **BPM** — one control for all views. Number input (`#arr-bpm`'s type), not a
  slider: typing `128` is the common action and a slider cannot do it.
  Range 40–240. Writes `ProjectStore.dispatch(SetBpm(v))`.
- **Master volume** — the existing `#master-vol` range plus `#master-vol-display`,
  moved verbatim out of `#header`.
- **Transport** — `Play` / `Stop`. These stay **mode-aware**: `app.js:738`
  already branches on the active tool to drive `Sequencer` vs `TimelinePlayer`;
  that dispatch logic moves to the shared buttons unchanged.
- **View slot** — an empty `<div id="header-view-slot">` for controls that are
  genuinely view-specific. The 909 bar strip is the first tenant.

## What gets removed

- `#bpm-slider`, `#bpm-display` and the `.bpm-group` wrapper in
  `#sequencer-controls`.
- `#arr-bpm` and its label from `#arrange-toolbar`.
- `#master-vol-wrap` from `#header` (the element moves, it is not rebuilt).
- `#arr-play-btn` / `#arr-stop-btn`; `#arrange-toolbar` keeps only what is
  actually arrange-specific.
- The synth `.transport` keeps `Clear` and `+ Track` — those are sequencer
  actions, not transport — and loses `Play`/`Stop`.

`initBPM()` and `initArrangeTransport()` collapse into one `initGlobalHeader()`.

## What does *not* move

- **909 transport stays in the 909 view.** The 909 has two play modes (bar and
  chain, per `tr-909-pattern-bars.md`) and a global two-button transport cannot
  express that. The shared `Play` is a no-op — greyed with a tooltip — while the
  909 palette is active, or it maps to `Play Chain`. Pick one during
  implementation and be consistent; do not render a live global Play that
  silently does nothing.
- `#project-bar` contents. Project open/save, audio import, MIDI and bounce are
  not transport and stay where they are.
- Per-channel mixer volume. Unrelated to master.

## No component abstraction

The header is static markup in `index.html` wired once in `app.js`, matching how
`#project-bar` and `#arrange-toolbar` already work. There is exactly one header
and there will not be a second, so a `Header` component class with a `mode`
prop would be one implementation behind an interface. Show/hide the view slot's
contents; do not build a renderer.

## BPM as the single source

`ProjectStore.state.bpm` is already the source of truth (`ProjectStore.js:17`,
`SetBpm` at `:108`), but `Sequencer` also holds a BPM (`Sequencer.setBPM`, read
by `tr909-view.js:361` via `Sequencer.getBPM()`). The header writes to the
store; the store subscription pushes into `Sequencer.setBPM()` in one place.
Anything that reads tempo keeps reading whichever of the two it reads today —
this spec does not unify the readers, only the writers. Removing
`Sequencer`'s copy is a separate cleanup.

Verify while implementing: with the header BPM changed mid-playback, both the
sequencer and the 909 step duration follow. `tr909-view.js:361` recomputes
`stepDuration()` per step, so it should — confirm rather than assume.

## Layout / CSS

- `#global-header` is a flex row, same visual weight as `#project-bar`
  (reuse its border/background tokens rather than inventing new ones).
- Reuse existing classes: `.transport-btn`, `.knob-label`, `.knob-val`. No new
  button styling.
- Narrow widths: the view slot wraps below the shared controls. The header must
  not push the arrangement canvas off-screen.

## Test plan

Mostly manual — this is markup movement, and there is no DOM test harness for
`app.js` today.

1. BPM change in synth view → arrange playback tempo matches.
2. BPM change in arrange view → 909 step duration matches.
3. Master volume is present and functional in all four views (synth, 909,
   arrange, rack).
4. Play/Stop drive the sequencer in synth view and the timeline in arrange view,
   as they do now.
5. Switching views does not reset BPM or volume.

## Order of work

Land this **before** the 909 bar strip. The bar strip wants the header's view
slot, and doing the header second means moving the strip twice.
