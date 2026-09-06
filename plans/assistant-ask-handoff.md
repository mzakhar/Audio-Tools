# Phase 6 — ask mode: handoff

## Files changed

- `src/shared/daw-assistant/ask.js` (new) — pure module, no DOM/context/globals.
  Exports `MODES`, `MAX_ANSWER`, `MAX_CITED`, `MAX_CITED_LEN`,
  `validateAnswerShape(answer)`, `resolveCitation(digest, path)`,
  `resolveCitations(digest, cited)`.
- `src/web-discovery/index.js` — reads `payload.mode` (default `'plan'`),
  validates against `MODES` (400 before any provider call), factored the
  fetch/timeout/parse plumbing into `assistantModelCall(...)`, added
  `ASSISTANT_ASK_INSTRUCTIONS` / `ASSISTANT_ASK_SCHEMA` (only `answer` +
  `cited`, no `actions` property), validates the model's ask output with
  `validateAnswerShape`, responds `{ answer, cited }`. Existing plan path
  behavior and 424 mapping unchanged.
- `src/renderer/js/components/assistant-dialog.js` — added `postAnswer()`
  (mirrors `postPlan`, sends `mode: 'ask'`; `postPlan` now sends
  `mode: 'plan'` too), `AssistantDialog.ask` seam (default `postAnswer`,
  swappable like `this.propose`), an Ask button created next to Propose,
  `runAsk()`, and `showAnswer(result, digest)` which renders the answer text
  plus one row per citation resolved via `resolveCitations` against the
  digest that was actually posted. `showAnswer` always routes through
  `showPlan(null)` first, so `this.plan` is null and `applyBtn.disabled` is
  true — `runApply()`'s existing `if (!this.plan) return` guard makes
  `applyPlan` unreachable from an ask result.
- Tests: `tests/daw-assistant-ask.test.js` (new, pure module), additions to
  `tests/daw-assistant-route.test.js` (ask-mode `describe` block) and
  `tests/daw-assistant-dialog.test.js` (ask-mode `describe` block).

## Public API surface added

- `src/shared/daw-assistant/ask.js`: `MODES`, `MAX_ANSWER`, `MAX_CITED`,
  `MAX_CITED_LEN`, `validateAnswerShape`, `resolveCitation`,
  `resolveCitations`.
- `AssistantDialog` gains a `deps.ask` constructor option (same seam pattern
  as `deps.propose`) and a public `askBtn` property; `postAnswer` is an
  internal (unexported) module function, matching `postPlan`.

## Decisions / deviations

- **Ask button DOM.** The brief lists only `assistant-dialog.js` (not
  `index.html`) as owned for this task, and index.html has no `#asst-ask-btn`
  today. Rather than touch a file outside scope, `assistant-dialog.js`
  queries for `#asst-ask-btn` and, if absent, creates it as a `<button>`
  cloning `proposeBtn`'s class and inserts it immediately after Propose in
  the DOM. If a later phase adds the button to `index.html` directly, this
  code no-ops (queries find the real element instead of creating one) — no
  duplicate button. **Flagging this**: the shipped `index.html` does not yet
  have a static Ask button; it is created at runtime by this file. If a
  separate design pass wants Ask styled/positioned differently in markup,
  update `index.html` and this constructor's fallback becomes a no-op
  automatically.
- **Ask response shape**: server responds `{ answer, cited }` where `cited`
  is the array of *paths* the model named — not pre-resolved values. Citation
  resolution against the digest happens client-side in
  `AssistantDialog.showAnswer` via `resolveCitations`, using the exact digest
  object that was posted (kept as a local variable in `runAsk`), per the
  brief's "value shown to the user always comes from our digest" rule.
- **Citation path pattern**: `^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$`, capped at
  120 chars per entry, 12 entries total — deliberately conservative (no
  brackets/wildcards), matches the brief's example paths
  (`tracks.0.mute`, `mixer.2.volume`, `bpm`).
- Did not touch `digest.js` or `plan.js` at all (no import was needed).

## Deferred / out of scope

- `index.html` static markup for the Ask button (see above) — left to
  whichever pass next touches the assistant dialog's shipped markup.
- Phase 5 (`SetInstrumentParam`) and phase 7 (`SetTrackInstrumentProgram`,
  pack patch digest fields) are untouched, per brief.

## Verify

`npm test` — 97 files / 1257 tests, all green (includes concurrent phase-5
work by another agent touching `palettes.js`/`assistant-dialog.js` test
expectations around `instrument.params`; not this task's changes, not
touched here beyond what the shared test file already had).
