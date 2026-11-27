// FM-1 browser spike page. Query: path=A|B fw=felucca|sloop|dock|v15 mhz=240 lead=80 inst=1 dur=60 chunk=128
//   sr=default|44100 jit=1|0 mode=paced|free notes=1 csp=<header variant for the worker URL> probe=1 (CSP probe only)
// Result lands in window.__result (JSON-able). window.fm1spike.run() starts it (needs a user gesture for audio in a browser).
const q = new URLSearchParams(location.search);
const P = { path: q.get('path') || 'A', fw: q.get('fw') || 'felucca', mhz: +(q.get('mhz') || 240), lead: +(q.get('lead') || 80), inst: +(q.get('inst') || 1),
  dur: +(q.get('dur') || 60), chunk: +(q.get('chunk') || 128), sr: q.get('sr') || 'default', jit: q.get('jit') !== '0', mode: q.get('mode') || 'paced',
  notes: q.get('notes') !== '0', csp: q.get('csp') || '', probe: q.get('probe') === '1' };
const FW = { felucca: 'felucca-1.8.4.fwsc', sloop: 'sloop-2.8.5.fwsc', dock: 'fm1-dock-1.0.1-digital.fwsc', v15: 'FM-1_015.fwsc' };
const HZ = 44100, TINY = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const url = (rel) => new URL(rel, document.baseURI).href;
const violations = [];
document.addEventListener('securitypolicyviolation', (e) => violations.push(`${e.violatedDirective} blocked ${e.blockedURI}`));
window.__result = null;
let sendNote = () => {};

async function getBytes(u) {   // fetch, then XHR fallback (records which worked)
  try { const r = await fetch(u); if (!r.ok) throw new Error('http ' + r.status); return { b: await r.arrayBuffer(), via: 'fetch' }; }
  catch (e1) {
    try {
      const b = await new Promise((res, rej) => { const x = new XMLHttpRequest(); x.open('GET', u); x.responseType = 'arraybuffer'; x.onload = () => (x.status === 200 || x.status === 0) && x.response ? res(x.response) : rej(new Error('xhr ' + x.status)); x.onerror = () => rej(new Error('xhr error')); x.send(); });
      return { b, via: 'xhr (fetch: ' + e1.message + ')' };
    } catch (e2) { throw new Error(`fetch: ${e1.message}; xhr: ${e2.message}`); }
  }
}
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
const stat = (a) => ({ n: a.length, median: median(a), min: a.length ? Math.min(...a) : null, max: a.length ? Math.max(...a) : null });
const fmtErr = (e) => String((e && e.message) || e);

function drawLcd(u16) {   // 240x240 RGB565
  const c = $('lcd'), g = c.getContext('2d'), im = g.createImageData(240, 240);
  for (let i = 0; i < 57600; i++) { const v = u16[i]; im.data[i * 4] = ((v >> 11) & 31) * 255 / 31; im.data[i * 4 + 1] = ((v >> 5) & 63) * 255 / 63; im.data[i * 4 + 2] = (v & 31) * 255 / 31; im.data[i * 4 + 3] = 255; }
  g.putImageData(im, 0, 0);
}

async function cspProbe() {
  const out = { isSecureContext, violations };
  let wasm;
  try { const g = await getBytes(url('vendor/fm1_web.wasm')); wasm = g.b; out.fetchVia = g.via; } catch (e) { out.fetchWasm = fmtErr(e); return out; }
  const m = {};
  try { await WebAssembly.compile(wasm); m.compile = 'ok'; } catch (e) { m.compile = fmtErr(e); }
  try { await WebAssembly.instantiate(wasm, { env: { fm1_jit_compile: () => 0 } }); m.instantiateInterp = 'ok'; } catch (e) { m.instantiateInterp = fmtErr(e); }
  try { new WebAssembly.Module(TINY); m.syncTiny = 'ok'; } catch (e) { m.syncTiny = fmtErr(e); }
  out.main = m;
  try {
    const w = new Worker(url('fm1-worker.js' + (P.csp ? '?csp=' + P.csp : '')));
    out.worker = await new Promise((res, rej) => { w.onmessage = (e) => res(e.data.r); w.onerror = (e) => rej(new Error('worker error: ' + e.message)); w.postMessage({ type: 'probe', wasm: wasm.slice(0), tiny: TINY }); setTimeout(() => rej(new Error('worker timeout')), 15000); });
    w.terminate();
  } catch (e) { out.worker = fmtErr(e); }
  out.hasAudioWorkletNode = typeof AudioWorkletNode !== 'undefined';
  try {
    const ctx = new AudioContext();
    out.ctxState = ctx.state; out.ctxHasWorklet = !!ctx.audioWorklet;
    if (ctx.audioWorklet) {
      try {
        await ctx.audioWorklet.addModule(url('fm1-tap.js'));
        const n = new AudioWorkletNode(ctx, 'fm1tap');
        out.worklet = await new Promise((res, rej) => { n.port.onmessage = (e) => res(e.data.r); n.port.postMessage({ type: 'probe', bytes: wasm.slice(0), tiny: TINY }); setTimeout(() => rej(new Error('worklet timeout')), 15000); });
      } catch (e) { out.worklet = 'addModule/probe failed: ' + fmtErr(e); }
    }
    ctx.close();
  } catch (e) { out.ctx = fmtErr(e); }
  return out;
}

async function run() {
  const res = { P, isSecureContext, ua: navigator.userAgent, violations, errors: [] };
  const wasm = await getBytes(url('vendor/fm1_web.wasm'));
  const pkg = window.__fwB64 ? { b: Uint8Array.from(atob(window.__fwB64), (c) => c.charCodeAt(0)).buffer, via: 'injected' } : await getBytes(url('fw/' + FW[P.fw]));   // file:// has no fw/ route: the driver injects bytes
  res.fetchVia = wasm.via;
  const free = P.mode === 'free';
  let ctx = null, tap = null;
  if (!free) {
    ctx = new AudioContext({ latencyHint: 'interactive', sampleRate: P.sr === '44100' ? 44100 : undefined });
    res.ctxStateBeforeResume = ctx.state;
    await ctx.resume().catch(() => {});
    Object.assign(res, { ctxState: ctx.state, sampleRate: ctx.sampleRate, baseLatencyMs: ctx.baseLatency * 1000, outputLatencyMs: (ctx.outputLatency || 0) * 1000, hasAudioWorklet: !!ctx.audioWorklet });
    if (ctx.state !== 'running') { res.errors.push('context not running: ' + ctx.state); return res; }
    if (ctx.audioWorklet) {
      try { await ctx.audioWorklet.addModule(url('fm1-tap.js')); tap = new AudioWorkletNode(ctx, 'fm1tap', { numberOfInputs: 1, outputChannelCount: [2] }); tap.connect(ctx.destination); }
      catch (e) { res.errors.push('tap: ' + fmtErr(e)); tap = null; }
    }
  }
  const sink = tap || (ctx && ctx.destination);
  const crosses = {}; let tapStats = null;
  if (tap) tap.port.onmessage = (e) => { if (e.data.type === 'cross') crosses[e.data.id] = e.data; else if (e.data.type === 'stats') tapStats = e.data; };
  const insts = [];
  const notes = [];   // {id, postT, sched?, preRms?}
  let stopFlag = false;

  // ---- Path A: Worker renders, main schedules AudioBufferSources ----
  const startA = async () => {
    for (let i = 0; i < P.inst; i++) {
      const w = new Worker(url('fm1-worker.js' + (P.csp ? '?csp=' + P.csp : '')));
      const I = { w, i, nextTime: 0, started: false, underruns: 0, gapMs: 0, blocks: 0, ready: null, final: null, error: null, injFrame: {}, lastRms: 0, maxBlockMs: 0, lcdCount: 0 };
      I.readyP = new Promise((r) => { I.onReady = r; });
      w.onerror = (e) => { I.error = 'worker error: ' + e.message; I.onReady(); };
      w.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'ready') { I.ready = m; I.onReady(); }
        else if (m.type === 'error') { I.error = `${m.stage}: ${m.message}`; I.onReady(); }
        else if (m.type === 'final') { I.final = m; if (I.onFinal) I.onFinal(); }
        else if (m.type === 'lcd') { I.lcdCount++; if (i === 0) drawLcd(m.lcd); }
        else if (m.type === 'inj') I.injFrame[m.id] = m.frame;
        else if (m.type === 'block') {
          I.blocks++; if (m.ms > I.maxBlockMs) I.maxBlockMs = m.ms;
          const n = m.l.length;
          if (!free && !stopFlag) {
            const buf = ctx.createBuffer(2, n, HZ); buf.copyToChannel(m.l, 0); buf.copyToChannel(m.r, 1);
            const s = ctx.createBufferSource(); s.buffer = buf; s.connect(sink);
            if (!I.started) { I.started = true; I.nextTime = ctx.currentTime + 0.02; }
            if (I.nextTime < ctx.currentTime) { I.underruns++; I.gapMs += (ctx.currentTime - I.nextTime) * 1000; I.nextTime = ctx.currentTime + 0.002; }
            const sched = I.nextTime; s.start(sched); I.nextTime += n / HZ;
            if (i === 0) for (const nt of notes) {
              const inj = I.injFrame[nt.id];
              if (inj === undefined || m.frame < inj) continue;
              if (nt.preRms === undefined) nt.preRms = I.lastRms;
              if (nt.sched === undefined && m.rms > 0.005 && nt.preRms < 0.005) nt.sched = sched;
            }
            I.lastRms = m.rms;
          }
        }
      };
      w.postMessage({ type: 'init', wasm: wasm.b.slice(0), pkg: pkg.b.slice(0), mhz: P.mhz, jit: P.jit, chunk: P.chunk, leadMs: P.lead, lcd: i === 0 });
      insts.push(I);
    }
    await Promise.all(insts.map((I) => I.readyP));
    const bad = insts.find((I) => I.error); if (bad) { res.errors.push(bad.error); return false; }
    return true;
  };
  const injectNote = (on, id) => { const bytes = on ? [0x90, 60, 100, 0x91, 60, 100] : [0x80, 60, 0, 0x81, 60, 0]; for (const I of insts) I.w.postMessage({ type: 'midi', id, bytes }); };

  // ---- Path B: upstream worklet host loop ----
  const startB = async () => {
    if (!ctx.audioWorklet) { res.errors.push('no audioWorklet (insecure context)'); return false; }
    try { await ctx.audioWorklet.addModule(url('vendor/worklet.js')); } catch (e) { res.errors.push('addModule worklet.js: ' + fmtErr(e)); return false; }
    for (let i = 0; i < P.inst; i++) {
      const node = new AudioWorkletNode(ctx, 'fm1', { numberOfInputs: 0, outputChannelCount: [2] });
      node.connect(sink);
      const I = { node, i, frames: [], booted: null, error: null, bootT: performance.now(), lcdMs: null, jit: null };
      I.readyP = new Promise((r) => { I.onReady = r; });
      node.port.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'booted') { I.booted = m; I.onReady(); }
        else if (m.type === 'error') { I.error = m.message; I.onReady(); }
        else if (m.type === 'frame') {
          I.frames.push({ busy: m.busy, worst: m.worst, emulated: m.emulated, idle: m.idle, starved: m.starved, quanta: m.quanta, frames: m.frames, short: m.short, halted: m.halted, playing: m.playing });
          I.jit = m.jit;
          if (m.lcd) { if (I.lcdMs === null && m.lcd.some((v) => v)) I.lcdMs = performance.now() - I.bootT; if (i === 0) drawLcd(m.lcd); }
        }
      };
      I.bootT = performance.now();
      node.port.postMessage({ type: 'boot', seq: 1, wasm: wasm.b.slice(0), package: pkg.b.slice(0), mhz: P.mhz, jit: P.jit, ahead: 1024 });
      insts.push(I);
    }
    await Promise.all(insts.map((I) => I.readyP));
    const bad = insts.find((I) => I.error); if (bad) { res.errors.push(bad.error); return false; }
    return true;
  };
  const injectNoteB = (on) => { const bytes = on ? [0x90, 60, 100, 0x91, 60, 100] : [0x80, 60, 0, 0x81, 60, 0]; for (const I of insts) I.node.port.postMessage({ type: 'midi', bytes }); };

  sendNote = (on) => (P.path === 'A' ? injectNote(on, -1) : injectNoteB(on));
  const ok = P.path === 'B' ? await startB() : await startA();
  if (!ok) return res;
  const tStart = performance.now();
  if (P.path === 'A') for (const I of insts) I.w.postMessage({ type: 'go', mode: P.mode, dur: P.dur, notes: P.notes });
  if (P.mode === 'free') {
    await Promise.all(insts.map((I) => new Promise((r) => { if (I.final) r(); else I.onFinal = r; })));
    res.free = insts.map((I) => ({ ready: I.ready, rtf: I.final.producedSec / I.final.wallSec, producedSec: I.final.producedSec, wallSec: I.final.wallSec, worstMs: I.final.worstMs, starved: I.final.starved, short: I.final.short, halted: I.final.halted, peak: I.final.peak, jit: I.final.jit }));
    insts.forEach((I) => I.w.terminate());
    return res;
  }
  // paced: notes for latency, then stop
  const warm = 5000, end = P.dur * 1000;
  let id = 0;
  if (P.notes) {
    await sleep(warm);
    while (performance.now() - tStart < end - 3200 && id < 20) {
      id++;
      const postT = ctx.currentTime;
      if (tap) tap.port.postMessage({ type: 'arm', id, thr: 0.005 });
      notes.push({ id, postT });
      if (P.path === 'A') injectNote(true, id); else injectNoteB(true);
      await sleep(400);
      if (P.path === 'A') injectNote(false, 1000 + id); else injectNoteB(false);
      await sleep(2200);
    }
  }
  const remain = end - (performance.now() - tStart); if (remain > 0) await sleep(remain);
  stopFlag = true;
  if (tap) { tap.port.postMessage({ type: 'stats' }); await sleep(300); }
  res.tap = tapStats;
  res.latency = {
    tapMs: stat(notes.filter((n) => crosses[n.id] && crosses[n.id].pre < 0.005).map((n) => (crosses[n.id].t - n.postT) * 1000)),
    schedMs: stat(notes.filter((n) => n.sched !== undefined).map((n) => (n.sched - n.postT) * 1000)),
    notesSent: notes.length, tapCrossed: notes.filter((n) => crosses[n.id]).length, tapDirty: notes.filter((n) => crosses[n.id] && crosses[n.id].pre >= 0.005).length,
  };
  if (P.path === 'A') {
    await Promise.all(insts.map((I) => new Promise((r) => { I.onFinal = r; I.w.postMessage({ type: 'stop' }); })));
    res.perInst = insts.map((I) => ({ boot: { compileMs: I.ready.compileMs, lcdMs: I.ready.lcdMs, audioMs: I.ready.audioMs }, underruns: I.underruns, gapMs: I.gapMs, blocks: I.blocks, maxBlockMs: I.maxBlockMs,
      busyFrac: I.final.busyMs / 1000 / I.final.wallSec, producedSec: I.final.producedSec, wallSec: I.final.wallSec, worstMs: I.final.worstMs, starved: I.final.starved, short: I.final.short, halted: I.final.halted, jit: I.final.jit, lcdCount: I.lcdCount }));
    res.underruns = insts.reduce((a, I) => a + I.underruns, 0);
    insts.forEach((I) => I.w.terminate());
  } else {
    res.perInst = insts.map((I) => {
      const f = I.frames.slice(2);   // skip the first intervals (boot)
      const intervalMs = (x) => x.quanta * x.frames / ctx.sampleRate * 1000;
      const over = f.filter((x) => x.busy > intervalMs(x)).length;
      return { bootLcdMs: I.lcdMs, intervals: f.length, overIntervals: over, maxBusyFrac: Math.max(0, ...f.map((x) => x.busy / intervalMs(x))), meanBusyFrac: f.reduce((a, x) => a + x.busy, 0) / Math.max(1, f.reduce((a, x) => a + intervalMs(x), 0)),
        worstMs: Math.max(0, ...f.map((x) => x.worst)), starved: f.reduce((a, x) => a + x.starved, 0), short: f.length ? f[f.length - 1].short : 0, halted: f.length ? f[f.length - 1].halted : null, jit: I.jit };
    });
    res.underruns = res.tap ? res.tap.stalls : null;   // B proxy: process() gaps > 25 ms seen by the tap
    insts.forEach((I) => I.node.disconnect());
  }
  ctx.close();
  return res;
}

async function runAndPublish() {
  try { window.__result = P.probe ? await cspProbe() : await run(); }
  catch (e) { window.__result = { P, error: fmtErr(e), violations }; }
  $('out').textContent = JSON.stringify(window.__result, null, 1);
}
window.fm1spike = { run: runAndPublish, P };
$('start').onclick = () => runAndPublish();
const blip = () => { sendNote(true); setTimeout(() => sendNote(false), 300); };
$('note').onclick = blip;
document.addEventListener('keydown', (e) => { if (e.key === 'a' && !e.repeat) blip(); });
if (q.get('auto') === '1') runAndPublish();
