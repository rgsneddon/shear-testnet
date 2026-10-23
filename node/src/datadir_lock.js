/**
 * One writer for a book directory.
 * The lock file records the holder pid. A live pid refuses the second
 * process. A pid that is gone (crash, kill) is stale and the next open
 * takes the directory. The same process may open the book again.
 */
import fs from 'node:fs';
import path from 'node:path';

export const DATADIR_LOCK_NAME = 'datadir.lock';

const held = new Map();
let exitArmed = false;

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

function readLock(lockPath) {
  let text = '';
  try {
    text = fs.readFileSync(lockPath, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return { missing: true };
    return { unreadable: true };
  }
  if (!String(text || '').trim()) {
    let age = 0;
    try { age = Date.now() - Number(fs.statSync(lockPath).mtimeMs || 0); } catch { age = 0; }
    if (age < 2000) return { pending: true };
    return { stale: true };
  }
  try {
    const info = JSON.parse(text);
    const pid = Number(info?.pid);
    if (!Number.isInteger(pid) || pid <= 0) return { stale: true };
    if (pid === process.pid) return { ours: true, pid };
    if (pidAlive(pid)) return { busy: true, pid };
    return { stale: true, pid };
  } catch {
    return { stale: true };
  }
}

function inUse(dir, pid) {
  const who = pid ? ` by pid ${pid}` : '';
  const err = new Error(`datadir in use${who}: ${dir}`);
  err.code = 'datadir_in_use';
  return err;
}

function pause(ms) {
  const sab = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(sab), 0, 0, ms);
}

function armExit() {
  if (exitArmed) return;
  exitArmed = true;
  process.on('exit', () => {
    for (const rec of held.values()) {
      try { fs.closeSync(rec.fd); } catch { /* ignore */ }
      try { fs.unlinkSync(rec.path); } catch { /* ignore */ }
    }
    held.clear();
  });
}

/** Refuse a second process. A dead holder's lock file is removed and replaced. */
export function acquireDatadirLock(dir) {
  const key = path.resolve(String(dir || ''));
  if (held.has(key)) return held.get(key);
  const lockPath = path.join(key, DATADIR_LOCK_NAME);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const state = readLock(lockPath);
    if (state.ours) {
      armExit();
      return held.get(key) || { path: lockPath, fd: null };
    }
    if (state.busy) throw inUse(key, state.pid);
    if (state.pending) {
      pause(20);
      continue;
    }
    if (state.stale || state.unreadable) {
      try { fs.unlinkSync(lockPath); } catch (err) {
        if (err?.code !== 'ENOENT') pause(20);
      }
      continue;
    }
    let fd;
    try {
      fd = fs.openSync(lockPath, 'wx', 0o600);
    } catch (err) {
      if (err?.code === 'EEXIST') continue;
      throw err;
    }
    try {
      fs.writeFileSync(fd, `${JSON.stringify({ pid: process.pid })}\n`);
    } catch (err) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
      try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
      throw err;
    }
    const rec = { fd, path: lockPath };
    held.set(key, rec);
    armExit();
    return rec;
  }
  throw inUse(key);
}
