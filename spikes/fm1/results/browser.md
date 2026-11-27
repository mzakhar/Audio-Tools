# FM-1 phase 0 S2 - browser + Electron results

Host: Electron 33.4.11 (Chromium 130.0.6723.191) driven by `spikes/fm1/drive.cjs` (executeJavaScript with user gesture; hidden windows, backgroundThrottling false). No chrome-devtools MCP / Playwright / puppeteer available; real Chrome was NOT run (same engine family, but Chrome-stable and Chrome autoplay policy are untested).
PC: Ryzen 7 2700X 8C/16T, 64 GB, Windows 11. AudioContext default rate 48000 (baseLatency 10 ms, Electron reports outputLatency 0). wasm = S1 build (sha 77bd2e2a...), JIT on unless stated.
Raw: `results/browser-raw/*.jsonl` (one line per job). Reproduce: `node spikes/fm1/serve.mjs --port 8099` (+ `--port 8098 --base /synth/` for the LAN case), then `node_modules/electron/dist/electron.exe spikes/fm1/drive.cjs <jobs.json> <out.jsonl>`; offline: `node spikes/fm1/offline.mjs`.
Pages: `live.html/live.js` (UI, Path A/B hosts, probes), `fm1-worker.js` (Path A emulator Worker), `fm1-tap.js` (pass-through worklet: RMS-crossing latency, process() gap stalls, CSP probe), `vendor/worklet.js` (Path B = upstream worklet verbatim).

## Thresholds (declared before measuring)
RTF >= 1.5 PASS / 1.0-1.5 MARGINAL / <1.0 FAIL; 0 underruns per 60 s; latency <= 30 ms; boot < 3 s.

## 1. CSP matrix (wasm compile; "BLOCK" = `Refused to compile or instantiate WebAssembly module because 'unsafe-eval' is not an allowed source of script in the following Content Security Policy directive: "script-src 'self'"`)
Cells: compile / instantiate (interpreter stub import) / sync `new WebAssembly.Module` (what the JIT uses).
| delivery | policy | main thread | Worker | AudioWorklet | Path A boots | Path B boots |
|---|---|---|---|---|---|---|
| none | - | ok | ok | ok | yes | yes |
| meta (= prod, src/renderer/index.html:6) | current | BLOCK all | **ok all** | BLOCK | **yes** | NO (boot: CompileError, same text) |
| meta | + `'wasm-unsafe-eval'` | ok | ok | ok | yes | yes |
| response header on page + worker script | current | BLOCK | BLOCK | BLOCK | NO (CompileError in worker) | NO |
| header | + wasm-unsafe-eval | ok | ok | ok | yes | - |
| header wasm + meta current | | BLOCK | ok (worker has its own header) | BLOCK | yes | - |
| header current + meta wasm | | BLOCK | BLOCK | BLOCK | NO | - |
| file:// (loadFile) meta none / current / wasm | | ok / BLOCK / ok | ok / ok / ok | ok / BLOCK / ok | yes / yes / yes | - |
| LAN http insecure meta none / current / wasm | | ok / BLOCK / ok | ok / ok / ok | no ctx.audioWorklet | A yes | B: "no audioWorklet" |
Findings:
- Interpreter mode does not avoid the CSP: `WebAssembly.compile/instantiate` of the 3.5 MB core itself is blocked on the main thread and in worklets under the current CSP (no `wasm-unsafe-eval`). JIT regions need the same permission (sync `new WebAssembly.Module`).
- A `<meta>` CSP does not apply to a same-origin Worker created from a URL (a Worker's policy comes from its own script response). With the prod setup (meta only, no CSP headers in nginx/Electron) Path A in a Worker compiles and JITs fine under the current CSP, unmodified. AudioWorklets inherit the document policy, so Path B needs `'wasm-unsafe-eval'`. Any CSP response header (a future Cloudflare/Traefik/nginx header) would break Path A too. Recommendation: add `'wasm-unsafe-eval'` to script-src regardless (one token, no eval of strings); do not rely on the Worker loophole.
- file:// under Electron: fetch() of a file:// wasm works; Workers from file:// work; `new Worker` from file:// needs no workaround. No `securitypolicyviolation` events were delivered (blocked compiles throw CompileError instead).

## 2. Free-run RTF in the browser (Worker, 128-frame chunks, 15 s, chord on ch1+ch2 every 4 s, includes JIT compile ~0.2-1.1 s)
| fw | 240 MHz 1 inst | 240 MHz 2 inst (each) | 120 MHz 1 inst | 120 MHz 2 inst (each) | boot->LCD @240 (ms) | worst chunk ms |
|---|---|---|---|---|---|---|
| Felucca 1.8.4 | 0.93 FAIL(marginal-low) | 1.05 / 1.03 | 1.62 PASS | 1.64 / 1.65 | 342 | 24-46 |
| SLOOP 2.8.5 | 0.89 FAIL | 0.98 / 0.99 | 1.60 PASS | 1.52 / 1.52 | 438 | 32-50 |
| FM1-Dock 1.0.1 | 1.52 PASS | 1.65 / 1.62 | 2.83 PASS | 2.84 / 2.77 | 645 | 8-13 |
| V15 stock | 0.54 FAIL | 0.62 / 0.62 | 0.70 FAIL (12 starved) | 0.73 / 0.73 (12 starved) | 1011 | 19-27 |
- Browser single-instance 240 MHz is ~10-15% below node (felucca 0.93 vs 1.08). Run-to-run noise ~10% (the 2-instance row beat the 1-instance row).
- **Two instances (two Workers) do not degrade in the browser** (felucca 240: 1.05/1.03 each, vs node's 0.71 each). The node worker_threads result was a node artifact, not a CPU limit. 4 instances not re-measured.
- Boot to first non-zero LCD frame 275-1011 ms (<3 s) everywhere; V15 slowest.
- JIT compile failures 0 everywhere; ~1200-1400 regions, 1.2-1.3 MB, 0.2-1.1 s total compile.

## 3. Path A (Worker + AudioBufferSource scheduling), paced, lead 80 ms, 60 s, 1 instance (underruns = resync events when a block arrives after its slot)
| fw | MHz | underruns | gap ms | worker busy | latency tap median [min-max] ms (n=20) |
|---|---|---|---|---|---|
| Felucca | 240 | 54 | 114 | 0.87 | 285 [35-333] (unreliable, see note) |
| Felucca | 120 | 3 | 8 | 0.54 | 117 [112-125] |
| SLOOP | 240 | 967 | 1827 | 0.87 | 53 (queue drained) |
| SLOOP | 120 | 7 | 33 | 0.61 | 160 [152-168] |
| Dock | 240 | 0 | 0 | 0.60 | 120 [115-125] |
| Dock | 120 | 0 | 0 | 0.35 | 125 [117-128] |
| V15 | 240 | 2531 | 6893 | 0.88 | 43 (queue drained) |
| V15 | 120 | 1591 | 3951 | 0.87 | 59 (queue drained) |
2 instances, lead 80, 60 s (underruns per instance, ~equal across the two): Felucca 240: 510/446; 120: 3/3. SLOOP 240: 1420/1484; 120: 6/6. Dock 240: 0/0; 120: 0/0. V15 240: 2997/3042; 120: 1505/1473. Latency 115-171 ms when not starved. Same pattern as 1 instance: two Workers cost nothing extra.
Notes: latency is note-post to first RMS>0.005 block entering the audio graph (tap worklet `currentTime`; scheduled-time method agrees within 1-2 ms), excluding hardware output buffer (+~10 ms baseLatency, outputLatency reported 0). It ~= lead + 20 ms main start pad + ~10-20 ms. When the Worker is not keeping up (RTF < ~1) the queue is drained, so the "latency" falls to 35-60 ms but the audio is glitching (hundreds of underruns): not a usable number. `dirty` (tail above threshold at note-on) = 0 for all runs. All Path A runs were gesture-granted; Electron default autoplay policy let an AudioContext run with no gesture (`no-user-gesture-required` is Electron's default); plain-Chrome gesture behaviour not tested.

### Lead sweep (30 s, 1 instance, underruns / total gap ms / latency median ms)
| fw @ MHz | lead 50 | lead 80 (60 s run) | lead 120 |
|---|---|---|---|
| Felucca 240 | 170 / 298 / 51* | 54 / 114 / 285* | 107 / 208 / 56* |
| Felucca 120 | 4 / 25 / 104 | 3 / 8 / 117 | 3 / 8 / 160 |
| Dock 240 | 0 / 0 / 88 | 0 / 0 / 120 | 0 / 0 / 155 |
| Dock 120 | 0 / 0 / 93 | 0 / 0 / 125 | 0 / 0 / 163 |
| V15 240 | 1240 / 3622 / 61* | 2531 / 6893 / 43* | 1110 / 3125 / 48* |
| V15 120 | 537 / 1350 / 80* | 1591 / 3951 / 59* | 713 / 1808 / 37* |
(* RTF ~1 or below: queue drained, latency not meaningful.) A longer lead does not fix an RTF<=1 firmware (underruns stay); at RTF>=1.6 (Felucca/SLOOP/Dock @120, Dock @240) lead 50 is already clean, giving ~90-105 ms note-to-audio. Latency tracks lead + ~45 ms: **the 30 ms latency target is not reachable with the lead needed to cover the 22-50 ms worst chunk.** Residual Felucca 120 underruns (3-4 per run) are within ~25 ms total.
Sample rate: Felucca lead 80 with AudioContext forced to 44100 (no resampling): 240 MHz 66 underruns / 120 MHz 6 (vs 54 / 3 at 48000 default): no meaningful difference; resampling via AudioBuffer@44100 on a 48000 context works with no audible-glitch proxy signal (tap stalls 0). Chunk 256 @120: 5 underruns (same as 128).

## 4. Path B (upstream worklet, ahead 1024), 30 s, notes every 2.6 s
Proxy for underruns: worklet intervals where emulation wall time > interval ("over"), and tap `process()` gaps > 25 ms ("stalls"; the tap's own message is unreliable when the render thread is saturated, shown n/a). Latency is the tap crossing (render-thread side, excludes device buffer).
| fw | MHz | over intervals | mean busy | max busy | worst quantum ms | stalls | latency median ms |
|---|---|---|---|---|---|---|---|
| Felucca | 240 | 140/933 | 0.91 | 2.19 | 27 | n/a | n/a (1 sample) |
| SLOOP | 240 | 490/846 | 1.00 | 3.00 | 34 | n/a | n/a |
| Dock | 240 | 10/976 | 0.67 | 2.91 | 23 | 1 (173 ms) | ~24 |
| V15 | 240 | 136/952 | 0.88 | 4.59 | 34 | n/a | n/a |
| Felucca | 120 | 6/897 | 0.57 | 2.34 | 32 | 2 (177 ms) | 11 [5-19] |
| SLOOP | 120 | 9/910 | 0.68 | 1.88 | 28 | 3 (169 ms) | 19 [13-27] |
| Dock | 120 | 3/942 | 0.38 | 2.11 | 28 | 1 (177 ms) | 16 [13-32] |
| V15 | 120 | 94/1087 | 0.77 | 5.28 | 23 | n/a | n/a |
2 instances (two worklet nodes), Felucca: 240 over 54/486 and 25/486; 120 over 2/816 each. Under B the 128-quantum deadline is hard (~2.7 ms) while a quantum can cost 20-35 ms; there is no queue, so B works only because Chrome's output buffering absorbs bursts; at 120 MHz about 1-3 glitch-prone stalls per 30 s were seen. B's upside is latency (~10-20 ms render-thread to graph + device buffer). Needs secure context: not available on the LAN http route.

## 5. LAN insecure origin (http://192.168.1.13:8098/synth/, base path works)
isSecureContext false, `AudioWorkletNode` global exists but `ctx.audioWorklet` is undefined -> Path B fails with an explicit error; Path A works: Felucca 240: 131 underruns/30 s, 120: 4 underruns/30 s, latency (scheduled-time method) 53 (drained) / 133 ms. `fetch`, Worker, wasm compile all fine; meta CSP behaves as in the table.

## 6. Electron (file://, `loadFile`, webPreferences as src/main/index.js:80-85 minus preload)
| Question | Answer |
|---|---|
| `isSecureContext` | **true** (file://) |
| `typeof AudioWorkletNode` / `ctx.audioWorklet` | function / present; `addModule` of a file:// worklet works |
| Workers from file:// | work (no blob fallback needed) |
| Wasm compile under meta CSP current | main thread + worklet BLOCK, Worker ok; with `wasm-unsafe-eval` all ok |
| Autoplay | AudioContext `running` with no gesture (Electron default policy) |
| Path A Felucca 30 s lead 80 | 240 MHz: 48 underruns / 106 ms gap, latency 107 ms; 120 MHz: 4 underruns / 28 ms, 141 ms |
| Path B Felucca 120 MHz, 10 s | boots under wasm CSP; over 4/319 intervals; 2 stalls |
(The http://localhost dev case of Electron main (index.js:89) behaves like the localhost results above.)

## 7. Offline bounce (node, `offline.mjs`)
Felucca 240 MHz, JIT: fresh boot, 2 s settle, 16-note phrase (4 bars @120 bpm, 8 s) + 1 s tail, 128-frame chunks, MIDI injected at the chunk whose frame >= event. 9 s PCM rendered in **7.25 s and 7.10 s (RTF 1.24-1.27 incl. JIT compile)**; sha256 of the float32 stereo output **identical across both runs and a separate process** (10e530bd184b...), peak 0.225, RMS 0.036. Bounce = reboot + replay is bit-exact. At 240 MHz it costs ~0.8x real time per Felucca track; a 3-min song ~ 2.4 min per track.

## Verdicts vs thresholds
- Boot < 3 s: PASS all (275-1011 ms).
- Live at 240 MHz on this PC: only Dock passes (RTF 1.52, 0 underruns). Felucca marginal-failing (54 underruns/60 s), SLOOP and V15 fail.
- Live at 120 MHz: Felucca, SLOOP, Dock viable on Path A (RTF 1.6-2.8, 0-7 underruns / 60 s, mostly sub-30 ms total); V15 fails even at 120 (RTF 0.70).
- Latency <= 30 ms: FAIL on Path A (>= ~90-125 ms for clean playback). Path B reaches 10-20 ms but glitches on stalls and is secure-context only.
- 2 instances: no penalty in browser.
