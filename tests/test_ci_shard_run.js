// A stuck stratum or pool file must fail the shard. It must not sit until
// the 360-minute job timeout.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileCapMs, runFile, stopActive } from './ci_shard_run.js';

test.after(() => { stopActive(); });

test('a stuck file fails the shard instead of hanging', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shard-hang-'));
  const file = path.join(dir, 'hang.test.js');
  fs.writeFileSync(file, "import test from 'node:test';\ntest('hangs', () => new Promise(() => {}));\n");
  // The race only stops this test when the runner ignores timeoutMs.
  // The assertion is the runner's own timedOut flag.
  const result = await Promise.race([
    runFile(file, { timeoutMs: 500, cwd: dir }),
    new Promise((resolve) => setTimeout(() => resolve({ timedOut: false, code: 1, ms: 800 }), 800)),
  ]);
  assert.equal(result.timedOut, true, 'stuck file');
  assert.notEqual(result.code, 0, 'stuck file');
  assert.ok(result.ms < 4_000, `stuck file took ${result.ms}ms`);
});

test('the file cap is twice the measured time, with a floor', () => {
  assert.equal(fileCapMs('pool/tests/test_vardiff.js', { 'pool/tests/test_vardiff.js': 10 }, {}), 180_000);
  assert.equal(fileCapMs('node/tests/test_p2p.js', { 'node/tests/test_p2p.js': 200 }, {}), 400_000);
  assert.equal(fileCapMs('unmeasured.js', {}, {}), 180_000);
  assert.equal(fileCapMs('x', { x: 10 }, { SHEAR_CI_FILE_TIMEOUT_MS: '1500' }), 1500);
});

test('a finished file is not a timeout', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shard-ok-'));
  const file = path.join(dir, 'ok.test.js');
  fs.writeFileSync(file, "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('ok', () => { assert.equal(1, 1); });\n");
  const result = await runFile(file, { timeoutMs: 5_000, cwd: dir });
  assert.equal(result.timedOut, false);
  assert.equal(result.code, 0);
});
