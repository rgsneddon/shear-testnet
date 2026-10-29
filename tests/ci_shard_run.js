// Per-file runner for full-suite. One stuck file is killed and the shard
// fails. The cap is 2x tests/ci_timings.json (floor 180s), or
// SHEAR_CI_FILE_TIMEOUT_MS when that is set. There is no global
// --test-timeout: a long file keeps its own measured cap.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const activeChildren = new Set();

export function killChild(child) {
  if (!child || !child.pid) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore', windowsHide: true });
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
  }
}

export function stopActive() {
  for (const child of activeChildren) killChild(child);
}

export function fileCapMs(file, weight = {}, env = process.env) {
  const over = Number(env.SHEAR_CI_FILE_TIMEOUT_MS);
  if (Number.isFinite(over) && over > 0) return over;
  const sec = Number(weight[file]) > 0 ? Number(weight[file]) : 60;
  return Math.max(180, Math.ceil(sec * 2)) * 1000;
}

export function runFile(file, { timeoutMs, cwd, execPath = process.execPath } = {}) {
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
    const child = spawn(execPath, ['--test', '--test-concurrency=1', '--test-reporter=tap', file], {
      cwd,
      env,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    activeChildren.add(child);
    const timer = setTimeout(() => {
      timedOut = true;
      killChild(child);
    }, timeoutMs);
    let tap = '';
    child.stdout.on('data', (d) => { tap += d; });
    child.stderr.on('data', (d) => { tap += d; });
    child.on('error', (err) => {
      done({ file, code: 1, timedOut, ms: Date.now() - started, tap: String(err) });
    });
    child.on('close', (code) => {
      const failed = timedOut || code == null || code !== 0;
      done({ file, code: failed ? 1 : 0, timedOut, ms: Date.now() - started, tap });
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
  for (const file of files) {
    const row = await runFile(file, { timeoutMs: fileCapMs(file, weight), cwd: root });
    process.stdout.write(row.tap);
    if (!row.tap.endsWith('\n')) process.stdout.write('\n');
    if (row.timedOut) {
      process.stdout.write(`not ok ${file} file timeout after ${row.ms}ms\n`);
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
