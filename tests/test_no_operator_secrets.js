import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function walk(dir, acc = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === 'node_modules' || ent.name === '.git' || ent.name === 'build'
      || ent.name === 'dist' || ent.name === '.dart_tool' || ent.name === 'target') continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, acc);
    else acc.push(p);
  }
  return acc;
}

describe('no operator secrets in the public tree', () => {
  it('never ships the operator admin hostname', () => {
    const files = walk(root);
    const hits = [];
    for (const f of files) {
      const rel = path.relative(root, f);
      if (rel.includes('test_no_operator_secrets')) continue;
      if (rel.includes('test_admin_wallet')) continue;
      if (rel === '.gitignore') continue;
      let text;
      try {
        text = fs.readFileSync(f, 'utf8');
      } catch {
        continue;
      }
      if (/kyrusfables/i.test(text)) hits.push(rel);
    }
    assert.deepEqual(hits, [], `operator hostname leaked: ${hits.join(', ')}`);
  });

  it('DEFAULT_SEEDS is hostname only; node --help names the seed host', () => {
    const src = fs.readFileSync(path.join(root, 'node/src/node.js'), 'utf8');
    assert.match(src, /p2p\.shear\.digital:30303/);
    assert.doesNotMatch(src, /46\.224\.132\.83/);
    const r = spawnSync(process.execPath, ['node/src/node.js', '--help'], { cwd: root, encoding: 'utf8', timeout: 20000 });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /SHEAR_DATA/);
    assert.match(r.stdout, /clock_wait/);
    assert.match(r.stdout, /p2p\.shear\.digital:30303/);
  });
});
