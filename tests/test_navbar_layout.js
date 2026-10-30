import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Layout guard: the 12 product nav links sit on ONE row at every desktop width
// from just above the 1024px burger breakpoint upward. Drives headless Chrome
// over the DevTools protocol (no npm dependency). Skips when no Chrome is found.

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const WIDTHS = [1025, 1100, 1190, 1280, 1440];
const PAGES = [
  { name: 'main', dir: 'site', file: 'index.html' },
  { name: 'pool', dir: 'pool/public', file: 'index.html' },
  { name: 'mempool', dir: 'mempool', file: 'index.html' },
  { name: 'team', dir: 'team', file: 'index.html' },
  { name: 'explorer', dir: 'explorer', file: 'explorer.html' },
  { name: 'docs', dir: 'site', file: 'docs/index.html' },
  { name: 'pool-miner', dir: 'pool/public', file: 'miner.html' },
];

function findChrome() {
  const c = [process.env.CHROME_BIN, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome-stable'];
  return c.find((p) => p && fs.existsSync(p)) || null;
}
const CHROME = findChrome();

const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.json': 'application/json' };
function serve(dir) {
  return new Promise((resolve) => {
    const base = path.join(root, dir);
    const srv = http.createServer((req, res) => {
      const rel = decodeURIComponent(req.url.split('?')[0]);
      const abs = path.join(base, rel.endsWith('/') ? rel + 'index.html' : rel);
      if (!abs.startsWith(base) || !fs.existsSync(abs) || fs.statSync(abs).isDirectory()) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'content-type': TYPES[path.extname(abs)] || 'application/octet-stream' });
      fs.createReadStream(abs).pipe(res);
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

async function cdpConnect(port) {
  let ver;
  for (let i = 0; i < 100; i++) {
    try { ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  assert.ok(ver, 'chrome devtools did not start');
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0; const wait = new Map(); const events = [];
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && wait.has(d.id)) { const { r, j } = wait.get(d.id); wait.delete(d.id); d.error ? j(new Error(d.error.message)) : r(d.result); }
    else events.push(d);
  };
  const send = (method, params = {}, sessionId) => new Promise((r, j) => { const n = ++id; wait.set(n, { r, j }); ws.send(JSON.stringify({ id: n, method, params, sessionId })); });
  return { ws, send, events };
}

const MEASURE = `(async () => {
  if (document.fonts && document.fonts.ready) await document.fonts.ready;
  const nav = document.getElementById('shear-nav');
  if (!nav) return { error: 'no #shear-nav' };
  const links = [...nav.querySelectorAll('a.nav-btn')];
  const tops = links.map((a) => Math.round(a.getBoundingClientRect().top));
  return { count: links.length, rows: [...new Set(tops)].length, labels: links.map((a) => a.textContent.trim()), display: getComputedStyle(nav).display };
})()`;

describe('navbar layout: 12 links on one row above the burger breakpoint', { skip: CHROME ? false : 'no headless Chrome' }, () => {
  let chrome; let cdp; const servers = {};
  before(async () => {
    for (const p of PAGES) servers[p.name] = await serve(p.dir);
    const port = 9300 + Math.floor(Math.random() * 500);
    const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'navlayout-'));
    chrome = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars', `--remote-debugging-port=${port}`, `--user-data-dir=${prof}`, 'about:blank'], { stdio: 'ignore' });
    cdp = await cdpConnect(port);
  });
  after(() => { try { cdp.ws.close(); } catch {} if (chrome) chrome.kill('SIGKILL'); for (const s of Object.values(servers)) s.close(); });

  async function measure(page, width) {
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    try {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: false }, sessionId);
      await cdp.send('Page.enable', {}, sessionId);
      const url = `http://127.0.0.1:${servers[page.name].address().port}/${page.file}`;
      await cdp.send('Page.navigate', { url }, sessionId);
      const t0 = Date.now();
      for (;;) {
        const { result } = await cdp.send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true }, sessionId);
        if (result.value === 'complete' || Date.now() - t0 > 8000) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      await new Promise((r) => setTimeout(r, 300));
      const { result } = await cdp.send('Runtime.evaluate', { expression: MEASURE, awaitPromise: true, returnByValue: true }, sessionId);
      return result.value;
    } finally {
      await cdp.send('Target.closeTarget', { targetId });
    }
  }

  for (const page of PAGES) {
    for (const width of WIDTHS) {
      it(`${page.name} @ ${width}px: nav links on a single row`, async () => {
        const m = await measure(page, width);
        assert.ok(!m.error, `${page.name}: ${m.error}`);
        assert.equal(m.count, 12, `${page.name}: ${m.labels}`);
        assert.notEqual(m.display, 'none', `${page.name} @ ${width}: nav hidden (burger) above the breakpoint`);
        assert.equal(m.rows, 1, `${page.name} @ ${width}px: nav wraps onto ${m.rows} rows`);
      });
    }
  }
});
