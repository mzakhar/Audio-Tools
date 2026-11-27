// Path A host: a plain (classic) Worker running the emulator. Self-contained (no imports) so it also works as a blob worker.
// init {wasm,pkg,mhz,jit,chunk,leadMs} -> ready; go {mode:'paced'|'free',dur} ; midi {id,bytes,atFrame?}; stop ; probe.
const HZ = 44100;
let starved0 = 0, x, stats, cfg, playing = false, produced = 0, running = false, queue = [], t0 = 0, busy = 0, worst = 0, short = 0, rev = -1, lcdAt = 0, lastRms = 0;
const post = (m, t) => self.postMessage(m, t || []);
function jitImports(exports, st) {   // verbatim logic of vendor/jit.js
  let next;
  return { fm1_jit_compile(ptr, len, hRead, hWrite, hOp) {
    const start = performance.now();
    try {
      const e = exports();
      const bytes = new Uint8Array(e.memory.buffer, ptr, len).slice();
      const table = e.__indirect_function_table;
      const env = { memory: e.memory, h_read: table.get(hRead), h_write: table.get(hWrite), h_op: table.get(hOp) };
      const run = new WebAssembly.Instance(new WebAssembly.Module(bytes), { env }).exports.run;
      if (next === undefined || next >= table.length) { next = table.length; table.grow(256); }
      const slot = next++; table.set(slot, run); st.regions++; st.bytes += len; return slot;
    } catch (err) { st.failed++; st.error = String(err); return 0; }
    finally { const d = performance.now() - start; st.compileMs += d; st.compileMaxMs = Math.max(st.compileMaxMs, d); }
  } };
}
const bootBudget = () => cfg.mhz * 1e6 * 0.02;
const playBudget = (n) => cfg.mhz * 1e6 * 1.5 * n / HZ;
function render(n) {
  const t = performance.now();
  const have = x.fm1_render(n, playing ? playBudget(n) : bootBudget());
  const d = performance.now() - t;
  if (playing) { busy += d; if (d > worst) worst = d; }
  if (have > 0 && !playing) playing = true;
  if (playing && have < n) short++;
  return have;
}
function views(n) { const b = x.memory.buffer; return [new Float32Array(b, x.fm1_out_l(), n), new Float32Array(b, x.fm1_out_r(), n)]; }
function lcdNonZero() { const u = new Uint16Array(x.memory.buffer, x.fm1_lcd(), 240 * 240); for (let i = 0; i < u.length; i++) if (u[i]) return true; return false; }
function sendLcd() {
  const r = x.fm1_lcd_revision();
  if (r !== rev && cfg.lcd) { rev = r; const l = new Uint16Array(x.memory.buffer, x.fm1_lcd(), 240 * 240).slice(); post({ type: 'lcd', lcd: l }, [l.buffer]); }
}
async function init(m) {
  cfg = m;
  const t = performance.now();
  stats = { regions: 0, failed: 0, bytes: 0, compileMs: 0, compileMaxMs: 0, error: '' };
  let mod;
  try { mod = await WebAssembly.compile(m.wasm); } catch (err) { return post({ type: 'error', stage: 'compile', message: String(err) }); }
  try { x = (await WebAssembly.instantiate(mod, { env: m.jit ? jitImports(() => x, stats) : { fm1_jit_compile: () => 0 } })).exports; }
  catch (err) { return post({ type: 'error', stage: 'instantiate', message: String(err) }); }
  const compileMs = performance.now() - t;
  x.fm1_jit(m.jit ? 1 : 0, m.jit ? 16 : 0); x.fm1_flash_part?.(0); x.fm1_ahead(1024);
  const p = x.fm1_alloc(m.pkg.byteLength);
  new Uint8Array(x.memory.buffer, p, m.pkg.byteLength).set(new Uint8Array(m.pkg));
  if (x.fm1_boot_fwsc(p, m.pkg.byteLength, 0, 0, m.mhz) !== 0) return post({ type: 'error', stage: 'boot', message: 'fm1_boot_fwsc failed' });
  const rev0 = x.fm1_lcd_revision();
  let lcdMs = null, audioMs = null, emuAtAudio = null;
  while (!(playing && lcdMs !== null) && x.fm1_ms() < 8000 && !x.fm1_halted()) {
    render(128);
    if (playing && audioMs === null) { audioMs = performance.now() - t; emuAtAudio = x.fm1_ms(); }
    if (lcdMs === null && x.fm1_lcd_revision() !== rev0 && lcdNonZero()) lcdMs = performance.now() - t;
  }
  busy = worst = short = 0;
  post({ type: 'ready', compileMs, lcdMs, audioMs, bootEmuMs: x.fm1_ms(), playing, halted: x.fm1_halted() });
}
function go(m) {
  produced = 0; busy = worst = short = 0; running = true; t0 = performance.now(); lcdAt = 0;
  starved0 = x.fm1_starved();
  const finish = (extra) => { running = false; post({ type: 'final', ...extra, producedSec: produced / HZ, wallSec: (performance.now() - t0) / 1000, busyMs: busy, worstMs: worst,
    short, starved: x.fm1_starved() - starved0, halted: x.fm1_halted(), cpu1Fault: x.fm1_cpu1_fault(), jit: stats }); };
  const n = cfg.chunk;
  if (m.mode === 'free') {   // as fast as possible: chord on both channels every 4 s like the node bench
    const total = Math.round(m.dur * HZ), every = Math.round(4 * HZ / n); let k = 0, peak = 0;
    const chord = (on) => { for (const ch of [0, 1]) for (const nn of [60, 64, 67]) for (const b of [(on ? 0x90 : 0x80) | ch, nn, on ? 100 : 0]) x.fm1_midi(b); };
    while (produced < total) {
      if (m.notes && k % every === 0) { if (k) chord(false); chord(true); }
      k++; render(n); produced += n;
      const [l] = views(n); for (let i = 0; i < n; i += 64) if (Math.abs(l[i]) > peak) peak = Math.abs(l[i]);
    }
    return finish({ mode: 'free', peak });
  }
  const leadFrames = cfg.leadMs * HZ / 1000;
  const pump = () => {
    if (!running) return;
    const t = performance.now();
    const target = (t - t0) / 1000 * HZ + leadFrames;
    while (produced < target && performance.now() - t < 40) {
      while (queue.length && (queue[0].atFrame === undefined || produced >= queue[0].atFrame)) {
        const q = queue.shift(); for (const b of q.bytes) x.fm1_midi(b); post({ type: 'inj', id: q.id, frame: produced });
      }
      const rt = performance.now();
      const have = render(n);
      const ms = performance.now() - rt;
      const [l, r] = views(n);
      let s = 0; for (let i = 0; i < n; i++) s += l[i] * l[i] + r[i] * r[i];
      const L = l.slice(), R = r.slice(), rms = Math.sqrt(s / (2 * n));
      post({ type: 'block', l: L, r: R, frame: produced, rms, have, ms, wall: performance.now() }, [L.buffer, R.buffer]);
      produced += n;
    }
    if (performance.now() - lcdAt > 100) { lcdAt = performance.now(); sendLcd(); }
    setTimeout(pump, 1);
  };
  pump();
}
async function probe(m) {
  const r = {};
  try { await WebAssembly.compile(m.wasm); r.compile = 'ok'; } catch (err) { r.compile = String(err); }
  try { await WebAssembly.instantiate(m.wasm, { env: { fm1_jit_compile: () => 0 } }); r.instantiateInterp = 'ok'; } catch (err) { r.instantiateInterp = String(err); }
  try { new WebAssembly.Module(m.tiny); r.syncTiny = 'ok'; } catch (err) { r.syncTiny = String(err); }
  post({ type: 'probe', r });
}
self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'init') init(m).catch((err) => post({ type: 'error', stage: 'init', message: String(err) }));
  else if (m.type === 'go') go(m);
  else if (m.type === 'midi') queue.push(m);
  else if (m.type === 'stop') { if (running) { running = false; post({ type: 'final', mode: 'paced', producedSec: produced / HZ, wallSec: (performance.now() - t0) / 1000, busyMs: busy, worstMs: worst, short, starved: x.fm1_starved() - starved0,
    halted: x.fm1_halted(), cpu1Fault: x.fm1_cpu1_fault(), jit: stats }); } }
  else if (m.type === 'probe') probe(m);
};
