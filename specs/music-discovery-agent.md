# Music Discovery Agent — find the right existing sound, then make it usable

Synth should help a person locate a soulful vocal/chop for hard house or a
credible indie-rock drum pack without pretending it made the music. This is a
research, comparison, and handoff workflow over existing music assets. It does
not generate audio, compose a track, or download anything without a person
approving it.

It complements `specs/instrument-packs.md` (installation and playback),
`specs/soundfont-library.md` (searching local SoundFonts), and the Library
dialog in `specs/ui-shell.md`.

---

## Status

| Phase | State |
|---|---|
| 0 — contracts and settings | proposed |
| 1 — brief to researched shortlist | proposed |
| 2 — review, provenance, and Library handoff | proposed |
| 3 — optional provider and tool expansion | deferred |

## Product decisions

- **Discover, do not generate.** The output is a shortlist of existing samples,
  loops, packs, presets, and local-library items — never generated music or a
  replacement audio file.
- **The agent investigates; the person decides.** It may search, compare and
  explain. A person explicitly opens a source, buys/downloads it, and invokes
  the existing import flow. The model never receives arbitrary file-system,
  shell, credential, payment, or install permissions.
- **Evidence beats vibes.** Every recommendation has a source URL, exact asset
  name, source type, any visible usage note, and a short explanation of its
  musical fit. This is provenance for finding a sound again, not a licence
  review or compliance gate.
- **One provider contract, many adapters.** Use an OpenAI-compatible
  chat/tool-call shape for OpenAI, Gemini, Claude, OpenCode-configured gateways,
  and cheap/free inference providers. An adapter holds provider-specific auth
  and request details; the workflow owns no provider-specific prompts.
- **Use paid reasoning only where it changes the choice.** Cheap models handle
  query expansion, result normalization, and duplicate detection. A selected
  higher-quality model reviews a bounded evidence packet and ranks candidates.
  No multi-agent debate, background chat history, or unbounded browsing loop.
- **Credentials stay outside the renderer.** Electron main owns API keys and
  network calls; preload exposes only narrow request/stream/cancel methods.
  Browser deployment supports only an explicitly configured same-origin proxy;
  never put provider keys in a shipped web bundle.
- **Local and remote sources are visibly different.** A local SoundFont preset
  can hand off directly to its existing import path. A web result is only a
  link plus provenance until the user obtains it.

## User flow

```
brief → investigator → evidence-normalizer → reviewer → shortlist
                                                    ├─ open source
                                                    ├─ save lead
                                                    └─ import local preset / user-picked file
```

1. In **Library**, choose **Find sounds** (`Ctrl+Shift+L`) and write a plain
   language brief, e.g. “soulful sample as a base for a hard-house track,
   136 BPM; vocals are okay.”
2. The brief form exposes only useful controls: target role (sample/loop,
   drum pack, playable preset), tempo range, one-shot vs loop, vocals allowed,
   budget (free / paid / either), and sources (local /
   web). It turns these into a compact structured brief; the user can correct
   it before search.
3. The investigator issues small, source-specific searches and returns raw
   evidence. A normalizer removes duplicates and rejects rows missing a source
   URL or asset name. The reviewer sees at most 12 evidence-backed rows and
   returns at most five ranked recommendations plus one “search differently”
   suggestion when nothing fits.
4. Each result card shows: asset and maker, source, price when present, any
   visible usage note, format,
   tempo/key/tags when evidenced, a 1–2 sentence fit note, evidence links, and
   actions **Open**, **Save lead**, and, for a local preset, **Import & arm**.
5. **Open** uses the platform browser. Synth does not scrape gated audio,
   automate checkout. Once a user has a file, existing local pack/audio import
   remains the only import route.

## Phase 0 — contracts and settings

New pure modules under `src/shared/music-discovery/`:

```js
normalizeBrief(input)              // validates and caps user intent
validateCandidate(candidate)       // rejects unsafe/incomplete model output
dedupeCandidates(candidates)       // canonical URL + creator + asset name
rankCandidates(candidates, brief)  // deterministic tie-break after reviewer score
```

The provider boundary in `src/main/music-discovery/` is deliberately small:

```js
runDiscovery({ brief, providerId, signal, onEvent })
// streams: { type: 'status'|'candidate'|'final'|'error', ... }

ProviderAdapter.complete({ model, messages, tools, signal })
```

Provider configuration is a named connection: `id`, display name, base URL,
model, auth reference, and capability flags (`toolCalling`, `webSearch`). The
secret is stored in OS credential storage where available, never in project
files, localStorage, logs, prompts, or renderer state. The first shipped
adapter may be a generic OpenAI-compatible endpoint plus a manual result mode;
native OpenAI/Gemini/Claude adapters wait until an actual account needs a
provider-specific feature.

`DiscoveryBrief`, `Candidate`, and `DiscoveryRun` contain no audio bytes.
Persist saved leads only after the user clicks **Save lead**; save the brief,
candidate evidence, review time, and disposition. Do not silently reuse a
provider conversation across runs.

Tests: brief validation clamps result count and strips instructions masquerading
as metadata; invalid URLs cannot render as a candidate; duplicate URLs
collapse; deterministic ranking has stable ties.

## Phase 1 — bounded investigation

The orchestrator, not the model, owns the sequence and limits:

| Stage | Model / tools | Input ceiling | Output |
|---|---|---:|---|
| Brief interpreter | chosen cheap/default model | brief only | structured search plan |
| Investigator | web/source tools | 6 queries, 30 results | evidence records |
| Normalizer | pure code, optional cheap model | 30 records | <= 12 valid rows |
| Reviewer | chosen quality model | 12 evidence rows | <= 5 ranked cards |

Tool results are untrusted data. `searchSource(query)` allows only configured
source adapters and returns title, canonical URL, snippet, listed metadata, and
fetch time. `lookupLocalPresets(query)` reads the existing metadata-only
SoundFont index and never opens sample data. No generic browser-control tool,
arbitrary URL fetch, or shell tool is available to the model.

The reviewer must return JSON matching `Candidate`; prose outside the schema is
shown as a note, not interpreted as a command. Cancellation aborts the current
provider request and ends the run. The UI reports the active stage and source
count, not fake “agent thinking.”

Cost guardrails: per-run token and tool-call ceilings, an explicit model shown
before start, estimated/actual provider usage when supplied, and a user-set
monthly local budget. Hitting a guardrail returns results gathered so far; it
does not retry on a more expensive model.

## Phase 2 — provenance and handoff

Extend `LibraryDialog`; do not add a top-level workspace. Add two tabs:

- **Find sounds** — brief, progress, shortlist, and saved leads.
- **Local discovery** — the existing SoundFont preset search from
  `specs/soundfont-library.md` phase 5, so a recommendation from an indexed
  local bank can import and arm through `packs:importPreset`.

Candidate actions are capability-based: remote candidates can open/save;
local indexed presets can import/arm; installed packs can open the existing
instrument browser. A remote recommendation cannot call install even if a
model describes a URL as a pack.

`Save lead` records the original evidence and visible source details, rather
than a model summary alone. After local import, link the lead to the resulting
pack/patch id so the project remains based on stable local identifiers.

Acceptance:

1. “Soulful hard-house base, 136 BPM, vocals” yields no more than five
   source-linked candidates, with any visible source note retained.
2. “Indie-rock drum pack, free, one-shots” ranks matching packs by musical
   fit, source quality, and the evidence available.
3. A local preset result imports through the existing per-preset path and arms
   it; no new sample conversion path exists.
4. A provider error, cancellation, or budget cap leaks neither API keys nor a
   partially trusted candidate, and leaves saved leads intact.
5. A project still saves only pack/patch identifiers, never provider keys,
   prompts, or downloaded remote bytes.

## Phase 3 — deferred until evidence demands it

- Curated source adapters with source-specific metadata mapping.
- A user-owned OpenCode connection importer, only if its exported provider
  configuration can be referenced securely without copying secrets.
- Audio-preview analysis. This needs a download policy; metadata research is
  the useful first version.
- Team/shared lead lists, marketplace purchase flows, automatic downloads,
  provider failover, and autonomous re-search. These each add external state,
  cost, or trust policy and are not MVP work.

## Verification

```sh
npm test
```

Manual: configure a non-secret test adapter, run a constrained brief, cancel
mid-investigation, inspect the rendered evidence, open a remote candidate, save
one lead, then import one local indexed preset. Confirm that a project export
and renderer devtools contain no provider secret.

## Reference

For the OpenAI adapter, use the server-side Responses API with explicit tools;
the API supports built-in and custom tools, while the app should still retain
the orchestrator-owned limits above. [OpenAI API quickstart](https://platform.openai.com/docs/quickstart/make-your-first-api-request)
