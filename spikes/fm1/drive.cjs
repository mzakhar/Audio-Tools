// Electron-as-Chromium driver. electron drive.cjs <jobs.json> <out.jsonl>
// job: {name, kind:'http'|'file', url?:'http://host:port/base/', meta?:'current|wasm', query:{...}, timeoutMs, gesture:true}
// file kind: loadFile on a generated copy of live.html (meta CSP injected) next to live.js. Same webPreferences as src/main/index.js:80-85 minus preload.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const jobs = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const outFile = process.argv[3];
const CUR = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; worker-src blob: 'self' http://localhost:*; img-src 'self' data: blob:; media-src 'self' blob: https://cdn.freesound.org; connect-src 'self'";
const META = { none: '', current: CUR, wasm: CUR.replace("script-src 'self'", "script-src 'self' 'wasm-unsafe-eval'") };
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');   // overridden per job below
if (process.env.FM1_NO_AUTOPLAY_FLAG) app.commandLine.removeSwitch('autoplay-policy');
async function runJob(job) {
  const win = new BrowserWindow({ show: false, width: 400, height: 400, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: false, backgroundThrottling: false } });
  const logs = [];
  win.webContents.on('console-message', (_e, level, msg) => { if (logs.length < 25) logs.push(`[${level}] ${msg}`.slice(0, 400)); });
  const qs = new URLSearchParams(job.query || {});
  if (job.meta && job.kind === 'http') qs.set('meta', job.meta);
  let loadErr = null;
  win.webContents.on('did-fail-load', (_e, code, desc) => { loadErr = `${code} ${desc}`; });
  try {
    if (job.kind === 'file') {
      const gen = path.join(__dirname, `_gen-${job.meta || 'none'}.html`);
      const m = META[job.meta || 'none'];
      fs.writeFileSync(gen, fs.readFileSync(path.join(__dirname, 'live.html'), 'utf8').replace('<!--CSP-->', m ? `<meta http-equiv="Content-Security-Policy" content="${m}">` : ''));
      await win.loadFile(gen, { query: Object.fromEntries(qs) });
    } else await win.loadURL(job.url + '?' + qs.toString());
  } catch (e) { loadErr = loadErr || String(e); }
  let result = null, error = null;
  if (!loadErr && job.kind === 'file' && job.query && job.query.fw) {
    const f = { felucca: 'felucca-1.8.4.fwsc', sloop: 'sloop-2.8.5.fwsc', dock: 'fm1-dock-1.0.1-digital.fwsc', v15: 'FM-1_015.fwsc' }[job.query.fw];
    await win.webContents.executeJavaScript('window.__fwB64 = ' + JSON.stringify(fs.readFileSync('E:/tmp/fm1-firmware/' + f).toString('base64')));
  }
  if (!loadErr) {
    const run = win.webContents.executeJavaScript('fm1spike.run().then(() => window.__result)', job.gesture !== false);
    try { result = await Promise.race([run, new Promise((_, rej) => setTimeout(() => rej(new Error('job timeout')), job.timeoutMs || 120000))]); }
    catch (e) { error = String(e); }
  }
  const envInfo = loadErr ? {} : await win.webContents.executeJavaScript('({isSecureContext, awn: typeof AudioWorkletNode, origin: location.origin, proto: location.protocol})').catch(() => ({}));
  win.destroy();
  return { name: job.name, job, envInfo, loadErr, error, result, logs };
}
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  console.log('electron', process.versions.electron, 'chromium', process.versions.chrome);
  for (const job of jobs) {
    const t = Date.now();
    const r = await runJob(job);
    r.wallSec = (Date.now() - t) / 1000;
    fs.appendFileSync(outFile, JSON.stringify(r) + '\n');
    console.log('done', job.name, r.wallSec.toFixed(1) + 's', r.error || r.loadErr || '');
  }
  app.quit();
});
