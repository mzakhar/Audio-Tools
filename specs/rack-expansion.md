# Modular Rack — Expansion: Modern Modules and Presets

Follow-on to `specs/modular-rack.md` / `specs/modular-rack-modules.md` / `specs/modular-rack-implementation-plan.md` (phases 0–6 complete). Target: beat-making, generative and randomised patching that the current 44-module library cannot do.

Everything here obeys the existing non-negotiables: `create(ctx, opts)` reads no globals, `inputs`/`outputs` are arrays indexed by poly channel, `dispose()` returns the node count to baseline, gates travel in the event domain, and **nothing new goes on the worklet tier** unless it genuinely cannot be native — the LAN deploy is plain HTTP.

---

## 1. Gap analysis

What the rack has today, by intent:

| Need | Have | Missing |
|---|---|---|
| Drum voices | `drum` (TR-909 kit), `perc4`, `noise` | sample playback, granular |
| Trigger sequencing | `seq8`, `algo` (8×8 trigs), `euclid`, `clkdiv` | 16 steps, per-step velocity/probability/ratchet, pattern *generation*, clock multiply, swing/trigger delay |
| Randomness | `rnd` (uniform S&H), `euclid` prob | looping/locked randomness, correlated randomness, random walk, chaos, Bernoulli routing |
| Pitch | `quant` (8 scales) | chords, arpeggiation |
| Beat glue | `vca`, `mix`, `comp` (placeholder) | sidechain ducking, real dynamics, envelope following |
| Shaping | `drive`, `ringmod`, `fold` (placeholder) | wavefolding (native), bitcrush |

Four placeholder modules currently ship as bypass stubs: `fold`, `s&h`, `slew`, `comp`. Two of them (`fold`, and a real compressor) are natively achievable today and should stop being placeholders.

Reference points for the module designs below (all well-established topologies, no cloning of code or graphics): Mutable Instruments Grids / Branches / Marbles, Music Thing Turing Machine, Make Noise Wogglebug, ALM Pamela's, Intellijel Steppy, Elektron-style trig conditions, Mutable Clouds-style granular.

---

## 2. Shared infrastructure (small, lands with phase 1)

Four additions, all cheap, all needed by more than one module:

| Item | Where | Why |
|---|---|---|
| `opts.random` — injected `() => number`, default `Math.random` | `rack-engine.js` → every `create` | Half the new modules are stochastic. Injection makes them unit-testable with a fake sequence and makes offline bounce reproducible when the engine passes a seeded PRNG. Retrofit `rnd`, `euclid`, `algo`, `seq8` in the same commit. |
| `opts.getBuffer(fileKey) → AudioBuffer \| null` | `rack-engine.js`, wired to `audio-store.js` live and to a preloaded map for bounce | `sampler` and `grain` need audio without importing a global. Same trick as `ctx`. |
| `opts.scheduler` — the existing `rack/scheduler.js` lookahead loop | `rack-engine.js` | `grain` must emit grains ~100 ms ahead. Do not write a second scheduler. |
| `"category"` string on preset JSON + `<optgroup>` in the toolbar select, label from `rack.name` not the filename | preset JSONs, `rack-view.js` | A flat filename list stops scaling at ~12 presets, and this ships ~22. `patch-io.js` already ignores unknown top-level fields. |

No change to the patch format version — `category` is metadata the importer never reads.

---

## 3. New modules — beat making

### `grids` — GRIDS · 12 HP · seq · native · mono

Generative drum-pattern map. Two knobs (X/Y) navigate a grid of pattern nodes; each of three channels has a density threshold. This is the single highest-value module in the plan: it turns a clock into a full, morphable beat with no step editing.

- **Ports:** `clk` gate in, `rst` gate in, `x` cv in (atten), `y` cv in (atten), `chaos` cv in (atten), `bd`/`sd`/`hh` gate out, `acc` gate out
- **Params:** `x` 0–1 (.5), `y` 0–1 (.5), `dBd`/`dSd`/`dHh` 0–1 (.5), `chaos` 0–1 (0), `swing` 0–.75 (0), `accentThresh` 0–1 (.8)
- **Pure core:** `src/renderer/js/rack/grids.js` — a 3×3 node map of `Uint8Array(32)` per channel (9 × 3 × 32 = 864 bytes of table), `gridsLevel(x, y, channel, step) → 0..255` by bilinear blend of the four surrounding nodes; hit when `level + chaos·noise > (1 − density)·255`. Fully testable with no context.
- **Panel:** small XY pad with a draggable puck plus three density knobs.

### `grid16` — GRID16 · 24 HP · seq · native · mono

Four-lane, sixteen-step trigger sequencer with modern per-step conditions. `algo` stays as-is (8 lanes × 8 steps, one gate each); `grid16` is the beat-focused sequencer, and its per-cell attributes are why it is a new module rather than a widening of `algo` — reshaping `algo`'s flat 64-cell buffer would break every saved patch that uses it.

- **Ports:** `clk`, `rst` gate in; `out1..out4` gate out; `acc` gate out; `eoc` gate out
- **Params:** `pattern` (4 × 16 cells of `{ on, vel, prob, ratchet }`), `length` 1–16, `swing` 0–.75, `direction` fwd/rev/pend/rand
- **Panel:** lane selector + 16 cells with the `algo` playhead poll; click toggles, shift-click cycles ratchet 1/2/3/4, alt-drag sets probability. Cell renders probability as opacity and ratchet as tick marks.

### `burst` — BURST · 4 HP · seq · native · mono

Ratchet / trigger repeat. One trigger in, *n* out.

- **Ports:** `trig` gate in, `cnt` cv in (atten), `out` gate out, `eob` gate out
- **Params:** `count` 1–16 (4), `spacing` 10–500 ms (60), `curve` −1…1 (0, accelerate ↔ decelerate), `prob` 0–1 (1)
- **Pure core:** `burstTimes(t0, count, spacing, curve) → number[]` in `rack/burst.js`. Tested: `curve=0` is even, `curve>0` compresses monotonically, total span is stable.

### `prob` — PROB · 4 HP · seq · native · mono

Bernoulli gate. Trigger in, routed to A or B.

- **Ports:** `trig` gate in, `p` cv in (atten), `a` gate out, `b` gate out
- **Params:** `p` 0–1 (.5), `mode` `coin` | `toggle` (`toggle` alternates deterministically, biased by `p` toward repeating)

### `tshift` — TSHIFT · 4 HP · util · native · mono

Trigger delay and swing. Because events carry a future timestamp, this is an offset on `event.time` and is sample-accurate for free.

- **Ports:** `in` gate in, `dly` cv in (atten), `out` gate out
- **Params:** `delay` 0–500 ms (0), `swing` 0–75 % (0, applied to odd-indexed incoming triggers), `humanize` 0–30 ms (0, uses `opts.random`)

### `duck` — DUCK · 6 HP · fx · native · mono

Sidechain ducker. Audio through a `GainNode`; a trigger schedules `linearRampToValueAtTime(1 − depth, t + attack)` then `setTargetAtTime(1, …)`.

- **Ports:** `in` audio in, `trig` gate in, `depth` cv in (atten), `out` audio out
- **Params:** `depth` 0–1 (.8), `attack` 1–100 ms (5), `release` 20–1000 ms (200), `curve` lin/exp

### `clkmul` — CLKMUL · 4 HP · seq · native · mono

Clock multiplier, the missing half of `clkdiv`. Predicts the interval from the last two clock events and schedules subdivisions ahead.

- **Ports:** `clk` gate in, `rst` gate in, `out` gate out
- **Params:** `mult` ×2/×3/×4/×6/×8 (×2)
- `ponytail:` interval prediction — the first multiplied tick after a tempo change lands on the old interval. Upgrade path is transport-aware timing via `rack-clock.js` if it ever matters.

---

## 4. New modules — generative and randomised

### `turing` — TURING · 8 HP · mod · native · mono

Looping shift register (Music Thing Turing Machine). The canonical "random that repeats" module.

- **Ports:** `clk` gate in, `lock` cv in (atten), `write` gate in, `cv` cv out, `cv2` cv out (second DAC tap, 2 bits), `pulse` gate out
- **Params:** `length` 2–16 (8), `lock` 0–1 (.5), `range` 0–1 (1), `bipolar` off/on
- **Semantics:** knob centre = a fresh random bit each clock; fully clockwise = register locked and looping; fully counter-clockwise = locked but the wrapped bit is inverted each pass (the classic "two-length" behaviour). CV out is the top 8 bits weighted as a DAC.
- **Pure core:** `turingStep(bits, length, lock, random) → bits` and `bitsToCv(bits, range, bipolar)` in `rack/turing.js`. Tested at lock 0 / .5 / 1 with a scripted `random`.
- **Panel:** 16 LEDs showing the register, a length selector, lock knob.

### `drift` — DRIFT · 6 HP · mod · native · mono

Slow correlated randomness — random walk and chaos. Fills scheduled `linearRampToValueAtTime` segments ~200 ms ahead from the shared poll loop, so nothing runs at audio rate.

- **Ports:** `rate` cv in (atten), `rst` gate in, `x`/`y`/`z` cv out
- **Params:** `rate` .01–10 Hz (.3), `depth` 0–1 (1), `mode` `walk` | `lorenz` | `smooth`, `bipolar` off/on
- **Pure core:** `lorenzStep(state, dt, σ, ρ, β)` and `walkStep(value, depth, random)` in `rack/drift.js`. Lorenz test: bounded trajectory over 10 000 steps, no NaN.

### `chord` — CHORD · 8 HP · util · native · mono

One pitch CV in, four voiced pitch CVs out. Pairs with `quant` and drives four `vco`s or one poly `vco`.

- **Ports:** `voct` cv in, `type` cv in (atten), `inv` cv in (atten), `gate` gate in (thru), `out1..out4` cv out, `gateOut` gate out
- **Params:** `type` oct/5th/maj/min/maj7/min7/sus4/dim/add9 (maj), `inversion` 0–3, `voicing` close/open/drop2, `scaleLock` off/on, `scale` (reuses `SCALES` from `quantizer.js`)
- **Pure core:** `chordVoltages(rootCv, type, inversion, voicing) → [cv×4]` in `rack/chord.js`. Tested against known intervals in 1 V/oct (0.1 = octave).

### `arp` — ARP · 8 HP · seq · native · mono

Arpeggiator over a held-note stack.

- **Ports:** `clk` gate in, `note` gate in (note events carrying pitch), `rst` gate in, `cv` cv out, `gate` gate out
- **Params:** `mode` up/down/updown/random/as-played, `octaves` 1–4, `gateLen` .05–.95, `hold` off/on
- **Pure core:** `arpOrder(notes, mode, octaves) → cv[]` in `rack/arp.js`.
- **Integration check before building:** confirm that `midi-in` note events carry pitch in a form `arp` can consume; if not, add the field there rather than re-deriving pitch from a CV jack.

### `marble` — MARBLE · 16 HP · mod · native · mono

Marbles-lite: correlated random gates and CVs with *déjà vu* (a loop-vs-new-value probability). The most capable generative module in the plan and therefore the last one built.

- **Ports:** `clk` gate in, `rate` cv in (atten), `spread` cv in (atten), `deja` cv in (atten), `t1..t3` gate out, `x1..x3` cv out
- **Params:** `tBias` 0–1 (.5), `tJitter` 0–1 (0), `tMode` coin/divmult/drums, `dejaVu` 0–1 (0 = always new, .5 = loop, 1 = locked loop), `loopLen` 1–16 (8), `xSpread` 0–1 (.5), `xBias` 0–1 (.5), `xSteps` 0–1 (0 = smooth … 1 = fully quantized), `scale`
- **Pure core:** `dejaVuValue(history, index, amount, random)` and `gateDistribution(bias, jitter, random)` in `rack/marble.js`.

---

## 5. New modules — sampling and texture

### `sampler` — SAMPLR · 12 HP · source · native · mono

One-shot sample player over `AudioBufferSourceNode`. Requires `opts.getBuffer`.

- **Ports:** `trig` gate in, `pitch` cv in, `start` cv in (atten), `out` audio out
- **Params:** `fileKey` (string; panel file picker via `AudioStore`), `start` 0–1, `end` 0–1, `pitch` ±24 st, `reverse` off/on, `loop` off/on, `decay` .01–4 s, `choke` 0–4, `level` 0–1
- Choke groups stop any live voice sharing the group at the new voice's start time. Missing buffer = silent, panel shows a warning badge — never throws.

### `grain` — GRAIN · 12 HP · source · native · mono

Granular cloud over the same buffer source. Grains are `AudioBufferSourceNode` + `GainNode` with a Hann envelope via `setValueCurveAtTime`, scheduled ~100 ms ahead through `opts.scheduler`.

- **Ports:** `trig` gate in (re-seed / freeze), `pos` cv in (atten), `dens` cv in (atten), `pitch` cv in, `out` audio out
- **Params:** `fileKey`, `position` 0–1, `size` 10–500 ms (80), `density` 1–100 Hz (20), `spray` 0–1, `pitch` ±24 st, `jitter` 0–1, `spread` 0–1 (stereo), `level`
- `ponytail:` hard cap of 64 concurrent grains; raise it or move grain scheduling to a worklet only if a real patch starves.

### `fold` — FOLD · 6 HP · fx · native · poly — **replaces the placeholder**

`WaveShaperNode` with a folding curve and `oversample: '4x'`, fed through a pre-gain `GainNode`. Because folding amount *is* input drive, the `AMT` CV input can modulate the pre-gain at true audio rate — the reason this was ruled worklet-only no longer holds. Curve is rebuilt only when `fold`/`symmetry` change (knob rate).

- Ports and params unchanged from the placeholder, so existing patches keep working.

### `bits` — BITS · 6 HP · fx · native · poly

Bit-depth crush via a quantizing `WaveShaperNode` curve, plus dry/wet.

- **Ports:** `in` audio in, `amt` cv in (atten), `out` audio out
- **Params:** `bits` 2–16 (8), `mix` 0–1 (1)
- Sample-rate reduction (the other half of a real bitcrusher) needs per-sample hold and stays deferred to the worklet tier. The panel says "bit depth only".

### `follow` — FOLLOW · 4 HP · mod · native · mono

Envelope follower: `AnalyserNode` RMS read on the shared 30 Hz poll, smoothed into a `ConstantSourceNode` with `setTargetAtTime`.

- **Ports:** `in` audio in, `env` cv out, `gate` gate out
- **Params:** `gain` 0–4, `attack` 1–500 ms, `release` 10–2000 ms, `threshold` 0–1
- `ponytail:` 30 Hz control rate. Fine for filter sweeps and ducking, useless for transient tracking; audio-rate following needs a worklet.

### `dyn` — DYN · 6 HP · fx · native · mono

`DynamicsCompressorNode` wrapper — threshold, knee, ratio, attack, release, plus a gain-reduction meter reading `.reduction` on the poll. Native since the very first Web Audio spec; there was never a reason for this to be missing. (`comp` stays what it is: a comparator, still a placeholder.)

---

## 6. Presets

Presets are plain JSON in `src/renderer/presets/racks/`, picked up by the existing `import.meta.glob`, and `tests/rack-patch-io.test.js` already asserts every shipped preset imports clean — that test is what keeps this set from rotting.

| File | Category | Patch |
|---|---|---|
| `grids-kit` | beat | `clock → grids`; BD/SD/HH → three `drum`s → `mix` → `out`; ACC → `vc` on the snare |
| `ratchet-techno` | beat | `grid16` lanes → drums, lane 4 → `burst` → hats; `tshift` swing on the whole clock |
| `sidechain-pump` | beat | kick `drum` + a `vco` pad through `duck` triggered from the kick lane |
| `sampler-chop` | beat | `grid16` → `sampler` with per-step start CV from `seq8`, into `bits` and `delay` |
| `breakbeat-euclid` | beat | three `euclid`s at coprime lengths → `drum`s, `prob` splitting the hat between open and closed |
| `turing-drift` | generative | `turing` → `quant` → `vco` → `vcf` (cutoff from `drift`) → `vca` ← `ad` |
| `krell` | generative | classic self-generating patch: `rnd` sets rate, `ad` EOC retriggers itself, `drift` on timbre — plays forever with no clock |
| `generative-chords` | generative | `turing` → `quant` → `chord` → four `vco`s → `mix`, gates from `grids` HH |
| `marbles-bloom` | generative | `marble` T1/T2/T3 and X1/X2/X3 driving a percussion voice and a melodic voice |
| `chaos-drone` | generative | `drift` in `lorenz` mode into three `vco` detunes and `vcf`, `reverb` on the sum |
| `granular-cloud` | texture | `grain` on a loaded file, `drift` on position, `fold` and `reverb` after |
| `fold-bass` | texture | `vco` sub → `fold` (AMT from `adsr`) → `vcf` → `dyn` |

Toolbar work: read `category` and `rack.name` from each preset, render `<optgroup>` per category, alphabetical inside. Presets with no `category` fall into "other" so the ten existing ones need no edit.

---

## 7. Phasing

**Status:** E1 and E2 are in on `mzakhar/rack-expansion-e1-e2` — eleven modules, eight presets, suite at 773 tests. E3–E5 not started.

Landed alongside them, beyond what the plan called for:

- The event bus now drops a dispatch past depth 64. Cycles are the user's to patch and dispatch is synchronous, so `AD` EOC into its own TRIG — the obvious Krell move — was a stack overflow. `krell.synthrack.json` uses `ad` in `loop` mode instead, which was always the safer clock.
- `GRIDS` and `GRID16` both grew an `accentThresh` param; the spec gave them an ACC jack with no rule for when it fires.
- CV jacks that cannot be `AudioParam`s (GRIDS X/Y/CHAOS, BURST CNT, PROB P, TSHIFT DLY, DUCK DEPTH, TURING LOCK, DRIFT RATE, CHORD V/OCT) are `AnalyserNode` taps on the shared 30 Hz poll, scaled 1.0 CV = full knob range. The alternative was a decorative jack.
- Preset menu categories moved forward from E4, since eight new presets landed at once.
- `event.pitch` means a raw MIDI number out of `midi-in` but a pitch CV out of `quant`. `TURING` and `ARP` emit `cv` to stay out of it; normalising `midi-in` to emit both is the fix if a module ever needs to read pitch generically.


Each phase is independently shippable, ends green, and ships its own presets. `npm test` before each commit; conventional commits.

| Phase | Contents | New tests |
|---|---|---|
| **E1 — Beat core** | Infra: `opts.random` + retrofit. Modules: `grids`, `grid16`, `burst`, `prob`, `tshift`, `duck`, `clkmul`. Presets: grids-kit, ratchet-techno, sidechain-pump, breakbeat-euclid. | `rack-grids.test.js` (blend, density threshold, determinism under a fake `random`), `rack-burst.test.js`, `rack-grid16.test.js` (conditions, swing, playhead) |
| **E2 — Generative core** | `turing`, `drift`, `chord`, `arp`. Presets: turing-drift, krell, generative-chords, chaos-drone. | `rack-turing.test.js`, `rack-drift.test.js` (Lorenz bounded), `rack-chord.test.js` |
| **E3 — Sampling** | Infra: `opts.getBuffer` + `opts.scheduler` exposure. Modules: `sampler`, `grain`. Presets: sampler-chop, granular-cloud. | `rack-sampler.test.js` (choke, missing buffer is silent not fatal), `rack-grain.test.js` (grain cap, dispose leaves no live source) |
| **E4 — FX and de-placeholdering** | `fold` native rewrite, `bits`, `follow`, `dyn`. Preset: fold-bass. Preset menu categories. | extend `rack-modules.test.js`; leak test covers the new sources |
| **E5 — Marbles-lite** | `marble`. Preset: marbles-bloom. | `rack-marble.test.js` (déjà-vu loop at 0 / .5 / 1) |

Acceptance across all phases:

1. Every new module mounts, sounds, and `unmount`s back to the node-count baseline (the existing lifecycle regression test picks them up automatically once registered).
2. Every shipped preset round-trips through `exportPatch`/`importPatch` unchanged.
3. With a seeded `opts.random`, an offline bounce of `grids-kit` is sample-identical across two runs.
4. Nothing new is worklet tier, so the whole set works on `http://themachine/synth/`.

---

## 8. Explicitly not in scope

| Item | Why |
|---|---|
| Sample-rate reduction in `bits`, audio-rate `s&h` / `slew`, audio-rate `comp` | Genuinely need per-sample processing. They stay worklet-tier placeholders until async worklet loading exists in the factory contract. |
| Beat-repeat / stutter buffer | Needs live audio capture into a ring buffer — worklet. |
| A pattern *bank* / song mode inside `grid16` | The arrangement view already owns song structure; duplicating it in a module is how two sources of truth start. |
| Widening `algo` to 16 steps | Would reshape its saved flat 64-cell buffer. `grid16` covers the need without a migration. |
| Preset thumbnails / a preset browser panel | The `<optgroup>` select carries 22 presets fine. Revisit past ~40. |
