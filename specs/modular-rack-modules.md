# Modular Rack — v1 Module Library

Companion to `specs/modular-rack.md`. Defines every module shipped in v1: panel width, implementation tier, polyphony behaviour, ports, and params.

Conventions from the main spec: audio ±1.0, bipolar CV ±1.0 (= ±5 V), unipolar CV 0…1.0, **pitch CV 0.1 per octave with 0.0 = C4**, gates 0/1 plus event-domain messages. `tier: worklet` modules are hidden on hosts without `ctx.audioWorklet` (the plain-HTTP LAN deploy) and load as bypass placeholders.

Priority: **P0** = required for the first shippable rack, **P1** = same release, after P0 lands.

---

## 1. Sources

| Module | HP | Tier | Poly | Inputs | Outputs | Params | Pri |
|---|---|---|---|---|---|---|---|
| **VCO** | 10 | native | yes | `V/OCT` cv, `FM` cv (atten), `PW` cv (atten), `SYNC` gate | `OUT` audio, `SUB` audio | tune ±24 st, fine ±100 c, wave (saw/square/tri/sine), pw 0.05–0.95, sub octave (−1/−2) | P0 |
| **FMOP** | 8 | native | yes | `V/OCT` cv, `MOD` audio (atten), `IDX` cv | `OUT` audio | ratio 0.25–16, index 0–10, wave (sine/tri), feedback 0–0.9 | P1 |
| **NOISE** | 4 | native | no | — | `WHT` audio, `PNK` audio | level 0–1 | P0 |
| **DRUM** | 8 | native | no | `TRIG` gate, `ACC` cv, `PITCH` cv | `OUT` audio | voice (bd/sd/lt/mt/ht/rim/clap/ch/oh/crash/ride), plus the selected voice's tone params | P1 |

**VCO.** `OscillatorNode` for sine/saw/tri/square; PW uses a two-saw phase-difference trick (`saw − delayed saw` via `DelayNode` + inverted `GainNode`) since `OscillatorNode` has no duty-cycle control. `V/OCT` connects through a fixed `GainNode(12000)` into `osc.detune`, so 0.1 in = 1200 cents = one octave; `tune`/`fine` are added as a `ConstantSourceNode` into the same `detune` param — summing is free. `SYNC` is event-domain only in native tier (hard sync at audio rate would need a worklet); a synced VCO restarts phase by `stop()`/recreate on the scheduled event time. `SUB` is a second oscillator at −1 or −2 octaves, square.

**FMOP.** Linear FM into `osc.frequency` (not `detune`) scaled by index × carrier frequency, which is the classic FM behaviour. Feedback uses the render-quantum delay of §5.5 in the main spec and is therefore approximate — the panel says "coarse feedback".

**NOISE.** One shared `AudioBufferSourceNode` looping a 2 s noise buffer per instance; pink via a 3-pole IIR approximated with cascaded `BiquadFilterNode` lowshelfs. Mono by design — poly noise is wasted CPU; poly destinations receive the same mono source on every channel.

**DRUM.** Reuses `drums/tr909-kit.js` (`createTr909Voice`, `PARAM_DEFS`) directly. `TRIG` is event-domain: a `gate-on` event schedules a voice at `event.time`, which is exactly how `tr909-view` already schedules. No new DSP.

---

## 2. Filters and shapers

| Module | HP | Tier | Poly | Inputs | Outputs | Params | Pri |
|---|---|---|---|---|---|---|---|
| **VCF** | 10 | native | yes | `IN` audio, `CUT` cv (atten), `RES` cv (atten) | `OUT` audio | cutoff 20–18000 Hz (log), res 0–0.95, mode (lp/hp/bp/notch), slope (12/24 dB) | P0 |
| **DRIVE** | 6 | native | yes | `IN` audio, `AMT` cv (atten) | `OUT` audio | drive 0–1, tone 0–1, mix 0–1, curve (soft/hard/asym) | P1 |
| **FOLD** | 6 | worklet | yes | `IN` audio, `AMT` cv (atten) | `OUT` audio | fold 1–8, symmetry ±1, gain 0–2 | P1 |

**VCF.** `BiquadFilterNode`; 24 dB slope = two cascaded biquads with Q split. `CUT` CV is exponential: the CV runs through a `GainNode(1200 × range)` into `filter.detune`, which biquad supports, giving true 1 V/oct filter tracking for free. `RES` CV modulates `Q` linearly.

**DRIVE.** `WaveShaperNode` with 4× oversampling and three precomputed curves; `tone` is a post `BiquadFilterNode` lowpass; `mix` is a dry/wet `GainNode` pair.

**FOLD.** Genuinely needs per-sample wrapping with an audio-rate amount; `WaveShaperNode` cannot modulate its curve. Worklet-only, hidden on LAN.

---

## 3. Envelopes and modulation

| Module | HP | Tier | Poly | Inputs | Outputs | Params | Pri |
|---|---|---|---|---|---|---|---|
| **ADSR** | 8 | native | yes | `GATE` gate, `RETRIG` gate | `ENV` cv (unipolar), `INV` cv | attack 0.001–8 s, decay 0.001–8 s, sustain 0–1, release 0.001–12 s, curve (lin/exp) | P0 |
| **AD** | 6 | native | yes | `TRIG` gate | `ENV` cv, `EOC` gate | attack, decay, curve, loop (on/off) | P1 |
| **LFO** | 6 | native | no | `RATE` cv (atten), `RESET` gate | `BI` cv, `UNI` cv | rate 0.01–40 Hz, wave (sine/tri/saw/ramp/square), sync (free / clock division), phase 0–360° | P0 |
| **RND** | 4 | native | no | `TRIG` gate | `CV` cv, `GATE` gate | range 0–1, bipolar (on/off), gate probability 0–1 | P1 |
| **S&H** | 4 | worklet (native fallback) | no | `IN` cv, `TRIG` gate | `OUT` cv | slew 0–1 | P1 |
| **SLEW** | 4 | worklet | no | `IN` cv | `OUT` cv, `RISING` gate | rise 0–4 s, fall 0–4 s, shape (lin/exp) | P1 |

**ADSR.** Pure event-domain: a `gate-on` event at time *t* schedules `cancelScheduledValues(t)` → `linearRampToValueAtTime(1, t+A)` → `setTargetAtTime(sustain, t+A, D/3)` on a `ConstantSourceNode.offset`; `gate-off` schedules the release. Sample-accurate with no worklet, on every host. `INV` is the same source through `GainNode(-1)`.

**LFO.** `OscillatorNode` at sub-audio rate into a `GainNode` for depth; `UNI` adds a `ConstantSourceNode(0.5)` offset. Clock-sync mode restarts phase on clock events (recreate the oscillator at the scheduled time — cheap at LFO rates). Mono: poly LFOs are rarely wanted and cost N oscillators; use `MERGE` if per-voice modulation is really needed.

**RND.** Sample-and-hold of a JS random on each `TRIG` event, applied to a `ConstantSourceNode.offset` with `setValueAtTime(v, event.time)`. Fully native because the value source is the control thread, not a signal.

**S&H.** Worklet tier samples its input on a rising `TRIG` at sample accuracy. Native fallback samples via an `AnalyserNode` poll at the event time, accurate to roughly one animation frame; the panel is labelled "≈16 ms sample point" in fallback mode. Do not hide the difference.

---

## 4. Clock and sequencing

| Module | HP | Tier | Poly | Inputs | Outputs | Params | Pri |
|---|---|---|---|---|---|---|---|
| **CLOCK** | 6 | native | no | `RUN` gate, `EXT` gate | `OUT` gate, `÷2` gate, `÷4` gate, `RESET` gate | bpm 20–300, source (internal / transport), swing 0–0.75, pulse width 0.05–0.9 | P0 |
| **CLKDIV** | 4 | native | no | `IN` gate, `RST` gate | `÷2 ÷3 ÷4 ÷8 ÷16` gate | reset mode (bar / manual) | P1 |
| **SEQ8** | 16 | native | no | `CLK` gate, `RST` gate, `DIR` cv | `CV` cv (pitch), `GATE` gate, `EOC` gate | 8 × (value −2…+2 oct, gate on/off, slide, accent), length 1–8, direction (fwd/rev/pend/rand), quantize (off/scale) | P0 |
| **EUCLID** | 8 | native | no | `CLK` gate, `RST` gate, `FILL` cv | `OUT` gate, `INV` gate | steps 1–32, fills 0–32, rotate 0–31, probability 0–1 | P1 |
| **QUANT** | 6 | native (event) / worklet (audio-rate) | yes | `IN` cv, `TRIG` gate | `OUT` cv, `TRIG` gate | scale (chromatic/major/minor/dorian/pent-min/pent-maj/whole/harm-min), root 0–11, transpose ±24 st | P1 |

**CLOCK.** In `transport` mode it consumes the 24 PPQN stream from `rack-clock.js` and emits gate events at the chosen division, so the rack locks to the arrangement without drift. In `internal` mode it runs its own 25 ms / 100 ms lookahead loop — the same scheduling shape as `sequencer.js` and `tr909-view`; extract that loop into one shared helper rather than writing it a third time. Swing delays odd pulses by `swing × halfStep`.

**SEQ8.** State lives in module params (`steps: [{ value, gate, slide, accent }, …]`), so patch export carries the sequence. `CV` output uses `setValueAtTime` per step, or `linearRampToValueAtTime` when `slide` is set (portamento). Gate length follows the incoming clock's pulse width. UI is 8 columns of knob + gate button + two toggles — the widest module in the library at 16 HP.

**EUCLID.** Standard Bjorklund distribution computed by a pure function `euclid(steps, fills, rotate) → boolean[]`, unit-tested against known patterns (E(3,8) = `x..x..x.`, E(5,8) = `x.xx.xx.`). `probability` gates each hit with a per-step random.

**QUANT.** Event tier snaps the pitch value at the moment of a `TRIG`/step event on the control thread — correct and free. Audio-rate continuous quantization (for portamento sweeps) needs the worklet tier. Scale tables are pure data in `utils/scales.js` and shared with the piano roll if it ever grows scale highlighting.

---

## 5. Utilities

| Module | HP | Tier | Poly | Inputs | Outputs | Params | Pri |
|---|---|---|---|---|---|---|---|
| **VCA** | 6 | native | yes | `IN` audio, `CV` cv (atten, normalled to unity) | `OUT` audio | gain 0–1, response (lin/exp) | P0 |
| **MIX** | 6 | native | yes | `IN1–4` audio | `OUT` audio, `SUM−` audio | 4 × level 0–1, master 0–1 | P0 |
| **ATT** | 4 | native | yes | `IN1` cv, `IN2` cv | `OUT1` cv, `OUT2` cv | 2 × (attenuvert −1…+1, offset −1…+1) | P0 |
| **MATH** | 6 | native | yes | `A` cv, `B` cv | `A+B`, `A−B`, `A×B`, `MIN`, `MAX` | scale 0–2 | P1 |
| **MULT** | 2 | native | yes | `IN` any | `OUT1–3` any | — | P1 |
| **SPLIT** | 6 | native | poly→mono | `IN` poly | `1–8` mono | — | P0 |
| **MERGE** | 6 | native | mono→poly | `1–8` mono | `OUT` poly | — | P0 |
| **SUM** | 4 | native | poly→mono | `IN` poly | `OUT` mono | normalize (on/off) | P1 |
| **COMP** | 6 | worklet (native fallback) | no | `IN` cv, `THR` cv | `GATE` gate, `INV` gate | threshold ±1, hysteresis 0–0.2 | P1 |

**VCA.** `GainNode` with `CV` connected straight to `gain` — the canonical Web Audio patch. `exp` response inserts a `WaveShaperNode` on the CV path with an exponential curve. The `CV` input is normalled to a `ConstantSourceNode(1)` that is disconnected the moment a cable lands, restoring hardware behaviour.

**MATH.** `A+B` is just both inputs into one `GainNode` (native summing). `A−B` inverts B. `A×B` is a `GainNode` whose `gain` is driven by B — audio-rate multiplication, natively. `MIN`/`MAX` need per-sample comparison and are the only worklet-requiring outputs; in native tier they render disabled with a tooltip rather than silently outputting garbage.

**MULT.** Purely cosmetic — Web Audio outputs already fan out — but patch tidiness is a real workflow feature and it costs one pass-through `GainNode`.

**SPLIT / MERGE / SUM.** The polyphony toolkit described in §5.6 of the main spec, mirroring VCV's `SPLIT`/`MERGE`/`SUM`. `SPLIT` exposes channels 1–8 as mono outputs; unconnected channels beyond the cable's channel count show a dark LED.

---

## 6. Effects

| Module | HP | Tier | Poly | Inputs | Outputs | Params | Pri |
|---|---|---|---|---|---|---|---|
| **DELAY** | 8 | native | mono (sums poly) | `IN` audio, `TIME` cv (atten), `FB` cv (atten) | `OUT` audio, `WET` audio | time 1–2000 ms or clock division, feedback 0–0.95, tone 200–12000 Hz, mix 0–1, sync (on/off) | P0 |
| **REVERB** | 8 | native | mono (sums poly) | `IN` audio, `MIX` cv (atten) | `OUT` audio | size 0.2–6 s, damp 0–1, mix 0–1, predelay 0–200 ms | P1 |
| **CHORUS** | 6 | native | yes | `IN` audio, `RATE` cv (atten) | `OUT` audio | rate 0.05–8 Hz, depth 0–1, voices 2/3, mix 0–1 | P1 |
| **RINGMOD** | 4 | native | yes | `X` audio, `Y` audio | `OUT` audio | mix 0–1 | P1 |

**DELAY.** `DelayNode` + feedback `GainNode` + `BiquadFilterNode` in the loop. `TIME` CV modulates `delayTime` at audio rate (tape-style pitch artefacts included, which is desirable). Clock-sync mode sets time from the transport BPM and a division param.

**REVERB.** `ConvolverNode` reusing the impulse-response generator currently private inside `audio-engine.js`. Extract `buildImpulseResponse(ctx, duration, decay)` into `utils/impulse.js` and have both call it — one implementation, two callers. `damp` applies a lowpass before the convolver; `predelay` is a `DelayNode` in front.

**RINGMOD.** True four-quadrant multiplication is a `GainNode` on X with `Y` connected to `gain` — native, exact, 4 HP.

---

## 7. I/O and instrumentation

| Module | HP | Tier | Poly | Inputs | Outputs | Params | Pri |
|---|---|---|---|---|---|---|---|
| **MIDI IN** | 8 | native | poly source | — | `V/OCT` cv, `GATE` gate, `VEL` cv, `MOD` cv, `PB` cv | voices 1–8, allocation (rotate/reuse/reset), glide 0–2 s, bend range 1–24 st | P0 |
| **OUT** | 4 | native | sums poly | `L` audio, `R` audio (normalled from L) | — | level 0–1, mute | P0 |
| **AUDIO IN** | 4 | native | no | — | `L` audio, `R` audio | gain 0–2 | P1 |
| **PARAM OUT** | 6 | native | no | `IN` cv | — | target (mixer/effect param picker), range min/max, smoothing 0–500 ms | P1 |
| **SCOPE** | 12 | native | no | `A` any, `B` any, `TRIG` gate | `A` audio, `B` audio (pass-through) | time 1–500 ms/div, scale 0.1–2, mode (wave/xy/spectrum), trigger level −1…1, slope (rising/falling) | P1 |
| **METER** | 8 | native | no | `1`–`4` audio | `1`–`4` audio (pass-through) | mode (audio/cv), source (peak/rms) | P1 |
| **CV MON** | 4 | native | shows ch 1–8 | `IN` any | — | display (volts / semitones / Hz / raw) | P1 |
| **TUNER** | 6 | native | no | `IN` audio | — | reference A 415–466 Hz | P1 |

**MIDI IN.** Owns the voice allocator: `note-on`/`midi-note-on` document events and `TimelinePlayer` clip notes both feed the same pure `allocateVoice(state, note) → { channel, state' }` function, unit-tested for rotate/reuse/reset and note-stealing. Emits pitch as `(midi − 60) / 120` (0.1 per octave, C4 = 0) plus gate and velocity events per channel. Its `voices` param is the origin of polyphony for most patches.

**OUT.** Terminal module; connects to the rack's mixer channel input (or the insert chain output). A rack with no `OUT` makes no sound and shows a toolbar hint. Multiple `OUT` modules sum.

**AUDIO IN.** Only meaningful when the rack is a mixer insert or hosting an audio track; in the standalone rack view it renders disabled with an explanatory label. It does **not** open the microphone — `getUserMedia` is secure-context-only and would break on the LAN host; a mic module is a phase-2 item with an explicit capability check.

**PARAM OUT.** Control-rate bridge described in §5.7 of the main spec: an `AnalyserNode` on the input is polled at 60 Hz, mapped through `range`, and written via `MixerEngine.setVolume/setPan/setEffectParam`. Panel states "control rate" so nobody expects audio-rate mixer modulation.

**SCOPE / METER / CV MON / TUNER.** All `AnalyserNode` readers on the shared 30 fps poll loop, suspended when the rack view is hidden. `TUNER` uses autocorrelation on a 2048-sample window — accurate enough for tuning a VCO, and it is the fastest way to prove 1 V/oct tracking is correct.

**SCOPE and METER are inline, not taps.** An `AnalyserNode` passes its input through unchanged and keeps analysing whether or not its output is patched, so both wire `IN → analyser → OUT` and can sit in the middle of a patch. `SCOPE` triggers on `TRIG` when something is patched there and on `A` otherwise; with no edge found it free-runs and paints `UNTRIG`. `METER`'s `cv` mode is not a dB meter — a control voltage is legitimately a steady, possibly negative DC (0.1 CV = 1 octave, 0.0 = C4), which `abs()` and a −60 dB floor both destroy, so it switches to a bipolar centre-zero scale with a single 30 ms follower and no peak-hold or clip latch.

---

## 8. Summary counts

- **P0 (first shippable rack, 16 modules):** VCO, NOISE, VCF, ADSR, LFO, VCA, MIX, ATT, CLOCK, SEQ8, SPLIT, MERGE, DELAY, MIDI IN, OUT, plus the bypass placeholder.
- **P1 (same release, 21 modules):** FMOP, DRUM, DRIVE, FOLD, AD, RND, S&H, SLEW, CLKDIV, EUCLID, QUANT, MATH, MULT, SUM, COMP, REVERB, CHORUS, RINGMOD, AUDIO IN, PARAM OUT, SCOPE, CV MON, TUNER.
- **Worklet-tier (unavailable on the plain-HTTP LAN host):** FOLD, SLEW, COMP, S&H (audio-rate mode), QUANT (audio-rate mode), MATH (`MIN`/`MAX` outputs only). Everything a basic subtractive or poly patch needs is native tier, by design.
