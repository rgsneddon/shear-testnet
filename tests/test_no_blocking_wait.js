/**
 * No test or test helper waits with a synchronous Atomics.wait loop.
 *
 * A synchronous wait blocks the event loop, so the test runner's own timeout
 * for that file cannot fire. test_admit_consensus ran four hours past its cap
 * that way while it mined. Wait with Atomics.waitAsync (node/tests/mine_worker.mjs)
 * or a timer instead.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// A spawned child process, not a test: it sleeps 10 ms between polls under its
// own 10 s deadline, while the parent test keeps its event loop free.
const ALLOWED = new Map([
  ['node/tests/test_datadir_lock.js', 'lock-race child process'],
]);

function walk(dir, out) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === 'node_modules' || ent.name.startsWith('.')) continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(full, out);
    else if (/\.(m?js)$/.test(ent.name)) out.push(full);
  }
  return out;
}

function testFiles() {
  const files = [];
  for (const dir of ['node/tests', 'pool/tests', 'miner/tests', 'sheark-miner/tests', 'tests']) {
    const abs = path.join(root, dir);
    if (fs.existsSync(abs)) walk(abs, files);
  }
  for (const name of fs.readdirSync(path.join(root, 'crypto'))) {
    if (name.endsWith('.test.js')) files.push(path.join(root, 'crypto', name));
  }
  return files;
}

describe('tests keep their event loop free', () => {
  it('no test or helper blocks on Atomics.wait', () => {
    const self = path.relative(root, fileURLToPath(import.meta.url)).split(path.sep).join('/');
    const hits = [];
    for (const file of testFiles()) {
      const rel = path.relative(root, file).split(path.sep).join('/');
      if (rel === self || ALLOWED.has(rel)) continue;
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (/\bAtomics\.wait\s*\(/.test(line)) hits.push(`${rel}:${i + 1}`);
      });
    }
    assert.deepEqual(hits, [], `synchronous Atomics.wait in tests: ${hits.join(', ')}`);
  });

  it('the allowed file still has the wait it is allowed for', () => {
    for (const rel of ALLOWED.keys()) {
      const src = fs.readFileSync(path.join(root, rel), 'utf8');
      assert.match(src, /\bAtomics\.wait\s*\(/, `${rel} no longer needs its entry`);
    }
  });
});
