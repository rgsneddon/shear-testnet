// Per-file runner for full-suite. One stuck file is killed and the shard
// fails. The cap is 2x tests/ci_timings.json (3x for pool, stratum and
// Flutter files), floored at 180s (300s for those files, 600s when the
// file has no timing). The cap is clamped to 330 minutes so it fires
// before the 360-minute job timeout. SHEAR_CI_FILE_TIMEOUT_MS may only
// raise a cap. There is no global --test-timeout.
//
// A detached grandchild (stdio already moved off this process group)
// survives SIGKILL of the group. full-suite does not spawn one in the
// test path. The Windows taskkill path is awaited; full-suite itself
// runs on Linux.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const JOB_CAP_MS = 330 * 60 * 1000;
const FLOOR_S = 180;
const HEAVY_FLOOR_S = 300;
const UNMEASURED_S = 600;
const KILL_GRACE_MS = 200;

export const activeChildren = new Set();

export function heavyFile(file) {
  const f = String(file || '').replace(/\\/g, '/');
  return f.startsWith('pool/') || /stratum/i.test(f) || /flutter/i.test(f) || /test_dart_/i.test(f);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function killChild(child, { graceMs = KILL_GRACE_MS } = {}) {
  if (!child || !child.pid) return Promise.resolve();
  if (process.platform === 'win32') {
    return new Promise((resolve) => {
      const killer = spawn('taskkill', ['/F', '/T', '/PID', String(child.pid)], {
        stdio: 'ignore',
        windowsHide: true,
      });
      const finish = () => resolve();
      killer.on('close', finish);
      killer.on('error', finish);
    });
  }
  return (async () => {
    try { process.kill(-child.pid, 'SIGTERM'); }
    catch { try { child.kill('SIGTERM'); } catch { /* already gone */ } }
    await delay(graceMs);
    try { process.kill(-child.pid, 'SIGKILL'); }
    catch { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
  })();
}

export function stopActive() {
  for (const child of activeChildren) void killChild(child);
}

export function onRunnerSignal() {
  stopActive();
}

let signalsInstalled = false;
export function installRunnerSignals() {
  if (signalsInstalled) return;
  signalsInstalled = true;
  process.on('SIGTERM', onRunnerSignal);
  process.on('SIGINT', onRunnerSignal);
}

export function fileCapMs(file, weight = {}, env = process.env) {
  const measured = Number(weight[file]);
  const known = Number.isFinite(measured) && measured > 0;
  let seconds;
  if (!known) seconds = UNMEASURED_S;
  else if (heavyFile(file)) seconds = Math.max(HEAVY_FLOOR_S, Math.ceil(measured * 3));
  else seconds = Math.max(FLOOR_S, Math.ceil(measured * 2));
  const cap = Math.min(seconds * 1000, JOB_CAP_MS);
  const over = Number(env.SHEAR_CI_FILE_TIMEOUT_MS);
  if (Number.isFinite(over) && over > cap) return over;
  return cap;
}

export function timeoutReport({ n, file, capMs, unmeasured }) {
  const title = `${file} (file timeout after ${capMs}ms)`;
  const lines = [
    `not ok ${n} - ${title}`,
    '  ---',
    '  error: file timeout',
    `  cap_ms: ${capMs}`,
    '  ...',
    '# fail 1',
  ];
  if (unmeasured) lines.push(`# unmeasured: add ${file} to tests/ci_timings.json`);
  lines.push(`::error file=${file}::${title}`);
  return `${lines.join('\n')}\n`;
}

export function runFile(file, {
  timeoutMs,
  cwd,
  execPath = process.execPath,
  args,
  onStdout,
  onStderr,
  graceMs = KILL_GRACE_MS,
} = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    let settled = false;
    let timedOut = false;
    const done = (row) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      activeChildren.delete(child);
      resolve(row);
    };
    const env = { ...process.env };
    for (const k of Object.keys(env)) {
      if (k === 'NODE_CHANNEL_FD' || k === 'NODE_TEST_CONTEXT' || k === 'NODE_UNIQUE_ID' || k.startsWith('NODE_CHANNEL_')) delete env[k];
    }
    const child = spawn(execPath, args || ['--test', '--test-concurrency=1', '--test-reporter=tap', file], {
      cwd,
      env,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    activeChildren.add(child);
    const timer = setTimeout(() => {
      timedOut = true;
      void killChild(child, { graceMs });
    }, timeoutMs);
    let tap = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      tap += d;
      if (onStdout) onStdout(d);
    });
    child.stderr.on('data', (d) => {
      stderr += d;
      if (onStderr) onStderr(d);
    });
    child.on('error', (err) => {
      done({ file, code: 1, timedOut, ms: Date.now() - started, tap: String(err), stderr });
    });
    child.on('close', (code) => {
      const failed = timedOut || code == null || code !== 0;
      done({ file, code: failed ? 1 : 0, timedOut, ms: Date.now() - started, tap, stderr });
    });
  });
}

function tapField(tap, label) {
  let n = 0;
  for (const line of String(tap).split(/\r?\n/)) {
    const m = line.match(new RegExp(`^# ${label} (\\d+)\\s*$`));
    if (m) n = Number(m[1]);
  }
  return n;
}

async function main() {
  installRunnerSignals();
  const listPath = process.argv[2];
  if (!listPath) {
    console.error('usage: node tests/ci_shard_run.js <shard.txt>');
    process.exit(2);
  }
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const files = fs.readFileSync(listPath, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const weightPath = path.join(root, 'tests/ci_timings.json');
  const weight = fs.existsSync(weightPath) ? JSON.parse(fs.readFileSync(weightPath, 'utf8')) : {};
  let rc = 0;
  let skipped = 0;
  let todo = 0;
  let n = 0;
  for (const file of files) {
    n += 1;
    const known = Number(weight[file]) > 0;
    const bare = fileCapMs(file, weight, {});
    const cap = fileCapMs(file, weight);
    if (cap !== bare) {
      process.stderr.write(`file cap raised by SHEAR_CI_FILE_TIMEOUT_MS for ${file}\n`);
    }
    const row = await runFile(file, {
      timeoutMs: cap,
      cwd: root,
      onStdout: (d) => { process.stdout.write(d); },
      onStderr: (d) => { process.stderr.write(d); },
    });
    if (row.timedOut) {
      process.stdout.write(timeoutReport({ n, file, capMs: cap, unmeasured: !known }));
      rc = 1;
    } else if (row.code !== 0) rc = 1;
    skipped += tapField(row.tap, 'skipped');
    todo += tapField(row.tap, 'todo');
  }
  process.stdout.write(`# skipped ${skipped}\n# todo ${todo}\n`);
  if (skipped !== 0 || todo !== 0) rc = 1;
  process.exit(rc);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
