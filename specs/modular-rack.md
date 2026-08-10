# Modular Rack Specification

## 1. Purpose

Add a simulated eurorack modular synthesizer to Synth as a first-class view and a first-class DAW citizen. Users build patches by dragging modules onto rack rails and connecting jacks with cables. A rack can be played from the keyboard/MIDI, hosted as a track instrument, inserted as an effect on a mixer channel, and used as a modulation source for mixer and effect parameters.

This is not a VCV Rack clone and not a plugin host. It is a native Synth feature built on the existing Electron/Vite renderer, the shared `AudioEngine` context, `ProjectStore`, `MixerEngine`, and `TimelinePlayer` — with no new runtime dependencies.

Companion documents:

- `specs/modular-rack-modules.md` — the v1 module library reference.
- `specs/modular-rack-implementation-plan.md` — phased build order, files touched, acceptance criteria.

## 2. Research Summary

### 2.1 Prior art surveyed

| System | Model | What we take | What we reject |
|---|---|---|---|
| **VCV Rack** | Native C++, skeuomorphic eurorack rails, per-sample DSP, polyphonic cables carrying up to 16 channels | Rail/HP layout, jack-and-cable interaction, poly cables with thin/thick rendering, `SPLIT`/`MERGE`/`SUM`/`VIZ` utility modules, ±5 V CV and 1 V/oct convention, cable color-coding as a user-managed strategy | Plugin ABI, module marketplace, per-sample scheduling of the whole graph |
| **NoiseCraft** / Zupiter | Browser, graph compiled to JS running inside a single `AudioWorklet`; Web Audio used only for output | Deterministic graph semantics, small orthogonal node set, patch-as-JSON | Compiling the whole graph into one worklet — it makes the entire feature unavailable on the plain-HTTP LAN deploy (see §3.1) |
| **Audulus** | Node canvas, minimal flat nodes, `Expr` node for textual math, everything is a signal | Free-form modulation of any parameter, a math/expression escape hatch | Node-canvas UI (rejected in favour of rails), compiled-signal purity |
| **Bespoke Synth** | Modules-as-DAW; sequencers, samplers, effects all patchable | Rack participates in transport, arrangement and mixing rather than being a sandbox | Replacing the existing arranger with modules |
| **Hexen** | Android eurorack sim, 3D panels, double-tap zoom, tap-and-drag patching | Zoom-to-fit and pointer-friendly cable dragging | 3D rendering |
| **Pure Data / Max** | Signal + control (message) domains as separate connection semantics | The two-domain split, which is what makes sample-accurate gates possible without worklets (§5.4) | Textual object boxes |

### 2.2 Conventions inherited from hardware eurorack

- 1 HP = 5.08 mm panel width; modules are integer-HP wide; a 3U row is a fixed panel height.
- Pitch CV is 1 V/octave; C4 = 0 V by common convention.
- Audio is roughly ±5 V; CV is 0–10 V unipolar or ±5 V bipolar; gates are 0 V / +5–10 V; triggers are short gates (~1 ms).
- Normalled jacks: an unpatched input reads an internal default (a VCA's CV input normalled to unity, a filter's input normalled to nothing).
- Attenuverters (bipolar attenuators) on modulation inputs are the single highest-value-per-pixel control on any module.

## 3. Decisions

### 3.1 Engine: hybrid native + optional worklet

Modules are implemented against native Web Audio nodes wherever a native node exists (`OscillatorNode`, `BiquadFilterNode`, `GainNode`, `DelayNode`, `WaveShaperNode`, `ConvolverNode`, `AnalyserNode`, `ConstantSourceNode`). Modules that genuinely need per-sample custom DSP (wavefolder, comparator, sample & hold at audio rate, chaos, slew with audio-rate response, ring mod with feedback) are implemented as `AudioWorkletNode` modules and are **capability-gated**.

Rationale: `ctx.audioWorklet` is `undefined` outside a secure context. The LAN deploy `http://themachine/synth/` is plain HTTP. A worklet-only engine (the NoiseCraft approach) would make the entire rack dead on the LAN host, violating the project rule that no secure-context-only API sits on a critical path — the same trap `recorder.js` already works around.

Consequences that must be designed for, not discovered later:

- **`AudioEngine.hasWorklet()`** is added next to the existing `hasRecorder()`. The module registry marks each module `tier: 'native' | 'worklet'`.
- On a host without worklet support, `tier: 'worklet'` modules are hidden from the module browser and, if present in a loaded patch, instantiate as a **bypass placeholder**: the panel renders greyed with a "not available on this host" badge, its params and cables are preserved in state, and its first audio input is passed through to its first audio output where port kinds allow. A patch built on `https://synth.zakharhome.org` therefore opens, saves, and round-trips losslessly on the LAN host — it just sounds incomplete, and says so.
- No module in the **starter patch** and no module needed for a basic subtractive voice (VCO, VCF, VCA, ADSR, LFO, NOISE, MIX, OUT) may be worklet-tier.

### 3.2 Signal conventions

Web Audio nodes work in ±1 float, not volts. The rack uses a fixed scaling so hardware intuition transfers:

| Domain | Numeric range in the graph | Notes |
|---|---|---|
| Audio | ±1.0 nominal | Matches Web Audio native; `OUT` module applies headroom trim before the mixer |
| Bipolar CV | ±1.0 = ±5 V | LFOs, envelopes in bipolar mode, attenuverter outputs |
| Unipolar CV | 0…1.0 = 0…10 V | Envelopes, unipolar LFO mode |
| Pitch CV | 0.1 per octave (1 V/oct at the 0.1 = 1 V scale), 0.0 = C4 | Converted to cents with a fixed `GainNode(gain = 12000)` into `osc.detune` — 0.1 in ⇒ 1200 cents ⇒ one octave |
| Gate | 0 or 1.0 | Plus an event-domain message; see §5.4 |

`utils/cv.js` holds the pure conversion helpers (`voltsToCents`, `midiToPitchCv`, `pitchCvToHz`, `gateFromVelocity`) and is unit-tested. No module may hand-roll these conversions.

**Signal summing is free.** Multiple cables into one input sum, because Web Audio `AudioParam` and `AudioNode` inputs sum connections natively. This is exactly the eurorack behaviour and requires no mixer code.

### 3.3 UI: eurorack skeuomorph on rails

Modules are fixed-height panels of integer HP width, snapped into horizontal rails. Jacks are circular, knobs are rotary with drag-to-turn, cables hang between jacks with catenary sag and are colour-coded.

Implementation: **DOM panels + one canvas overlay for cables.** Panels are real DOM (`<button>` jacks, `<input type="range">` knobs styled rotary) so keyboard focus, ARIA and the existing CSS system work; cables draw on a single absolutely-positioned canvas that redraws only on drag, patch change, or animated-signal frames. This mirrors the split already used in the app (canvas for `arrangement-view`, DOM for `tr909-view`).

### 3.4 Integration: full DAW citizen

The rack is available in five roles:

1. **Rack view** — a sidebar tool (`F3`) with its own transport-linked play state.
2. **Track instrument** — `track.instrument = { type: 'rack', rackId }`. Piano-roll MIDI clips and live MIDI drive the rack's `MIDI IN` module.
3. **Mixer insert** — a rack whose patch contains an `AUDIO IN` module can sit in a channel's `EffectChain` as effect type `rack`.
4. **Modulation source** — a `PARAM OUT` module targets a mixer or effect parameter (`ch3.pan`, `ch1.eq3.high`), polled and applied on the control thread.
5. **Bounce participant** — the engine builds into any `BaseAudioContext`, so offline rendering works.

### 3.5 Deliberate non-goals for v1

WASM DSP, a plugin/module SDK for third parties, cloud patch sharing or a patch browser, module skin/artwork theming, oversampling, per-sample feedback loops without the render-quantum delay (§5.5), micro-tuning tables, MPE, and multi-rack racks (a rack containing a rack).

## 4. User Experience

### 4.1 Layout

```text
┌─ Rack Toolbar ────────────────────────────────────────────────────────────┐
│ ▶ ■  | rack: [Lead Rack ▾] | + MODULE | ZOOM −/+/fit | CABLES ▾ | ⇄ TIDY   │
├───────────────────────────────────────────────────────────────────────────┤
│ ╔═════════════════════════ rail 1 ══════════════════════════════════════╗ │
│ ║ [ MIDI IN 8HP ][ VCO 10HP ][ VCF 10HP ][ ADSR 8HP ][ VCA 6HP ][OUT 4HP]║ │
│ ║   ○  ○   ○        ○ ○ ○ ○     ○ ○ ○ ○     ○  ○  ○     ○ ○ ○     ○ ○   ║ │
│ ╚══════╧════╲═══════╱════════════════════════════════════════════════════╝ │
│ ╔═════════════════════════ rail 2 ══════════════════════════════════════╗ │
│ ║ [ CLOCK 6HP ][ SEQ8 16HP ][ LFO 6HP ][ NOISE 4HP ][ SCOPE 12HP ]      ║ │
│ ╚═══════════════════════════════════════════════════════════════════════╝ │
├───────────────────────────────────────────────────────────────────────────┤
│ Module Browser (collapsible drawer, grouped: SOURCE MOD FILTER ENV SEQ    │
│ UTIL FX IO) — click or drag to place                                      │
└───────────────────────────────────────────────────────────────────────────┘
```

- Default rack: 3 rails × 104 HP, growable to 8 rails. Rails scroll vertically; the rack scrolls horizontally.
- 1 HP = 16 px at 100 % zoom. Panel height = 380 px (3U). Zoom range 40–200 %, `Ctrl+scroll` or toolbar; `fit` zooms to bounding box of placed modules.
- The module browser is a drawer, not a modal — patching while browsing is normal.

### 4.2 Placing and moving modules

- Click a browser entry: places it in the first free gap wide enough, on the topmost rail with room.
- Drag from the browser onto a rail: a ghost panel shows the snapped HP slot; occupied slots push neighbours right if the rail has room, otherwise the drop is refused with a shake.
- Drag a placed module by its panel chrome (not by knobs/jacks) to move it; cables follow live.
- `Ctrl+D` duplicates a module with its params (not its cables). `Delete` removes it and every cable attached.
- Right-click a module: rename, duplicate, delete, "disconnect all", "reset params", "bypass".

### 4.3 Patching

- Press on a jack and drag: a cable follows the pointer; compatible jacks highlight, incompatible ones dim (§4.4).
- Release on a jack: connect. Release on empty rail: cancel, cable snaps back and vanishes.
- Drag from a **connected input** picks that cable up and moves its end (eurorack behaviour). Drag from a **connected output** creates an additional cable — outputs fan out freely; inputs take many cables and sum them.
- Click a cable to select it; `Delete` removes it. `Alt+click` a jack removes all cables on it.
- Cable colour: automatic by port kind (audio green, CV blue, gate amber) or a per-cable colour chosen from an 8-swatch palette, cycled with `Shift+click` on the cable. Preference stored per rack (`cableColorMode: 'kind' | 'manual'`).
- Cables render as quadratic-bezier curves whose sag is proportional to slack; the sag is purely cosmetic and cached per cable until an endpoint moves.
- `CABLES ▾` toolbar menu: opacity slider, "hide cables" (jacks still show connection dots), "show signal activity" (animated brightness driven by the meter poll, capped at 30 fps).

### 4.4 Port compatibility

Every port declares `kind: 'audio' | 'cv' | 'gate'`. All kinds are electrically the same signal, exactly as in hardware, so **any output may connect to any input**. Kind drives colour, default cable colour, and a soft warning only:

- Same kind → normal highlight.
- Different kind → dimmed-but-legal highlight; the connection is allowed and the cable takes the source's colour.
- Output → output, or input → input → refused.
- A cable that would create a cycle is allowed, with the render-quantum caveat of §5.5 and a small `↻` badge on the cable.

### 4.5 Knobs, attenuverters and normalling

- Knobs: click-drag vertically (fine with `Shift`), double-click to reset to default, scroll to nudge. Value tooltip appears while dragging with the formatted value and unit.
- Every modulation input has an inline attenuverter (a small knob directly under the jack, −1…+1, centre-detented at 0). Implemented as a `GainNode` in front of the destination param — no CV reaches the destination when centred.
- Normalled inputs display a faint dashed ring; the panel help text names the normal ("CV in — normalled to +5 V").

### 4.6 Keyboard patching (accessibility, not an afterthought)

The whole rack is operable without a pointer:

- `Tab` walks modules; `Enter` enters a module; `Tab` inside walks its controls; `Escape` exits.
- On a jack: `Enter` starts a cable ("patching from VCO ▸ OUT"), `Tab`/arrows move to any other jack, `Enter` completes, `Escape` cancels. A live region announces each step.
- On a knob: arrows adjust by step, `Home`/`End` go to min/max, `Backspace` resets.
- Every jack has an `aria-label` of the form `"VCO 1 output, audio, connected to VCF 1 input"`; every module panel is a `role="group"` with an accessible name.
- A "patch list" panel (`toolbar ▸ ⇄`) renders the whole patch as a readable table of connections — the screen-reader-friendly view of the cable spaghetti, and a debugging aid for everyone.

### 4.7 First-run state

Opening an empty rack loads the **starter patch**: `MIDI IN → VCO → VCF → VCA → OUT`, with `ADSR → VCA CV` and `LFO → VCF cutoff` via a centred attenuverter. It makes sound from the first key press. All native-tier.

## 5. Architecture

```text
                    ProjectStore (pure state + undo)
                              │  racks[], commands
                              ▼
   rack-view.js ──────► rack-engine.js ──────► Web Audio nodes
   (DOM panels +          (reconciler)         (per module instance,
    cable canvas)              │                per poly channel)
        │                      ▼
        │              modules/registry.js ── module factories
        │                      │              (ctx, opts) → instance
        ▼                      ▼
   rack-layout.js        rack-clock.js ──── transport / event domain
   (pure HP math)        (scheduled gates)
```

### 5.1 State model (pure data, lives in `ProjectStore`)

```js
state.racks = {
  'rack-1': {
    id: 'rack-1',
    name: 'Lead Rack',
    rails: 3,
    railHp: 104,
    cableColorMode: 'kind',
    polyLimit: 8,
    modules: [
      { id:'m-1', type:'vco', rail:0, hp:8,  params:{ tune:0, wave:'saw', pw:0.5 }, bypassed:false, name:null },
      { id:'m-2', type:'vcf', rail:0, hp:18, params:{ cutoff:1200, res:0.3, mode:'lp' }, atten:{ cutoffCv:0.4 } }
    ],
    cables: [
      { id:'c-1', from:{ moduleId:'m-1', port:'out' }, to:{ moduleId:'m-2', port:'in' }, color:null }
    ]
  }
}
```

- `hp` on a module is its **left offset in HP within its rail**; width comes from the registry, not from state (so a registry width change migrates every patch).
- Params are plain numbers/strings. No node references, no functions, no DOM — the whole rack serializes with `JSON.stringify` and diffs cleanly.
- Module `type` is a registry key. Unknown types on load become an "unknown module" placeholder that preserves state rather than dropping it.

Commands (all following the existing `{ label, execute, undo }` shape in `ProjectStore.js`, all reusing the snapshot-undo the store already provides):

`AddRack`, `RemoveRack`, `RenameRack`, `AddModule`, `RemoveModule`, `MoveModule`, `SetModuleParam`, `SetAttenuverter`, `SetModuleBypass`, `Connect`, `Disconnect`, `SetCableColor`, `LoadRackPatch`.

`SetModuleParam` at knob-drag rate must not flood the undo stack: knob drags dispatch a single coalesced command on pointer-up, with live audio updated directly through the engine during the drag. This is the same pattern the mixer strip already needs and should be extracted to one shared helper, not written twice.

### 5.2 Module registry and factory contract

```js
// modules/vco.js
export default {
  type: 'vco',
  name: 'VCO',
  group: 'source',
  hp: 10,
  tier: 'native',
  poly: true,
  ports: [
    { id:'v_oct', dir:'in',  kind:'cv',    label:'V/OCT' },
    { id:'fm',    dir:'in',  kind:'cv',    label:'FM', atten:true },
    { id:'sync',  dir:'in',  kind:'gate',  label:'SYNC' },
    { id:'out',   dir:'out', kind:'audio', label:'OUT' },
    { id:'sub',   dir:'out', kind:'audio', label:'SUB' }
  ],
  params: [
    { key:'tune',  label:'TUNE',  min:-24, max:24, step:1,    def:0,     fmt:'st' },
    { key:'fine',  label:'FINE',  min:-100,max:100,step:1,    def:0,     fmt:'c'  },
    { key:'wave',  label:'WAVE',  options:['saw','square','tri','sine'], def:'saw' },
    { key:'pw',    label:'PW',    min:0.05,max:0.95,step:0.01,def:0.5,   fmt:''   }
  ],
  create(ctx, { channels = 1, params }) {
    // build `channels` copies of the node subgraph
    return {
      inputs:  { v_oct:[...], fm:[...], sync:[...] },  // arrays: one entry per poly channel
      outputs: { out:[...], sub:[...] },
      setParam(key, value, atTime) { ... },
      onEvent(portId, event) { ... },   // optional, event domain (§5.4)
      setChannels(n) { ... },           // optional; default = rebuild
      dispose() { ... }
    }
  }
}
```

Rules:

- `create` receives the `BaseAudioContext` explicitly and reads **no** globals. That is what makes offline bounce (§5.7) and unit testing possible.
- `inputs`/`outputs` entries are arrays indexed by poly channel; each entry is an `AudioNode` or `AudioParam`. Cable connection is `src.connect(dst)` in both cases — Web Audio handles node→param.
- A module never connects to another module. Only the engine does.
- `dispose` must disconnect and stop everything it created; leaked `OscillatorNode`s are the classic Web Audio memory bug.

The registry (`modules/index.js`) validates every entry at import time (unique type, unique port ids, params have defaults, worklet-tier modules declare their processor URL) and throws loudly in dev. Registry validation is unit-tested; a malformed module should fail the test suite, not the user's speakers.

### 5.3 Engine reconciliation

`rack-engine.js` owns the mapping from patch state to live nodes:

```js
RackEngine.mount(ctx, rackState, { output })   // → handle
RackEngine.update(handle, nextRackState)        // diff, apply
RackEngine.setParamLive(handle, moduleId, key, value)
RackEngine.unmount(handle)
```

`update` diffs by id:

1. Removed cables → `disconnect`. Removed modules → `dispose`.
2. Added modules → `create` + connect nothing yet.
3. Changed poly channel counts → `setChannels` or rebuild-and-reconnect.
4. Added cables → connect, per channel (§5.6).
5. Changed params → `setParam` with `setTargetAtTime` smoothing for continuous params, immediate for discrete ones.

Moving a module or recolouring a cable changes no audio and must produce **zero** node churn — the diff keys on ids and connection endpoints only. This is worth a test: "moving a module does not restart its oscillator".

### 5.4 Two domains: signals and events

Native Web Audio cannot read a signal on the control thread without an `AnalyserNode` poll, which is jittery (~one animation frame) and unusable for musical gates. Pure Data solved this decades ago by separating signal from message; the rack does the same, transparently:

- **Signal domain** — every cable is a real Web Audio connection. Always present, always the thing a scope displays.
- **Event domain** — modules whose gates originate from a *scheduler* (`CLOCK`, `SEQ8`, `EUCLID`, `MIDI IN`, transport) additionally emit `{ type:'gate-on'|'gate-off'|'trig', time, channel, pitch?, velocity? }` events with an **audio-context timestamp in the future** (25 ms tick, 100 ms lookahead — identical to the existing `Sequencer` and `tr909-view` scheduling loop). Modules that consume gates (`ADSR`, `AD`, `S&H`, `SEQ8` clock in, drum modules) implement `onEvent` and schedule sample-accurate `AudioParam` ramps from it.

Consequences:

- `CLOCK → ADSR` is sample-accurate on every host, with no worklet.
- `LFO → ADSR` (a signal-domain source into a gate input) needs a threshold crossing. The `COMP` (comparator) module bridges signal → event: worklet-tier for accuracy, with a native `AnalyserNode`-poll fallback at animation-frame resolution that is **explicitly labelled "~16 ms jitter"** in its panel. Do not pretend the fallback is exact.
- The engine routes an event cable by walking the cable graph at connect time; event delivery is direct function calls (`dst.onEvent(port, evt)`), not `postMessage`.

### 5.5 Feedback loops

A cycle in native Web Audio requires a `DelayNode` in the loop; Web Audio also imposes a 128-sample (one render quantum, ≈2.9 ms at 44.1 kHz) minimum latency across any cycle. The engine detects cycles at connect time and inserts a `DelayNode(0)` at the cycle-closing cable, marking the cable with `↻`. Audio-rate feedback FM is therefore *not* possible in native tier; the `FOLD` and `RINGMOD` worklet modules cover the cases that need it. This limitation is documented in the module browser help text, not hidden.

### 5.6 Polyphony

VCV-style poly cables, capped at 8 channels native tier / 16 worklet tier (`rack.polyLimit`).

- A cable carries `n` channels. `n` is a property of the **source port instance**, propagated forward through the graph at reconcile time by a pure function `resolveChannels(rackState, registry) → Map<moduleId, n>`.
- Sources of polyphony: `MIDI IN` (voice allocator, `n` = its `voices` param), `MERGE` (n = number of connected inputs), any module fed by a poly cable (chain reaction, exactly as VCV describes it).
- Monophonic modules receiving a poly cable (e.g. `OUT`, `DELAY`) sum channels down implicitly through a `GainNode` mixdown; the panel shows a "Σ8" badge so the summing is visible.
- `SPLIT` (poly → 8 mono outs), `MERGE` (up to 8 mono ins → poly), `SUM` (poly → mono), `VIZ` (per-channel level bars) are v1 modules.
- Rendering: mono cables 3 px, poly cables 5 px with a subtle double-stroke.
- Cost: `n` channels means `n` node subgraphs. An 8-voice patch of 12 modules is ~96 subgraphs. That is why the performance budget (§7) caps the default at 4 voices for the starter poly patch and warns above 6 × 24 modules.

`resolveChannels` is a pure function over patch state and is the single most important unit test in the feature — every polyphony bug will be a bug in it.

### 5.7 DAW integration points

| Role | Wiring | Notes |
|---|---|---|
| Rack view | `RackEngine.mount(ctx, rack, { output: MixerEngine.getOutput(rack.mixerChannelId) })` | Rack gets its own mixer channel so it has fader/pan/sends like anything else |
| Track instrument | `track.instrument = { type:'rack', rackId }`; `TimelinePlayer` schedules clip notes into the rack's `MIDI IN` module via `onEvent` instead of `palette.createVoice` | Requires a small refactor of `timeline-player.js`'s MIDI branch: extract "note → instrument" to a strategy so `palette` and `rack` are two cases, not two copies |
| Mixer insert | `EffectChain` gains an effect type `rack` whose create returns `{ input, output }` from a mounted rack containing `AUDIO IN`/`OUT` | A rack without `AUDIO IN` used as an insert is a passthrough with a warning badge |
| Modulation source | `PARAM OUT` module names a target (`ch3.volume`, `ch1.eq3.high`, `master.volume`, `bus.reverb.return`); a 60 Hz control-thread poll of an `AnalyserNode` on the module's input applies the value via the existing `MixerEngine.set*` API | Control-rate by design; the panel says so. Smoothing via `setTargetAtTime` so 60 Hz stepping is inaudible |
| Transport clock | `TimelinePlayer` broadcasts `{ playing, beat, bpm }`; `rack-clock.js` derives 24 PPQN events and feeds `CLOCK` modules in `ext` mode | Transport is always master in v1. Rack-as-master is phase 2 |
| Bounce | `RackEngine.mount(offlineCtx, ...)` inside `TimelinePlayer.bounce` | Works only because factories take `ctx` as an argument (§5.2). Worklet-tier modules require `offlineCtx.audioWorklet.addModule` before rendering |

### 5.8 View structure

```text
components/rack-view.js       shell, toolbar, rails, drag/drop, zoom, keyboard patching
components/rack-panel.js      one module panel: knobs, jacks, LEDs, ARIA
components/rack-cables.js     canvas overlay: hit-testing, bezier sag, colours, activity
components/module-browser.js  grouped, searchable module drawer
rack/rack-layout.js           PURE: HP↔px, slot packing, collision, first-free-gap, tidy
rack/rack-engine.js           node graph reconciler
rack/rack-clock.js            transport → event-domain clock
rack/modules/*.js             module definitions
rack/modules/index.js         registry + validation
utils/cv.js                   PURE: volt/cent/Hz/MIDI conversions
```

`rack-layout.js`, `utils/cv.js`, `resolveChannels`, cable-path math, and patch (de)serialization are pure and carry the test weight. The view and the engine are the imperative shell.

## 6. Persistence

### 6.1 In-project

`state.racks` is part of the project JSON, so existing save/load (`FileAdapter`, `serialization.test.js`) covers it once the schema is added. Bump `DEFAULT_STATE.version` and add a migration step: a project at `version < 2` gets `racks: {}` and no other change.

### 6.2 Standalone patches

- Export: `.synthrack` — a JSON file `{ format:'synthrack', version:1, rack:{...} }`, no audio data, human-diffable.
- Import: validates against the registry, reports unknown module types by name instead of failing, places the rack as a new rack or replaces the current one (user choice).
- Preset library: 8–12 patches shipped as JSON under `src/renderer/presets/racks/`, loaded through the same import path so the shipped presets are continuously testing the importer. Suggested set: starter subtractive, poly pad (4 voices), FM bell, generative euclidean, kick drum, acid sequence, drone, CV utility bench, mixer-modulation demo.
- The importer is version-tolerant: unknown fields survive a round trip, missing fields take registry defaults.

## 7. Performance and Limits

| Budget | Target | Enforcement |
|---|---|---|
| Modules per rack | 64 comfortable, soft warning at 96 | Badge in toolbar showing module/cable/voice counts |
| Cables per rack | 128 | Canvas redraw is O(cables); cached paths, redraw only on change |
| Poly voices | 8 native / 16 worklet | `rack.polyLimit`, warning above 6 voices × 24 modules |
| UI frame time | < 8 ms during cable drag at 64 modules | Cable canvas redraws only the dragged cable using a cached background layer |
| Audio | No `dispose` leaks; oscillator count stable across 100 patch edits | Test: mount → 100 random valid edits → unmount, assert node count returns to baseline |
| Reconcile | < 5 ms for a single-cable change on a 64-module rack | Diff by id; never rebuild the graph wholesale |

Signal-activity animation and scope rendering share one 30 fps poll loop, suspended when the rack view is hidden — the same visibility discipline `switchMode` already applies to `startArrangeLoop`.

## 8. Testing

Vitest, matching the existing suite's style. New files:

| Test | Covers |
|---|---|
| `rack-layout.test.js` | HP↔px, first-free-gap, collision push, refusal when rail full, tidy |
| `cv.test.js` | 1 V/oct round trips, MIDI↔pitch CV, C4 = 0, gate scaling |
| `rack-registry.test.js` | Every module validates: unique ports, params have defaults, worklet modules declare processors, HP > 0 |
| `rack-poly.test.js` | `resolveChannels` — chain reaction, MERGE/SPLIT, cap clamping, cycles |
| `rack-engine.test.js` | Mount/update/unmount with a stub context: node counts, no churn on move, cycle detection inserts delay, dispose leaves nothing |
| `rack-store.test.js` | Commands + undo/redo, cable removal on module delete, coalesced knob drags |
| `rack-patch-io.test.js` | Export → import round trip, unknown module preserved, version migration, every shipped preset imports clean |
| `rack-view.test.js` | jsdom: renders panels, jack ARIA labels, keyboard patching sequence, worklet-tier hiding |

Engine tests use a minimal fake `BaseAudioContext` (create*, connect/disconnect counters) rather than a real one — the same approach `effect-chain.test.js` and `mixer-engine` usage already imply.

## 9. Risks

| Risk | Mitigation |
|---|---|
| Worklet tier unavailable on LAN silently degrades patches | Explicit placeholder panels + badge; no worklet module in the starter patch or basic voice chain; capability flag surfaced in the toolbar |
| Poly explodes node count and CPU | Hard cap, count badge, warning threshold, mixdown at mono modules |
| Cable canvas becomes the frame-rate bottleneck | Cached background layer, redraw only the dragged cable, activity animation capped at 30 fps and suspended when hidden |
| Scope creep into a plugin platform | v1 non-goals in §3.5 are binding; the registry stays internal |
| `timeline-player` MIDI branch forked into palette vs rack copies | Extract the note-scheduling strategy once, in phase 3, before adding the rack case |
| Undo stack flooded by knob drags | Coalesce on pointer-up via a shared helper |

## 10. Sources

- [VCV Rack Manual — Polyphony](https://vcvrack.com/manual/Polyphony)
- [Cabling Conventions in VCV Rack — a user interface note](https://soundand.design/cabling-conventions-in-vcv-rack-a-user-interface-note-a13e7453d957)
- [How polyphonic cables will work in Rack v1 — VCV Community](https://community.vcvrack.com/t/how-polyphonic-cables-will-work-in-rack-v1/1464)
- [NoiseCraft README — maximecb/noisecraft](https://github.com/maximecb/noisecraft/blob/main/README.md)
- [NoiseCraft: a Browser-Based Visual Programming Language for Sound & Music](https://pointersgonewild.com/2021/12/05/noisecraft-a-browser-based-visual-programming-language-for-sound-music/)
- [Zupiter: a Web-Based Modular Synthesizer](https://pointersgonewild.com/2019/10/06/zupiter-a-web-based-modular-synthesizer/)
- [Audulus Documentation](https://docs.audulus.com/)
- [Hexen — Modular Synthesizer (Google Play)](https://play.google.com/store/apps/details?id=com.silicondroid.hexen)
- [Building Modular Audio Nodes in Web Audio — Casey Primozic](https://cprimozic.net/blog/building-modular-audio-nodes-in-web-audio/)
- [MDN — Web Audio API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API)
- [MDN — AudioWorklet](https://developer.mozilla.org/en-US/docs/Web/API/AudioWorklet)
- [W3C Web Audio API 1.1](https://www.w3.org/TR/webaudio-1.1/)
