// Offline bounce model: fresh boot + replay a 4-bar MIDI phrase (felucca, 120 bpm, 8 s + 1 s tail) to PCM, timed, twice (+ optional extra process).
//   node offline.mjs [--fw felucca] [--mhz 240] [--runs 2]  -> JSON on stdout
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { jitImports } from './vendor/jit.js';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const arg = (n, d) => { const i = process.argv.indexOf(n); return i < 0 ? d : process.argv[i + 1]; };
const FILES = { felucca: 'felucca-1.8.4.fwsc', sloop: 'sloop-2.8.5.fwsc', dock: 'fm1-dock-1.0.1-digital.fwsc', v15: 'FM-1_015.fwsc' };
const fw = arg('--fw', 'felucca'), mhz = +arg('--mhz', 240), runs = +arg('--runs', 2), CH = 128, HZ = 44100;
const wasmBytes = readFileSync(path.join(HERE, 'vendor/fm1_web.wasm'));
const pkg = readFileSync(path.join('E:/tmp/fm1-firmware', FILES[fw]));
// phrase: 16 steps of 0.5 s (8th... 120 bpm quarter = 0.5 s; 4 bars = 16 quarters), note every quarter, gate 0.4 s
const PITCH = [60, 64, 67, 72, 62, 65, 69, 74, 60, 64, 67, 72, 59, 62, 67, 71];
const events = [];   // {frame, bytes}
PITCH.forEach((n, i) => { events.push({ frame: Math.round(i * 0.5 * HZ), bytes: [0x90, n, 100] }); events.push({ frame: Math.round((i * 0.5 + 0.4) * HZ), bytes: [0x80, n, 0] }); });
async function bounce() {
  const t0 = performance.now();
  const module = await WebAssembly.compile(wasmBytes);
  let x; const stats = { regions: 0, failed: 0, bytes: 0, compileMs: 0, compileMaxMs: 0 };
  x = (await WebAssembly.instantiate(module, { env: jitImports(() => x, stats) })).exports;
  x.fm1_jit(1, 16); x.fm1_flash_part?.(0); x.fm1_ahead(1024);
  const p = x.fm1_alloc(pkg.length); new Uint8Array(x.memory.buffer, p, pkg.length).set(pkg);
  if (x.fm1_boot_fwsc(p, pkg.length, 0, 0, mhz) !== 0) throw new Error('boot');
  let playing = false;
  const rnd = (n) => { const h = x.fm1_render(n, playing ? mhz * 1e6 * 1.5 * n / HZ : mhz * 1e6 * 0.02); if (h > 0) playing = true; return h; };
  while (!playing && x.fm1_ms() < 20000) rnd(CH);
  for (let i = 0; i < 2 * HZ / CH; i++) rnd(CH);   // settle 2 s (startup sound), same every run: phrase frame 0 = this chunk
  const total = Math.round(9 * HZ / CH) * CH, out = new Float32Array(total * 2);
  const tr = performance.now();
  let ei = 0;
  for (let f = 0; f < total; f += CH) {
    while (ei < events.length && events[ei].frame <= f) { for (const b of events[ei].bytes) x.fm1_midi(b); ei++; }
    rnd(CH);
    const b = x.memory.buffer, l = new Float32Array(b, x.fm1_out_l(), CH), r = new Float32Array(b, x.fm1_out_r(), CH);
    for (let i = 0; i < CH; i++) { out[(f + i) * 2] = l[i]; out[(f + i) * 2 + 1] = r[i]; }
  }
  const renderMs = performance.now() - tr;
  let pk = 0, s = 0; for (const v of out) { if (Math.abs(v) > pk) pk = Math.abs(v); s += v * v; }
  return { sha: createHash('sha256').update(Buffer.from(out.buffer)).digest('hex'), totalMs: performance.now() - t0, renderMs, audioSec: total / HZ, rtf: total / HZ / (renderMs / 1000), peak: pk, rms: Math.sqrt(s / out.length), jitFailed: stats.failed, halted: x.fm1_halted() };
}
const rs = []; for (let i = 0; i < runs; i++) rs.push(await bounce());
console.log(JSON.stringify({ fw, mhz, runs: rs, identical: rs.every((r) => r.sha === rs[0].sha) }, null, 1));
