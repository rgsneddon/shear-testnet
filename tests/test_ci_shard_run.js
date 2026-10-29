// A stuck stratum or pool file must fail the shard. It must not sit until
// the 360-minute job timeout.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fileCapMs, killChild, runFile, stopActive } from './ci_shard_run.js';

test.after(() => { stopActive(); });

test('a stuck file fails the shard instead of hanging', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shard-hang-'));
  const file = path.join(dir, 'hang.test.js');
  fs.writeFileSync(file, "import test from 'node:test';\ntest('hangs', () => new Promise(() => {}));\n");
  // The race only stops this test when the runner ignores timeoutMs.
  // The assertion is the runner's own timedOut flag.
  const result = await Promise.race([
    runFile(file, { timeoutMs: 500, cwd: dir }),
    new Promise((resolve) => setTimeout(() => resolve({ timedOut: false, code: 1, ms: 4000 }), 4000)),
  ]);
  assert.equal(result.timedOut, true, 'stuck file');
  assert.notEqual(result.code, 0, 'stuck file');
  assert.ok(result.ms < 4_000, `stuck file took ${result.ms}ms`);
});

test('the file cap is twice the measured time, with a floor', () => {
  // Pool files use the wider floor. A non-pool file keeps 180s.
  assert.equal(fileCapMs('pool/tests/test_vardiff.js', { 'pool/tests/test_vardiff.js': 10 }, {}), 300_000);
  assert.equal(fileCapMs('tests/test_small.js', { 'tests/test_small.js': 10 }, {}), 180_000);
  assert.equal(fileCapMs('node/tests/test_p2p.js', { 'node/tests/test_p2p.js': 200 }, {}), 400_000);
  assert.equal(fileCapMs('unmeasured.js', {}, {}), 600_000);
  // A lower override must not shrink the cap. A higher one may raise it.
  assert.equal(fileCapMs('x', { x: 10 }, { SHEAR_CI_FILE_TIMEOUT_MS: '1500' }), 180_000);
  assert.equal(fileCapMs('x', { x: 10 }, { SHEAR_CI_FILE_TIMEOUT_MS: '999000' }), 999_000);
});

test('a heavy weight is clamped under the 360-minute job', () => {
  const cap = fileCapMs('node/tests/test_pruned_p2p_e2e_v12.js', {
    'node/tests/test_pruned_p2p_e2e_v12.js': 13427,
  }, {});
  assert.equal(cap, 330 * 60 * 1000);
  assert.ok(cap < 360 * 60 * 1000);
});

test('pool, stratum and Flutter files get three times their weight', () => {
  assert.equal(fileCapMs('pool/tests/test_pool.js', { 'pool/tests/test_pool.js': 101 }, {}), 303_000);
  assert.equal(fileCapMs('node/tests/test_stratum_login.js', { 'node/tests/test_stratum_login.js': 40 }, {}), 300_000);
  assert.equal(fileCapMs('node/tests/test_dart_withdraw_queue_v12.js', {
    'node/tests/test_dart_withdraw_queue_v12.js': 126,
  }, {}), 378_000);
});

test('file output is visible before the file exits', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shard-stream-'));
  const file = path.join(dir, 'stream.test.js');
  fs.writeFileSync(file, "import test from 'node:test';\ntest('hangs', () => { console.log('STREAM_MARK'); return new Promise(() => {}); });\n");
  let saw = false;
  const result = await runFile(file, {
    timeoutMs: 700,
    cwd: dir,
    onStdout(chunk) { if (String(chunk).includes('STREAM_MARK')) saw = true; },
  });
  assert.equal(saw, true, 'stdout streamed');
  assert.equal(result.timedOut, true);
});

test('stderr stays out of the tap', async () => {
  // node --test reprints a test's stderr as TAP comments on stdout, so
  // this drives the runner pipes with a shim. The suite path is unchanged
  // when args is omitted.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shard-err-'));
  const shim = path.join(dir, 'shim.js');
  fs.writeFileSync(shim, "process.stdout.write('ok 1 - ok\\n# tests 1\\n# pass 1\\n# fail 0\\n# skipped 0\\n# todo 0\\n'); process.stderr.write('STDERR_MARK\\n');");
  const result = await runFile('pool/tests/ignored.js', {
    timeoutMs: 5_000,
    cwd: dir,
    args: [shim],
  });
  assert.equal(String(result.tap).includes('STDERR_MARK'), false);
  assert.equal(String(result.stderr).includes('STDERR_MARK'), true);
  assert.equal(String(result.tap).includes('ok 1 - ok'), true);
});

test('a file timeout is valid TAP and a GitHub error', async () => {
  const mod = await import('./ci_shard_run.js');
  assert.equal(typeof mod.timeoutReport, 'function');
  const text = mod.timeoutReport({
    n: 4,
    file: 'pool/tests/hang.js',
    capMs: 500,
    unmeasured: true,
  });
  assert.match(text, /^not ok 4 - pool\/tests\/hang\.js \(file timeout after 500ms\)/m);
  assert.match(text, /^  error: file timeout$/m);
  assert.match(text, /^# fail 1$/m);
  assert.match(text, /^::error file=pool\/tests\/hang\.js::/m);
  assert.match(text, /unmeasured: add pool\/tests\/hang\.js to tests\/ci_timings\.json/);
});

test('killChild resolves after the child is gone', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
    detached: process.platform !== 'win32',
    windowsHide: true,
  });
  try {
    const pending = killChild(child);
    assert.equal(typeof pending?.then, 'function');
    await pending;
    if (child.exitCode == null && child.signalCode == null) {
      await new Promise((resolve) => child.once('close', resolve));
    }
    assert.ok(child.exitCode != null || child.signalCode != null);
  } finally {
    try { child.kill(); } catch { /* already gone */ }
  }
});

test('a runner signal stops active children', async () => {
  const mod = await import('./ci_shard_run.js');
  assert.equal(typeof mod.onRunnerSignal, 'function');
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
    detached: process.platform !== 'win32',
    windowsHide: true,
  });
  mod.activeChildren.add(child);
  try {
    mod.onRunnerSignal();
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('signal did not stop the child')), 4_000);
      child.once('close', () => { clearTimeout(timer); resolve(); });
    });
  } finally {
    try { child.kill(); } catch { /* already gone */ }
    mod.activeChildren.delete(child);
  }
});

test('unix kill sends SIGTERM before SIGKILL', { skip: process.platform === 'win32' }, async () => {
  const marker = path.join(os.tmpdir(), `shard-sig-${process.pid}.txt`);
  try { fs.unlinkSync(marker); } catch { /* absent */ }
  const child = spawn(process.execPath, ['-e', `
    const fs = require('fs');
    process.on('SIGTERM', () => { try { fs.writeFileSync(${JSON.stringify(marker)}, 'term'); } catch (e) {} });
    setInterval(() => {}, 1000);
  `], { detached: true, stdio: 'ignore' });
  try {
    await killChild(child, { graceMs: 300 });
    assert.equal(fs.readFileSync(marker, 'utf8'), 'term');
  } finally {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ }
    try { fs.unlinkSync(marker); } catch { /* absent */ }
  }
});

test('ci_shard --check names an unmeasured file', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const r = spawnSync(process.execPath, ['tests/ci_shard.js', '--check'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(`${r.stdout}\n${r.stderr}`, /unmeasured: add \S+ to tests\/ci_timings\.json/);
});

test('a finished file is not a timeout', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shard-ok-'));
  const file = path.join(dir, 'ok.test.js');
  fs.writeFileSync(file, "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('ok', () => { assert.equal(1, 1); });\n");
  const result = await runFile(file, { timeoutMs: 5_000, cwd: dir });
  assert.equal(result.timedOut, false);
  assert.equal(result.code, 0);
});
