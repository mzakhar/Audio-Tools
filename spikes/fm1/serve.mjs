// Tiny static server for the FM-1 spike. node serve.mjs [--port 8099] [--base /synth/] [--csp none|current|wasm] [--fw-dir E:/tmp/fm1-firmware]
// ?csp=<name> on any request overrides the header variant; ?meta=<name> on live.html injects a <meta> CSP (replaces <!--CSP-->).
import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const arg = (n, d) => { const i = process.argv.indexOf(n); return i < 0 ? d : process.argv[i + 1]; };
const port = +arg('--port', 8099), base = arg('--base', '/'), defCsp = arg('--csp', 'none'), fwDir = arg('--fw-dir', 'E:/tmp/fm1-firmware');
const CUR = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; worker-src blob: 'self' http://localhost:*; img-src 'self' data: blob:; media-src 'self' blob: https://cdn.freesound.org; connect-src 'self'";
export const CSP = { none: '', current: CUR, wasm: CUR.replace("script-src 'self'", "script-src 'self' 'wasm-unsafe-eval'") };
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json' };
http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (!u.pathname.startsWith(base)) { res.writeHead(404); return res.end('outside base'); }
  const rel = decodeURIComponent(u.pathname.slice(base.length)) || 'live.html';
  let file;
  if (rel.startsWith('fw/')) file = path.join(fwDir, path.basename(rel));
  else if (/^(live\.html|live\.js|fm1-worker\.js|fm1-tap\.js|vendor\/[\w.]+)$/.test(rel)) file = path.join(HERE, rel);
  if (!file || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404); return res.end('nf'); }
  const h = { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' };
  const csp = CSP[u.searchParams.get('csp') ?? defCsp] ?? '';
  if (csp) h['Content-Security-Policy'] = csp;
  let body = readFileSync(file);
  if (rel === 'live.html') {
    const m = CSP[u.searchParams.get('meta') || 'none'] || '';
    body = Buffer.from(body.toString().replace('<!--CSP-->', m ? `<meta http-equiv="Content-Security-Policy" content="${m}">` : ''));
  }
  res.writeHead(200, h); res.end(body);
}).listen(port, '0.0.0.0', () => console.log(`listening ${port} base ${base} csp ${defCsp}`));
