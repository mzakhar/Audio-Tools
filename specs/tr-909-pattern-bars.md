# TR-909 — Pattern bars and bar chaining

Status: spec, not built. Supersedes the dead `Pattern` dropdown at
`src/renderer/js/components/tr909-view.js:69`.

## Problem

The 909 view holds exactly one pattern, in component state
(`tr909-view.js:36`, `this.pattern = makePattern()`). It is never persisted, so
everything programmed is lost when the view unmounts or the app reloads. The
`Pattern` `<select>` renders four slots `A1–A4` and has **no event listener at
all** — it is cosmetic markup.

What is wanted:

1. Program several bars.
2. Copy the current bar into a new bar (the fast way to build a variation).
3. Play the whole chain of bars sequentially from the 909 screen.
4. See how many bars exist, as buttons rather than a dropdown.
5. While the chain plays, the current bar's button glows.

## Decisions taken

| Question | Decision |
|---|---|
| Bar length | Fixed 16 steps. `lastStep` stays a per-bar loop-length control. |
| Persistence | Yes — bars live in `ProjectStore.state.patterns`, schema 2 → 3. |
| Arrangement | Out of scope. Chain plays from the 909 screen only. Arrange clips referencing a `patternId` remain the 909 spec's Phase D. |

## Data model

`ProjectStore.state.patterns` is currently `{}` and reserved
(`ProjectStore.js:25`). The 909 claims one well-known key:

```js
state.patterns['909-main'] = {
  id: '909-main',
  name: '909',
  currentBar: 0,          // which bar the editor is showing
  chain: [0, 1, 1, 2],    // play order — indices into bars[]
  bars: [
    {
      id: 'bar-1-...',
      // everything that used to live on `this.pattern`, minus `name`
      scale: '1/16',
      shuffle: 0,
      flam: 0.18,
      lastStep: 16,
      totalAccent: 0.45,
      lanes: { bd: Step[16], sd: Step[16], ... }   // one entry per INSTRUMENTS id
    }
  ]
}
```

`Step` is unchanged: `{ on, velocity, accent, flam }`.

Notes on the shape:

- **Per-bar globals.** `shuffle`, `flam`, `lastStep`, `totalAccent` and `scale`
  live on the bar, not the pattern. A half-time fill with a different shuffle is
  the whole point of having bars; hoisting them to the pattern would forbid it.
  The existing global sliders edit the *current* bar.
- **`chain` is separate from `bars`.** A chain entry is an index, so a bar can
  repeat (`[0,0,0,1]`) without duplicating its lanes. Default chain is
  `[0, 1, ..., n-1]` — one pass per bar in order.
- **`kitParams` stays out.** Kit tuning is an instrument-level setting, not a
  per-bar one, and is not part of this spec. It stays in component state until
  a later persistence pass covers it.

## Store commands

Follow the existing command pattern (`label`, pure `execute(state) → next`,
deep-clone first, as in `SetModuleParam` at `ProjectStore.js:542`). One private
helper mirrors `rackCommand` (`ProjectStore.js:460`):

```js
function patternCommand(label, patternId, mutate)   // clone, ensure pattern exists, mutate, return
```

| Command | Behaviour |
|---|---|
| `SetPatternStep(patternId, barIndex, instrumentId, stepIndex, patch)` | Merge `patch` into one step. Covers on/off, velocity, accent, flam. |
| `SetBarParam(patternId, barIndex, key, value)` | One of `scale`, `shuffle`, `flam`, `lastStep`, `totalAccent`. |
| `AddBar(patternId, { copyFrom = null })` | Append a bar. `copyFrom` is a bar index → deep copy of that bar with a fresh `id`; `null` → empty bar. Appends its index to `chain`. |
| `RemoveBar(patternId, barIndex)` | Delete the bar, drop every `chain` entry pointing at it, and **decrement** every chain index above it. Refuses to remove the last remaining bar. |
| `SetCurrentBar(patternId, barIndex)` | Editor selection only. |
| `SetChain(patternId, chain)` | Replace the play order wholesale. |
| `ClearBar(patternId, barIndex)` | Reset all lanes of one bar to off. Replaces the current `Clear` button's behaviour. |

`SetCurrentBar` is a selection change, not an edit. It still goes through
`dispatch` for consistency, but it is the one command a reviewer should expect
to see churn the undo stack — if that gets annoying in use, make it a plain
non-undoable setter rather than special-casing the history.

### Migration

```js
if ((next.version ?? 1) < 3) {
  if (!next.patterns) next.patterns = {}
  next.version = 3
}
```

Bump `CURRENT_VERSION` to 3. No projects contain 909 data today, so migration
only has to guarantee the key exists. `Tr909View` creates `'909-main'` lazily on
first mount if absent.

## Playback

Today `play()` (`tr909-view.js:305`) builds a `LookaheadScheduler` over
`this.pattern.lastStep` and loops that one bar forever.

Two transport modes:

| Mode | Loop unit |
|---|---|
| **Bar** (default) | The current bar, looped — exactly today's behaviour. |
| **Chain** | Walk `chain` in order, wrapping at the end. |

Chain mode is a step-boundary concern, not a second scheduler. `scheduleStep`
already receives `(stepIndex, time)`; the only change is *which bar* it reads
lanes from:

- Keep a `playChainPos` cursor into `chain`.
- The scheduler's `steps` is the playing bar's `lastStep`. When the scheduler
  wraps from `lastStep - 1` back to `0` in chain mode, advance
  `playChainPos = (playChainPos + 1) % chain.length` **at schedule time, not at
  playhead time** — the audio thread is ahead of the display.
- `scheduleStep` resolves `bars[chain[playChainPos]]` and reads its lanes,
  shuffle, flam and accent from there.

Because bars can have different `lastStep`, the scheduler's step count must be
re-read per wrap rather than fixed at `start()`. **Verified**: `LookaheadScheduler`
(`src/renderer/js/rack/scheduler.js`) evaluates `this.steps` inside `tick()`
(`this.step = (this.step + 1) % this.steps`), so assigning
`schedulerLoop.steps = n` between wraps takes effect immediately. No getter
needed.

The assignment must happen **at `stepIndex === 0`, not at the last step of the
outgoing bar**. The wrap `(lastStep - 1 + 1) % steps` has to use the *outgoing*
bar's `lastStep` to land on 0; swapping `steps` before that increment gives
`lastStep % newSteps`, which is not 0 when the next bar is longer. So:
`scheduleStep(0, …)` advances `playChainPos` (except on the very first
scheduled step) and only then assigns the new bar's `lastStep` to
`schedulerLoop.steps`.

**Bar advance must be derived from scheduled time, not from the playhead RAF
loop.** The RAF loop (`tr909-view.js:365`) exists only to paint. It reads
`schedulerLoop.stepTimes` and compares against `ctx.currentTime`; it must also
learn which *bar* is currently sounding to drive the glow. Cheapest correct
approach: record `barAtStepTime[stepIndex]` alongside `stepTimes` when
scheduling, and have the RAF loop read the bar out of that array using the same
`bestStep` it already computes. No new timing source.

## UI

Replace the `Pattern` `<select>` block (`tr909-view.js:64–71`) with a bar strip:

```
BARS  [1] [2] [3] [+]        ⧉ Copy Bar     ▸ Bar  ▸ Chain   ■ Stop
```

- **Bar buttons** — one per entry in `bars[]`, numbered from 1. Click selects
  (`SetCurrentBar`). They are the visual count of saved bars, replacing the
  dropdown.
- **Two glow states, visually distinct**:
  - *selected* — the bar the editor is showing (persistent outline).
  - *playing* — the bar currently sounding in chain mode (animated/bright fill).
    They can be the same bar; the styles must compose, not overwrite.
- **`+`** — `AddBar` with `copyFrom: null`, an empty bar.
- **Copy Bar** — `AddBar` with `copyFrom: currentBar`, then select the new bar.
  This is the requested "copy the current bar into a new bar".
- **Remove** — shift-click or a small `×` on the button; guarded so the last bar
  cannot be deleted.
- **Transport** — `Play Bar` and `Play Chain` as separate buttons, sharing one
  `Stop`. Two buttons beat one mode toggle: auditioning the bar you are editing
  and hearing the whole arrangement are different intents and both are wanted
  constantly. Only one can be active; starting one stops the other.
- The `Clear` button now means `ClearBar(currentBar)`.

Accessibility: the bar strip is `role="toolbar"`, buttons carry
`aria-pressed` for selection and `aria-current="true"` for the playing bar.

### Rendering

`Tr909View.render()` currently rebuilds the entire innerHTML. Do **not** call
it on every playhead frame or bar advance — the glow update belongs with
`updatePlayhead()` (`tr909-view.js:388`), toggling a class on the bar buttons.
Full re-render is fine on bar add/remove/select.

## Store subscription

`Tr909View` reads its pattern from `ProjectStore.getState().patterns['909-main']`
and subscribes for external changes (undo/redo). Re-render on subscription fire
**only if the pattern object actually changed** — the store notifies every
listener on every dispatch, including unrelated mixer moves, and a full
innerHTML rebuild on each would kill step-button interaction. Compare by
reference against the last-seen pattern.

## Test plan

Store commands are pure, so they test directly — no DOM, matching how the rack
commands are covered.

| Test | Asserts |
|---|---|
| `AddBar` with `copyFrom` | new bar's lanes deep-equal the source, `id` differs, mutating one does not touch the other |
| `AddBar` empty | all steps `on: false`, appended to `chain` |
| `RemoveBar` middle index | chain entries above it decrement, entries pointing at it vanish |
| `RemoveBar` last remaining | state unchanged |
| `SetPatternStep` | only the addressed step changes |
| `migrate` from v2 | `patterns` exists, `version === 3`, existing tracks/racks untouched |
| chain cursor | pure helper `nextChainPos(pos, chainLength)` wraps correctly |

Playback timing is not unit-tested here; the existing scheduler tests cover the
lookahead itself.

## Out of scope

- Pattern banks (multiple named patterns beyond `'909-main'`).
- Arrangement clips referencing a pattern — 909 spec Phase D.
- Persisting `kitParams`.
- Per-bar tempo or time signature.
