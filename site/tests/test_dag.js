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
    assert.match(html, /position:fixed; top:0; left:0; right:0/);
    assert.match(html, /c\.style\.minWidth = '0'/);
    assert.match(html, /theme\.css\?v=25/);
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
});
