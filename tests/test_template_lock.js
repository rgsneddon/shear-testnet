import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildLock, pageFingerprint, sha256 } from './template_lock.js';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const baselinePath = path.join(repoRoot, 'site', 'template-lock.json');

function read(rel) {
  return fs.readFileSync(path.join(repoRoot, rel.split('/').join(path.sep)), 'utf8');
}

describe('snapshot template lock', () => {
  it('every captured HTML url has a file in the checkout', () => {
    const manifest = JSON.parse(read('site/snapshot-manifest.json'));
    assert.ok(manifest.pages.length >= 40);
    for (const row of manifest.pages) {
      const abs = path.join(repoRoot, row.file.split('/').join(path.sep));
      assert.equal(fs.existsSync(abs), true, row.url);
      assert.ok(fs.statSync(abs).size > 0, row.url);
    }
  });

  it('css, theme, and page skeletons match the locked snapshot', () => {
    const locked = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
    const now = buildLock(repoRoot);
    assert.deepEqual(now.pages, locked.pages);
    assert.deepEqual(now.css, locked.css);
    assert.deepEqual(now.chrome, locked.chrome);
  });

  it('a visible copy edit keeps the skeleton and a layout edit does not', () => {
    const html = read('site/index.html');
    const before = pageFingerprint(html);
    const copy = html.replace(/(<title>)[^<]+(<\/title>)/, '$1Snapshot copy$2');
    assert.notEqual(copy, html);
    assert.deepEqual(pageFingerprint(copy), before);
    const layout = html.replace('<html', '<html data-layout="alt"');
    assert.notEqual(pageFingerprint(layout).skeleton, before.skeleton);
    const css = fs.readFileSync(path.join(repoRoot, 'site', 'css', 'saas-dark.css'));
    assert.notEqual(sha256(css), sha256(Buffer.concat([css, Buffer.from('\nbody{color:#123456}\n')])));
  });
});
