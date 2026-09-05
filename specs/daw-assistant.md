# DAW Assistant — edit the project by describing the edit

A person types "give the kick track a shorter decay and put a four-on-the-floor
in bar 2" and the app proposes a concrete, reviewable list of edits to the open
project. Nothing changes until they click **Apply**, and one **Undo** puts it
all back.

This is a *control* assistant, not a generator. It does not synthesize audio, it
does not write files, and it does not talk to the outside world on the user's
behalf. It reads a bounded digest of the current project and returns a plan
expressed entirely in commands `ProjectStore` already has.

It is a sibling of `specs/music-discovery-agent.md`, not an extension of it.
Discovery finds *existing sound* on the open web; this assistant changes *the
project in front of you*. They share the deployed proxy, the Cloudflare Access
gate, and the "the model proposes, our code decides" posture — and nothing else.

---

## Status

| Phase | State |
|---|---|
| 0 — plan contract, digest, batch history | shipped |
| 1 — web route on the existing proxy | shipped |
| 2 — assistant dialog, preview, apply | shipped |
| 3 — Electron parity via existing provider connections | proposed |
| 4 — conversation, follow-ups, audio-aware suggestions | deferred |

Settled: web ships first, because the deployed app is where this is wanted and
Cloudflare Access already protects the whole host. Electron follows using the
provider connections it already stores.

## What already exists

Nothing here is new infrastructure. The pieces this leans on are deployed and
tested today:

| Piece | Where | State |
|---|---|---|
| Access-gated Node proxy | `src/web-discovery/` | deployed, 4-key secret, leads PVC |
| Access JWT verification | `src/web-discovery/index.js:29` | reusable as-is, runs before every allowed route |
| Per-identity rate limit | `src/web-discovery/index.js:145,169` | exists, but scoped to one route only |
| Route allowlist | `src/web-discovery/index.js:160` | unknown paths 404 before any work |
| Command surface | `src/renderer/js/store/ProjectStore.js` | ~50 commands, all `{ label, execute }` |
| Undo/redo | `ProjectStore.js:861-904` | whole-state snapshots, `MAX_HISTORY = 100` |
| Cloudflare Access app | `synth.zakharhome.org` + `/api/music-discovery` | Family OIDC policy, 24 h session |

Two of those need a small change before an assistant route can exist at all; see
phase 1.

## Product decisions

- **Propose, then apply.** The assistant's output is a *plan*: an ordered list of
  actions, each rendered in plain language with its target named. A person reads
  it and clicks Apply. There is no auto-apply mode, no "just do it" toggle, and
  no background editing.
- **One plan is one undo.** Applying a nine-action plan must be reversible with a
  single `Ctrl+Z`. `ProjectStore` has no batching primitive today, so phase 0
  adds one. Nine history entries for one sentence would make the feature worse
  than editing by hand.
- **The model never sees the project.** It sees a *digest* — a capped, redacted
  projection with ids, names, counts, and the handful of values an edit needs.
  No audio, no sample data, no file paths, no pack binaries, no provider state.
- **Actions are a fixed allowlist, not the whole store.** The store exports
  destructive wholesale commands (`LoadRackPatch`, `RemoveRack`) that no plan
  needs. The assistant's vocabulary is smaller than the store's on purpose, and
  grows only when a real request needs it.
- **Failure is a rejected plan, never a partial edit.** If any action fails
  validation, the whole plan is refused with the reason shown. Half-applied plans
  are worse than no plan.
- **No new dependency, no new service.** The route joins the running proxy. The
  renderer talks to it same-origin, so `connect-src 'self'` stands unchanged.

## Non-negotiables

A reviewer should reject a pull request over any of these.

- **The model's only privileged output is a schema-valid `Plan`.** Prose outside
  the schema renders as a note above the plan. No model output — no field, no
  string, no ordering — ever reaches `ProjectStore.dispatch` without passing
  `validatePlan` against the *current* state.
- **Action names are matched against a literal allowlist.** An unrecognised
  action name fails the whole plan. There is no dynamic lookup from a model
  string into the command module, ever — that is how a control assistant turns
  into arbitrary code execution against the store.
- **Arguments are re-validated at apply time, not just at propose time.** The
  user may edit the project between reading a plan and applying it. Ids are
  re-resolved against live state; a plan naming a deleted track is refused whole.
- **`Connect` runs `canConnect` first.** `ProjectStore.js:673` checks existence,
  self-patch and duplicates — it does **not** check port direction or signal
  kind. `rack/modules/index.js` `canConnect` is the only thing that does, and
  the assistant path must call it, exactly as `rack-view.js` does. A plan may not
  create a cable the UI could not.
- **`SetMixerParam` gets a key allowlist here.** `ProjectStore.js:322` writes
  `channel[param] = value` with no key check. Model-supplied `param` reaches an
  object key, so the assistant layer constrains it to
  `volume | pan | mute | solo` with per-key ranges before dispatch.
- **The digest is capped before it is built, not truncated after.** Ceilings on
  tracks, clips, notes, modules, cables and string length belong to the digest
  builder. A large project produces a smaller digest, never a larger request.
- **A run is bounded by the orchestrator.** One model request per plan. No tool
  loop, no retry on a costlier model, no follow-up call the user did not ask for.
  Ceilings on actions per plan, output tokens, request body and wall time are
  constants in our code, not fields the model can influence.
- **Every route on the proxy is rate limited per identity.** The current limiter
  guards one branch. Adding a route that skips it publishes an unmetered spend
  endpoint to every family member.
- **No provider secret reaches the renderer.** The key stays in the cluster
  Secret for web and in `safeStorage` for Electron, exactly as discovery does it.

## Threat model

Discovery's risk is that hostile *content* comes back from the open web. This
feature inverts it: the input is the user's own project, but the output *acts on
their data*. The exposures are different and both are real.

- **Prompt injection via project content.** Track names, rack module names and
  pack titles are attacker-influenced whenever a project or a SoundFont came from
  someone else. They are data inside the digest, never instructions, and the
  digest is sent as a JSON document in a user-role message, never concatenated
  into the system prompt.
- **Destructive plans.** A plan that clears every bar and removes every track is
  schema-valid. Mitigations are structural: preview before apply, one-step undo,
  no wholesale commands in the allowlist, and a cap on actions per plan.
- **Key-shaped arguments.** `SetMixerParam` and `SetModuleParam` write
  model-supplied strings as object keys. The first gets an allowlist; the second
  is constrained to keys the target module type actually declares, resolved from
  the module registry, not from the model.
- **Spend.** The key is server-held and the app is family-accessible, so an
  unmetered route is a shared bill. Rate limiting is part of the route, not a
  follow-up to it.

Filtering hostile strings is not a mitigation and is not treated as one.

## Contracts — phase 0

New pure modules under `src/shared/daw-assistant/`, no DOM, no context, no
globals — the same discipline `src/shared/music-discovery/contracts.js` follows.

```js
buildDigest(state)                       // capped, redacted projection of ProjectStore state
validatePlanShape(plan)                  // structure only: names, arg types, ranges, caps
validatePlan(plan, state, capabilities)  // the above, plus live ids and rack legality
describeAction(action, state)            // -> human sentence for the preview row
planToCommands(plan, state)              // -> ProjectStore command objects, in order
```

The split exists so that `src/shared/` imports nothing from `src/renderer/`. The
rack module registry and `canConnect` live in `rack/modules/index.js`, whose
definitions belong to the renderer; a Node service must not pull them in. So the
server runs `validatePlanShape` — everything checkable without project state —
and the renderer runs the full `validatePlan` at apply time, injecting what it
knows:

```js
capabilities = { moduleTypes, moduleParamKeys(type), canConnect(rack, from, to) }
```

Dependencies are passed, never imported into the core. Both validators are pure.

`planToCommands` does not import `ProjectStore` either — that module has import
side effects (its singleton state and listener set). It returns descriptors,
`[{ factory: 'SetBpm', args: [128] }]`, and the renderer binds `factory` through
its own literal map. Actions that mint an id (`AddClip`, `AddMidiNote`) take an
injected `makeId` rather than deriving one from state counts, so two applies
against one stale digest cannot collide.

### Digest

```js
{
  bpm, timeSignature,
  tracks: [{ id, name, type, instrument: { type, paletteKey?, rackId?, packId? },
             midiChannel?, clipCount, clips: [{ id, startBeat, duration, noteCount }] }],
  mixer:  [{ id, trackId, volume, pan, mute, solo }],
  racks:  [{ id, name, modules: [{ id, type, rail, hp, bypassed, params }],
             cables: [{ id, from, to }] }],
  patterns: [{ id, name, barCount, currentBar, chain,
               bars: [{ lastStep, scale, lanes: { kick: '1000100010001000', ... } }] }]
}
```

Caps: 32 tracks, 32 clips per track, note *counts* rather than notes, 64 modules
and 64 cables per rack, 8 bars per pattern, 64 characters per name. Step lanes
collapse to a 16-character on/off string — the shape a model reasons about well
and a fraction of the tokens of 16 objects. Anything past a cap is dropped and
the digest records that it was, so the model can say it only saw part.

### Plan

```js
{
  summary: 'string, <= 240 chars, shown above the preview',
  actions: [{ action: 'SetBpm', args: { bpm: 128 } }, ...]   // <= 24
}
```

### Action allowlist

| Group | Actions |
|---|---|
| Session | `SetBpm` |
| Tracks | `AddTrack`, `RemoveTrack`, `SetTrackInstrument`, `SetTrackMidiChannel` |
| Clips | `AddClip`, `RemoveClip`, `MoveClip`, `DuplicateClip`, `TileClip` |
| Notes | `SetMidiClipNotes`, `AddMidiNote`, `RemoveMidiNote` |
| Mixer | `SetMixerParam`, `SetSendLevel` |
| Effects | `AddEffect`, `RemoveEffect`, `SetEffectParam` |
| Pattern (909) | `SetPatternStep`, `SetBarParam`, `ClearBar`, `AddBar`, `SetChain` |
| Rack | `AddModule`, `RemoveModule`, `MoveModule`, `SetModuleParam`, `SetAttenuverter`, `SetModuleBypass`, `Connect`, `Disconnect` |

Deliberately excluded: `AddRack`, `RemoveRack`, `LoadRackPatch`,
`SetTrackInstrumentProgram`, `SetCableColor`, `SetRackRails`, `RenameRack`,
`SetCurrentBar`, `RemoveBar`, `SetBusReturn`, and every clip/note command not
listed. Each is either wholesale-destructive, subtle enough to need its own
review (pack program resolution), or cosmetic. Add one when a real request needs
it, with a test.

Per-action validation beyond "the id exists": `SetMidiClipNotes` caps notes per
clip and clamps pitch to 0-127, velocity to 0.01-1, duration to >= 0.0625.
`AddModule` accepts only registered module types. `SetModuleParam` accepts only
keys the target module's definition declares. `SetPatternStep` accepts only
instrument ids present in the bar's lanes.

### Batch history

`ProjectStore` gains one method:

```js
dispatchBatch(commands, label)   // executes in order, pushes ONE history entry
```

It reuses the existing snapshot mechanism (`_undoStack`, `MAX_HISTORY`): capture
`_state` once, run every `execute` in sequence, push a single
`{ command: { label }, prev }`, notify once. If any `execute` throws, the whole
batch is abandoned and `_state` is untouched. Existing `dispatch` is unchanged;
the per-command `undo()` stubs stay as dead as they are today.

Tests: an unknown action name fails the plan; a plan naming a deleted track fails
at apply time even though it passed at propose time; a backwards cable is
refused; `SetMixerParam` with `param: '__proto__'` is refused; a 40-action plan
is refused; a nine-action plan produces exactly one undo entry and one notify; a
digest built from a 200-track project stays under the cap and is marked
truncated.

## Phase 1 — the web route

The plan is produced server-side, because that is where the key is.

```
POST /api/assistant      { prompt, digest }  ->  { plan } | { error }
```

Changes to `src/web-discovery/`:

1. Add `/api/assistant` to the route allowlist at `index.js:160`.
2. Lift the sliding-window limiter (`index.js:145,169-172`) out of the discovery
   branch so it runs for **every** authenticated route, keyed by identity and
   route. `/leads` gains rate limiting it should already have had.
3. One OpenAI Responses request, `json_schema` response format, output tokens
   capped, 20 s timeout (longer than the 15 s discovery review — plan output
   runs longer) — matching the discipline already in
   `openai-compatible.js:32`, and preferably by extracting that call rather than
   writing a third copy of it.
4. Validate the returned plan with the shared `validatePlanShape` before
   responding, so a malformed plan never reaches a browser. The server has no
   project state and the rack registry is renderer-only (see "Contracts —
   phase 0"), so it cannot run the full `validatePlan` — that happens in the
   renderer at apply time.
5. Clamp the client-supplied `digest` with `clampDigest` (reapplying the same
   caps `buildDigest` used) before it reaches OpenAI, so a stale or hostile
   client cannot inflate a paid request past what a real digest costs.

The digest is built in the renderer and posted up. The server does not hold
project state, does not persist prompts or plans, and logs neither.

Deploy changes:

- `deploy/k8s/discovery-ingress.yaml:11` — broaden the Prefix from
  `/api/music-discovery` to `/api`. Without this the new path falls through to
  `synth-external` and is served by the static nginx as a 404. The service 404s
  unknown paths at its own allowlist, so broadening exposes nothing new.
- **No Cloudflare change.** The Access app already lists `synth.zakharhome.org`
  itself as a destination, so `/api/assistant` inherits the Family OIDC policy
  and the same `CF_ACCESS_AUD`. The existing `/api/music-discovery` destination
  entry becomes redundant; leaving it costs nothing.
- **No new secret key.** `OPENAI_API_KEY`, `CF_ACCESS_AUD` and
  `CF_ACCESS_TEAM_DOMAIN` in the `synth-discovery` Secret are exactly what the
  route needs.
- The service name stays `synth-discovery` even though it now serves two
  features. Renaming a deployed service to make a name read better is not worth
  a fleet migration; revisit only if a third feature lands.

The LAN route `http://themachine/synth/` is excluded, as it is for discovery: it
is not a secure context and it does not carry an Access identity.

## Phase 2 — the dialog

Per `specs/ui-shell.md`, this is a native `<dialog>` reached from the `⋯` menu
and a shortcut, not a new bar or rail. A control earns permanent screen space
only if it changes while you play; this one does not.

- A prompt field, a **Propose** button, and the plan preview.
- The preview lists one row per action, each a sentence from `describeAction`
  naming the real target ("Set BPM to 128", "Add a LFO to Rack 1, rail 2"), plus
  the model's summary above it.
- **Apply** dispatches the batch. **Discard** closes. Nothing else applies.
- After Apply, a line states what changed and that `Ctrl+Z` reverses it.
- Rack-affecting plans call `RackEngine.update` through the existing
  `rack-view.js` subscription, which already runs on every store change — the
  assistant adds no second path into the audio graph.
- With no assistant route reachable, the menu item is absent, matching the
  posture discovery takes when no provider is configured.

## Phase 3 — Electron parity

Electron already stores named provider connections with keys in `safeStorage`
(`src/main/music-discovery/connections.js`). Assistant reuses them through a
narrow `dawAssistant:propose` IPC method beside the existing
`musicDiscovery:*` ones. The shared plan contract and the renderer dialog do not
change; only the transport does.

## Phase 4 — deferred

Multi-turn conversation and follow-up refinement; the assistant listening to
rendered audio; automatic re-planning when a plan is rejected; plan templates or
saved macros; anything that edits without a person clicking Apply.

## Verification

```sh
npm test
```

Manual, deployed:

1. Open `https://synth.zakharhome.org` in a browser with a valid Access session.
2. Propose "make a four-on-the-floor kick pattern at 128 BPM". Confirm a plan
   renders with named targets and nothing has changed yet.
3. Apply. Confirm the pattern and BPM changed, and that one `Ctrl+Z` reverses
   the whole plan.
4. Delete a track named in a pending plan, then Apply it. Confirm the plan is
   refused whole with a reason, and nothing partially applied.
5. Confirm an unauthenticated request to `/api/assistant` is refused before any
   provider call — check this before checking anything the route returns.
6. Confirm rapid repeated proposals hit the per-identity limit with a 429.
7. Confirm devtools shows no provider key and no request to any host but the
   app's own origin.
