// FM-1 phase-0 node bench. No deps.
//   node spikes/fm1/bench.mjs [--fw-dir E:/tmp/fm1-firmware] [--quick]      full matrix -> results/node-bench.{json,md}
//   node spikes/fm1/bench.mjs --job '<json>'                                one job in this process, JSON to stdout
// Each job runs in its own child process so peak RSS is per job.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { jitImports } from './vendor/jit.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HZ = 44100;
const FIRMWARE = {
  felucca: { file: 'felucca-1.8.4.fwsc', ch: 0 },
  sloop: { file: 'sloop-2.8.5.fwsc', ch: 0 },
  dock: { file: 'fm1-dock-1.0.1-digital.fwsc', ch: 0 },
  v15: { file: 'FM-1_015.fwsc', ch: 1 },
};
const now = () => performance.now();
const wasmBytes = readFileSync(path.join(HERE, 'vendor/fm1_web.wasm'));
const arg = (n, d) => { const i = process.argv.indexOf(n); return i < 0 ? d : process.argv[i + 1]; };
const fwDir = arg('--fw-dir', 'E:/tmp/fm1-firmware');

// One emulator instance, host loop as worklet.js: boot budget until audio flows, then 1.5 quanta.
async function create({ fw, mhz, jit, chunk }) {
  const t0 = now();
  const module = await WebAssembly.compile(wasmBytes);
  let x;
  const stats = { regions: 0, failed: 0, bytes: 0, compileMs: 0, compileMaxMs: 0 };
  x = (await WebAssembly.instantiate(module, { env: jit ? jitImports(() => x, stats) : { fm1_jit_compile: () => 0 } })).exports;
  const compileMs = now() - t0;
  x.fm1_jit(jit ? 1 : 0, jit ? 16 : 0);
  x.fm1_flash_part?.(0);
  x.fm1_ahead(1024);
  const pkg = readFileSync(path.join(fwDir, FIRMWARE[fw].file));
  const p = x.fm1_alloc(pkg.length);
  new Uint8Array(x.memory.buffer, p, pkg.length).set(pkg);
  const tb = now();
  if (x.fm1_boot_fwsc(p, pkg.length, 0, 0, mhz) !== 0) throw new Error('boot failed ' + fw);
  const bootCallMs = now() - tb;
  const bootBudget = mhz * 1e6 * 0.02;
  const playBudget = (n) => mhz * 1e6 * 1.5 * n / HZ;
  const inst = {
    x, stats, compileMs, bootCallMs, playing: false, frames: 0, chunk,
    // returns { have, l, r } views valid until next render
    render(n = chunk) {
      const have = x.fm1_render(n, inst.playing ? playBudget(n) : bootBudget);
      if (have > 0 && !inst.playing) inst.playing = true;
      inst.frames += n;
      const b = x.memory.buffer;
      return { have, l: new Float32Array(b, x.fm1_out_l(), n), r: new Float32Array(b, x.fm1_out_r(), n) };
    },
    midi(bytes) { for (const b of bytes) x.fm1_midi(b); },
    lcdNonZero() {
      const u = new Uint16Array(x.memory.buffer, x.fm1_lcd(), 240 * 240);
      for (let i = 0; i < u.length; i++) if (u[i]) return true;
      return false;
    },
  };
  return inst;
}

const rms = (l, r) => { let s = 0; for (let i = 0; i < l.length; i++) s += l[i] * l[i] + r[i] * r[i]; return Math.sqrt(s / (2 * l.length)); };
const emuMs = (i) => i.x.fm1_ms();

// ---- jobs ----
async function jobBoot(o) {
  const i = await create(o);
  const rev0 = i.x.fm1_lcd_revision();
  const t0 = now();
  let lcdMs = null, lcdEmu = null, audioMs = null, audioEmu = null, pk = 0;
  while ((lcdMs === null || audioMs === null) && emuMs(i) < 20000) {
    const wasPlaying = i.playing;
    const { have, l, r } = i.render(128);
    if (lcdMs === null && i.x.fm1_lcd_revision() !== rev0 && i.lcdNonZero()) { lcdMs = now() - t0; lcdEmu = emuMs(i); }
    if (audioMs === null && i.playing) { audioMs = now() - t0; audioEmu = emuMs(i); }
    if (i.x.fm1_halted()) break;
  }
  return { bootCallMs: i.bootCallMs, compileMs: i.compileMs, lcdMs, lcdEmuMs: lcdEmu, audioMs, audioEmuMs: audioEmu, halted: i.x.fm1_halted() };
}

async function jobRtf(o) {
  const seconds = o.seconds ?? 30;
  const i = await create(o);
  // warm to first audio (boot), untimed
  while (!i.playing && emuMs(i) < 20000) i.render(128);
  const startEmu = emuMs(i), starved0 = i.x.fm1_starved();
  const total = Math.round(seconds * HZ), n = o.chunk;
  let done = 0, short = 0, worst = 0, peak = 0;
  const chord = (on) => { for (const ch of [0, 1]) for (const nn of [60, 64, 67]) i.midi([(on ? 0x90 : 0x80) | ch, nn, on ? 100 : 0]); };
  const every = Math.round(4 * HZ / n); let k = 0;
  const t0 = now();
  while (done < total) {
    if (o.notes !== false && k % every === 0) { if (k) chord(false); chord(true); }
    k++;
    const t = now();
    const { have, l } = i.render(n);
    const d = now() - t; if (d > worst) worst = d;
    if (have < n) short++;
    for (let k = 0; k < n; k += 64) if (Math.abs(l[k]) > peak) peak = Math.abs(l[k]);
    done += n;
  }
  const wall = (now() - t0) / 1000;
  return {
    audioSec: done / HZ, wallSec: wall, rtf: done / HZ / wall, shortChunks: short, chunks: Math.ceil(total / n),
    starvedHalves: i.x.fm1_starved() - starved0, emuMsAdvanced: emuMs(i) - startEmu, worstChunkMs: worst, peakAbs: peak, notes: o.notes !== false,
    halted: i.x.fm1_halted(), cpu1Fault: i.x.fm1_cpu1_fault(), jitStats: i.stats, rssMB: process.resourceUsage().maxRSS / 1024,
  };
}

// MIDI proof: settle, then try note on ch1 and ch2 each; report RMS ratios.
async function jobMidi(o) {
  const i = await create(o);
  const run = (sec) => { let s = 0, c = 0; const n = Math.round(sec * HZ / o.chunk); for (let k = 0; k < n; k++) { const { l, r } = i.render(o.chunk); s += rms(l, r) ** 2; c++; } return Math.sqrt(s / c); };
  while (!i.playing && emuMs(i) < 20000) i.render(o.chunk);
  run(6); // settle (startup jingles, LCD init)
  const out = { baseline: run(1) };
  for (const ch of [0, 1]) {
    i.midi([0x90 | ch, 60, 110]);
    const on = run(1.0);
    i.midi([0x80 | ch, 60, 0]);
    const tail = run(1.0);
    const quiet = run(1.0);
    out['ch' + (ch + 1)] = { on, tail, quiet, ratio: on / Math.max(out.baseline, 1e-9) };
  }
  out.proof = Math.max(out.ch1.ratio, out.ch2.ratio) > 3 && Math.max(out.ch1.on, out.ch2.on) > 1e-3;
  return out;
}

// Determinism: 10 s from fresh boot, note on at chunk 800 / off at 1800 (128-frame chunks), hash float output.
async function renderHash(o) {
  const i = await create(o);
  const h = createHash('sha256');
  const total = Math.round(10 * HZ / o.chunk);
  const on = Math.round(800 * 128 / o.chunk), off = Math.round(1800 * 128 / o.chunk);
  for (let k = 0; k < total; k++) {
    if (k === on) i.midi([0x90 | o.midiCh, 60, 100]);
    if (k === off) i.midi([0x80 | o.midiCh, 60, 0]);
    const { l, r } = i.render(o.chunk);
    h.update(Buffer.from(l.buffer, l.byteOffset, l.byteLength)); h.update(Buffer.from(r.buffer, r.byteOffset, r.byteLength));
  }
  return h.digest('hex');
}
async function jobDet(o) {
  const a = await renderHash({ ...o, jit: false }), b = await renderHash({ ...o, jit: false });
  const c = await renderHash({ ...o, jit: true }), d = await renderHash({ ...o, jit: true });
  return { interp1: a, interp2: b, jit1: c, jit2: d, interpEq: a === b, jitEq: c === d, jitVsInterp: a === c };
}

// N parallel instances in worker_threads.
async function jobPar(o) {
  const t0 = now();
  const res = await Promise.all(Array.from({ length: o.n }, () => new Promise((ok, bad) => {
    const w = new Worker(fileURLToPath(import.meta.url), { workerData: { job: 'rtf', o: { ...o, seconds: o.seconds ?? 15 } } });
    w.on('message', ok); w.on('error', bad);
  })));
  const rtfs = res.map((r) => r.rtf);
  return { n: o.n, rtfs, minRtf: Math.min(...rtfs), sumRtf: rtfs.reduce((a, b) => a + b, 0), wallSec: (now() - t0) / 1000, rssMB: process.resourceUsage().maxRSS / 1024 };
}

const JOBS = { boot: jobBoot, rtf: jobRtf, midi: jobMidi, det: jobDet, par: jobPar };

if (!isMainThread) {
  parentPort.postMessage(await JOBS[workerData.job](workerData.o));
} else if (arg('--job')) {
  const { job, o } = JSON.parse(arg('--job'));
  console.log(JSON.stringify({ job, o, r: await JOBS[job](o) }));
} else if (process.argv.includes('--render')) {
  // (defined below; run after module evaluation)
} else {
  await orchestrate();
}

function child(job, o) {
  const cmd = ['--max-old-space-size=4096', fileURLToPath(import.meta.url), '--fw-dir', fwDir, '--job', JSON.stringify({ job, o })];
  try {
    const out = execFileSync(process.execPath, cmd, { encoding: 'utf8', maxBuffer: 1 << 26, timeout: 900000 });
    return JSON.parse(out.trim().split('\n').pop()).r;
  } catch (e) { return { error: String(e.message).slice(0, 300) }; }
}

async function orchestrate() {
  const quick = process.argv.includes('--quick');
  const sec = quick ? 5 : 30;
  const cpu = os.cpus();
  const env = { node: process.version, cpu: cpu[0].model, logical: cpu.length, ramGB: +(os.totalmem() / 2 ** 30).toFixed(1), wasmBytes: wasmBytes.length, wasmSha256: createHash('sha256').update(wasmBytes).digest('hex'), when: new Date().toISOString() };
  const out = { env, thresholds: 'RTF>=1.5 PASS, 1.0-1.5 MARGINAL, <1.0 FAIL at 240 MHz; boot <3 s; 0 starved', boot: [], rtf: [], midi: [], det: [], par: [] };
  const log = (...a) => console.error(...a);
  for (const fw of Object.keys(FIRMWARE)) {
    for (const jit of [false, true]) {
      for (const mhz of [240, 100]) {
        const chunks = mhz === 240 ? [128, 1024] : [128];
        log(`boot ${fw} jit=${jit} ${mhz}`);
        out.boot.push({ fw, jit, mhz, ...child('boot', { fw, jit, mhz, chunk: 128 }) });
        for (const chunk of chunks) {
          log(`rtf ${fw} jit=${jit} ${mhz} chunk=${chunk}`);
          out.rtf.push({ fw, jit, mhz, chunk, ...child('rtf', { fw, jit, mhz, chunk, seconds: jit ? sec : Math.min(sec, 8) }) });
          if (jit && mhz === 240 && chunk === 128) out.rtf.push({ fw, jit, mhz, chunk, idle: true, ...child('rtf', { fw, jit, mhz, chunk, seconds: sec, notes: false }) });
        }
      }
    }
    log(`midi ${fw}`);
    out.midi.push({ fw, ...child('midi', { fw, jit: true, mhz: 240, chunk: 128 }) });
    log(`det ${fw}`);
    out.det.push({ fw, midiCh: 0, ...child('det', { fw, mhz: 240, chunk: 128, midiCh: 0 }) });
  }
  for (const jit of [false, true]) for (const n of [2, 4]) {
    log(`par felucca jit=${jit} n=${n}`);
    out.par.push({ fw: 'felucca', jit, ...child('par', { fw: 'felucca', jit, mhz: 240, chunk: 128, n, seconds: quick ? 5 : 15 }) });
  }
  mkdirSync(path.join(HERE, 'results'), { recursive: true });
  writeFileSync(path.join(HERE, 'results/node-bench.json'), JSON.stringify(out, null, 1));
  writeFileSync(path.join(HERE, 'results/node-bench.md'), toMd(out));
  console.log(toMd(out));
}

const f = (v, d = 2) => (typeof v === 'number' ? v.toFixed(d) : v ?? '-');
const isJit = (r) => (r.jitStats ?? r.jit)?.regions > 0;
const jst = (r) => r.jitStats ?? (typeof r.jit === 'object' ? r.jit : null);
const verdict = (rtf) => (rtf >= 1.5 ? 'PASS' : rtf >= 1 ? 'MARGINAL' : 'FAIL');
function toMd(o) {
  const L = [];
  L.push('# FM-1 node bench', '', `Env: ${o.env.cpu}, ${o.env.logical} threads, ${o.env.ramGB} GB, node ${o.env.node}`, `wasm: ${o.env.wasmBytes} B sha256 ${o.env.wasmSha256}`, `Thresholds: ${o.thresholds}`, '');
  L.push('Reproduce: `node spikes/fm1/bench.mjs` (firmware in E:/tmp/fm1-firmware) ; single job: `node spikes/fm1/bench.mjs --job \'{"job":"rtf","o":{"fw":"felucca","jit":true,"mhz":240,"chunk":128,"seconds":30}}\'`', '');
  L.push('## RTF (emulated audio s / wall s)', '', '| fw | mode | MHz | chunk | RTF | verdict@240 | starved halves | short chunks | worst chunk ms | rss MB | halted | jit regions/failed |', '|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of o.rtf) L.push(`| ${r.fw} | ${isJit(r) ? 'jit' : 'interp'}${r.idle ? ' idle(no notes)' : ''} | ${r.mhz} | ${r.chunk} | ${f(r.rtf)} | ${r.mhz === 240 ? verdict(r.rtf) : '-'} | ${r.starvedHalves ?? r.error} | ${r.shortChunks} | ${f(r.worstChunkMs, 1)} | ${f(r.rssMB, 0)} | ${r.halted} | ${jst(r) ? jst(r).regions + '/' + jst(r).failed : '-'} |`);
  L.push('', '## Boot (to first non-zero LCD frame / first non-silent audio)', '', '| fw | mode | MHz | wasm compile ms | boot call ms | LCD wall ms | LCD emu ms | audio wall ms | audio emu ms |', '|---|---|---|---|---|---|---|---|---|');
  for (const r of o.boot) L.push(`| ${r.fw} | ${r.jit ? 'jit' : 'interp'} | ${r.mhz} | ${f(r.compileMs, 0)} | ${f(r.bootCallMs, 0)} | ${f(r.lcdMs, 0)} | ${f(r.lcdEmuMs, 0)} | ${f(r.audioMs, 0)} | ${f(r.audioEmuMs, 0)} |`);
  L.push('', '## MIDI proof (RMS; note 60 vel 110, 1 s on)', '', '| fw | baseline | ch1 on | ch1 ratio | ch2 on | ch2 ratio | proof |', '|---|---|---|---|---|---|---|');
  for (const r of o.midi) L.push(`| ${r.fw} | ${f(r.baseline, 5)} | ${f(r.ch1?.on, 5)} | ${r.baseline < 1e-6 ? 'baseline silent' : f(r.ch1?.ratio, 1)} | ${f(r.ch2?.on, 5)} | ${r.baseline < 1e-6 ? 'baseline silent' : f(r.ch2?.ratio, 1)} | ${r.proof ?? r.error} |`);
  L.push('', '## Determinism (10 s, MIDI at fixed chunk idx, fresh instances, sha256 of f32 output)', '', '| fw | interp==interp | jit==jit | jit==interp | interp hash | jit hash |', '|---|---|---|---|---|---|');
  for (const r of o.det) L.push(`| ${r.fw} | ${r.interpEq} | ${r.jitEq} | ${r.jitVsInterp} | ${r.interp1?.slice(0, 16)} | ${r.jit1?.slice(0, 16)} |`);
  L.push('', '## Parallel instances (felucca, 240 MHz, worker_threads)', '', '| mode | n | per-instance RTF | min | sum |', '|---|---|---|---|---|');
  for (const r of o.par) L.push(`| ${r.jit ? 'jit' : 'interp'} | ${r.n} | ${r.rtfs?.map((v) => f(v)).join(', ')} | ${f(r.minRtf)} | ${f(r.sumRtf)} |`);
  return L.join('\n') + '\n';
}

if (isMainThread && process.argv.includes('--render')) {
  const o = JSON.parse(readFileSync(path.join(HERE, 'results/node-bench.json'), 'utf8'));
  writeFileSync(path.join(HERE, 'results/node-bench.md'), toMd(o));
}
