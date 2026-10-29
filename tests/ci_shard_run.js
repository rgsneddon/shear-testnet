// Run one full-suite file. timeoutMs is accepted and not applied: a stuck
// file waits until something else kills it.
import { spawn } from 'node:child_process';

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

export function runFile(file, { timeoutMs, cwd, execPath = process.execPath } = {}) {
  void timeoutMs;
  return new Promise((resolve) => {
    const started = Date.now();
    let settled = false;
    const done = (row) => {
      if (settled) return;
      settled = true;
      activeChildren.delete(child);
      resolve(row);
    };
    const env = { ...process.env };
    // A unit test of this runner is itself under node --test. The child must
    // be its own runner, not a channel of the parent.
    for (const k of Object.keys(env)) {
      if (k === 'NODE_CHANNEL_FD' || k === 'NODE_TEST_CONTEXT' || k === 'NODE_UNIQUE_ID' || k.startsWith('NODE_CHANNEL_')) delete env[k];
    }
    const child = spawn(execPath, ['--test', '--test-concurrency=1', '--test-reporter=tap', file], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    activeChildren.add(child);
    let tap = '';
    child.stdout.on('data', (d) => { tap += d; });
    child.stderr.on('data', (d) => { tap += d; });
    child.on('error', (err) => {
      done({ file, code: 1, timedOut: false, ms: Date.now() - started, tap: String(err) });
    });
    child.on('close', (code) => {
      done({ file, code: code ?? 1, timedOut: false, ms: Date.now() - started, tap });
    });
  });
}
