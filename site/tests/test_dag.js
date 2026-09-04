import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const html = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '../dag/index.html'),
  'utf8',
);
const theme = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '../brand/theme.css'),
  'utf8',
);

describe('Shear DAG instrument', () => {
  it('keeps the banner, spy glass, and fixed stage', () => {
    assert.match(html, /id="shear-nav"/);
    assert.match(html, /id="nav-toggle"/);
    assert.match(html, /onclick="toggleShearNav\(\)"/);
    assert.doesNotMatch(html, /position:fixed; top:0; left:0; right:0/);
    assert.match(html, />WALLET</);
    assert.doesNotMatch(html, />WALLET 0\.18</);
    assert.match(html, /c\.style\.minWidth = '0'/);
    assert.match(html, /theme\.css\?v=26/);
    assert.match(html, /spy glass/);
    assert.match(html, /Inspector/);
    assert.match(html, /drawLoupe/);
    assert.match(html, /glass ×2\.8/);
    assert.match(html, /\/api\/explorer\/dag/);
    assert.match(theme, /position: absolute; top: 100%; right: 0; left: auto/);
  });

  it('is an honest valid-hash DAG: selected, degeneracy, no 50-hash swarm', () => {
    assert.match(html, /<title>Shear DAG<\/title>/);
    assert.doesNotMatch(html, /<title>Shear — hash DAG<\/title>/);
    assert.match(html, /Valid hashes/);
    assert.match(html, /selected/i);
    assert.match(html, /invalid hashes collapse|Chronoflux/i);
    assert.match(html, /degenerate|collapse/);
    assert.doesNotMatch(html, /50 hashes each/);
    assert.doesNotMatch(html, /HASH_BUNDLE/);
    assert.doesNotMatch(html, /GNFP/);
    assert.doesNotMatch(html, /uncle/i);
    assert.doesNotMatch(html, /releases\/tag\/0\.17/);
    assert.match(html, /releases\/tag\/0\.18/);
    assert.match(html, /liveFromBook/);
    assert.match(html, /roundHashes/);
    assert.doesNotMatch(html, /clientHashes/);
  });

  it('fixture of stats with roundHashes vs clientHashes paints only roundHashes', () => {
    const m = html.match(/function liveFromBook\(workers\) \{[\s\S]*?\n    \}/);
    assert.ok(m, 'liveFromBook must ship');
    const liveFromBook = vm.runInNewContext(`${m[0]}; liveFromBook`);
    const rows = liveFromBook([
      { dest: 'ssa1abc', roundHashes: 16, clientHashes: 9e12, connected: true },
      { dest: 'ssa1def', roundHashes: 0, clientHashes: 5000, provenHashes: 0, connected: true },
      { dest: 'ssa1ghi', validHashes: 8, hashes: 999, connected: true },
    ]);
    assert.equal(rows[0].count, 16);
    assert.equal(rows[1].count, 0);
    assert.equal(rows[2].count, 8);
    assert.equal(rows.every((r) => r.count !== 9e12 && r.count !== 5000 && r.count !== 999), true);
  });

  it('inline DAG script executes with a browser window and no Node globals', () => {
    const m = html.match(/<script>\s*([\s\S]*?)<\/script>\s*<\/body>/);
    assert.ok(m && m[1], 'inline script must ship');
    const src = m[1];
    assert.doesNotMatch(src, /module\.exports/);
    assert.doesNotMatch(src, /\brequire\s*\(/);
    const stubEl = () => {
      const style = {};
      const klass = { add() {}, remove() {}, toggle() {}, contains() { return false; } };
      const el = {
        style, classList: klass, textContent: '', innerHTML: '', innerText: '',
        disabled: false, width: 1280, height: 720,
        getContext() {
          const grad = { addColorStop() {} };
          return new Proxy({
            fillStyle: '', strokeStyle: '', font: '', textAlign: '', globalAlpha: 1, lineWidth: 1,
            canvas: { width: 1280, height: 720 },
            setTransform() {}, fillRect() {}, clearRect() {},
            beginPath() {}, closePath() {}, moveTo() {}, lineTo() {}, arc() {}, fill() {}, stroke() {},
            save() {}, restore() {}, translate() {}, scale() {}, clip() {},
            fillText() {}, measureText() { return { width: 8 }; },
            drawImage() {}, setLineDash() {}, quadraticCurveTo() {},
            createLinearGradient() { return grad; },
            getImageData() { return { data: new Uint8ClampedArray(16), width: 2, height: 2 }; },
          }, { get(t, p) { if (p in t) return t[p]; return () => grad; } });
        },
        getBoundingClientRect() {
          return { width: 1280, height: 720, top: 0, left: 0, right: 1280, bottom: 720 };
        },
        addEventListener() {}, setAttribute() {}, getAttribute() { return null; },
        appendChild() {}, querySelector() { return stubEl(); }, querySelectorAll() { return []; },
      };
      return el;
    };
    const fixture = {
      ok: true, height: 3, workers: [{ miner: 'she1abc', dest: 'ssa1abc', roundHashes: 16, clientHashes: 99, connected: true }],
    };
    const dagFix = {
      ok: true, tip: 3, blocks: [], live: [{ tag: 'she1abc', dest: 'ssa1abc', count: 16, selected: true }], seats: [],
    };
    const windowObj = {
      devicePixelRatio: 1, innerWidth: 1280, innerHeight: 800,
      addEventListener() {},
      shearDagInspect: undefined,
    };
    const sandbox = {
      window: windowObj,
      document: {
        getElementById() { return stubEl(); },
        documentElement: { clientWidth: 1280, clientHeight: 800, getAttribute() { return null; } },
        addEventListener() {},
      },
      addEventListener() {},
      performance: { now() { return 1; } },
      fetch() {
        return Promise.resolve({ json: async () => dagFix, ok: true });
      },
      setInterval() { return 1; },
      clearInterval() {},
      requestAnimationFrame() { return 1; },
      cancelAnimationFrame() {},
      console,
      JSON, Math, Date, Number, String, Array, Object, Map, Set, Promise, parseInt, parseFloat, isNaN, Infinity,
    };
    sandbox.globalThis = sandbox;
    sandbox.self = sandbox.window;
    vm.runInNewContext(src, sandbox, { timeout: 2000 });
    assert.equal(typeof sandbox.window.shearDagInspect, 'function');
    assert.equal(Object.prototype.hasOwnProperty.call(sandbox, 'module'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(sandbox, 'require'), false);
    void fixture;
  });
});
