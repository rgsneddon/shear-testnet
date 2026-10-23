/**
 * One writer for a book directory.
 * The lock file records the holder pid, host, and start time. A live pid
 * refuses the second process. A pid that is gone (crash, kill) is stale:
 * the next open renames that file aside, creates a new one exclusively, and
 * keeps it only when a re-read shows this pid. An unreadable lock is never
 * stale. The same process may open the book again.
 */
import fs from 'node:fs';
import os from 'node:os';
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

/** Linux starttime (field 22). A reused pid has a different value. */
function procStartId(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const end = stat.lastIndexOf(')');
    if (end < 0) return '';
    const fields = stat.slice(end + 2).trim().split(/\s+/);
    return fields[19] || '';
  } catch {
    return '';
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
    if (pidAlive(pid)) {
      const recorded = String(info?.start || '');
      const live = procStartId(pid);
      if (recorded && live && recorded !== live) return { reused: true, pid };
      return { busy: true, pid };
    }
    return { stale: true, pid };
  } catch {
    return { stale: true };
  }
}

function inUse(lockPath, pid) {
  const who = pid ? ` by pid ${pid}` : '';
  const err = new Error(`datadir in use${who}: ${lockPath}`);
  err.code = 'datadir_in_use';
  return err;
}

function reusedPid(pid, lockPath) {
  const err = new Error(`datadir lock pid ${pid} was reused by another process: delete ${lockPath}`);
  err.code = 'datadir_lock_reused';
  return err;
}

function unreadableLock(lockPath) {
  const err = new Error(`datadir lock unreadable: ${lockPath}`);
  err.code = 'datadir_lock_unreadable';
  return err;
}

function pause(ms) {
  const sab = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(sab), 0, 0, ms);
}

function lockRecord() {
  return {
    pid: process.pid,
    start: procStartId(process.pid),
    host: os.hostname(),
    startedAt: new Date().toISOString(),
  };
}

function confirmOurs(lockPath) {
  let text = '';
  try {
    text = fs.readFileSync(lockPath, 'utf8');
  } catch {
    throw unreadableLock(lockPath);
  }
  try {
    const info = JSON.parse(text);
    return Number(info?.pid) === process.pid;
  } catch {
    return false;
  }
}

function claimFresh(lockPath) {
  let fd;
  try {
    fd = fs.openSync(lockPath, 'wx', 0o600);
  } catch (err) {
    if (err?.code === 'EEXIST') return null;
    throw err;
  }
  try {
    fs.writeFileSync(fd, `${JSON.stringify(lockRecord())}\n`);
    try { fs.fsyncSync(fd); } catch { /* ignore */ }
  } catch (err) {
    try { fs.closeSync(fd); } catch { /* ignore */ }
    try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
    throw err;
  }
  let ours = false;
  try {
    ours = confirmOurs(lockPath);
    if (!ours) {
      pause(10);
      ours = confirmOurs(lockPath);
    }
  } catch (err) {
    try { fs.closeSync(fd); } catch { /* ignore */ }
    throw err;
  }
  if (!ours) {
    try { fs.closeSync(fd); } catch { /* ignore */ }
    return null;
  }
  return { fd, path: lockPath };
}

/**
 * Rename a stale lock aside, create the lock exclusively, then keep it only
 * when the new file still names this pid. A live file observed after the
 * rename is put back. An unreadable file is never removed.
 */
function takeStale(lockPath, attempt) {
  const aside = `${lockPath}.${process.pid}.${attempt}.aside`;
  try {
    fs.renameSync(lockPath, aside);
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw unreadableLock(lockPath);
  }
  const moved = readLock(aside);
  if (moved.unreadable) {
    try { fs.renameSync(aside, lockPath); } catch { /* ignore */ }
    throw unreadableLock(lockPath);
  }
  if (moved.reused) {
    try { fs.renameSync(aside, lockPath); } catch { /* ignore */ }
    throw reusedPid(moved.pid, lockPath);
  }
  if (moved.busy) {
    try { fs.renameSync(aside, lockPath); } catch { /* ignore */ }
    throw inUse(lockPath, moved.pid);
  }
  if (moved.ours || moved.pending) {
    try { fs.renameSync(aside, lockPath); } catch { /* ignore */ }
    return null;
  }
  const rec = claimFresh(lockPath);
  if (rec) {
    try { fs.unlinkSync(aside); } catch { /* ignore */ }
  }
  return rec;
}

function armExit() {
  if (exitArmed) return;
  exitArmed = true;
  process.on('exit', () => {
    for (const rec of held.values()) {
      try { if (rec.fd != null) fs.closeSync(rec.fd); } catch { /* ignore */ }
      try { fs.unlinkSync(rec.path); } catch { /* ignore */ }
    }
    held.clear();
  });
}

function adopt(key, lockPath, rec) {
  held.set(key, rec);
  armExit();
  return rec;
}

/** Refuse a second process. A dead holder's lock is replaced only by an exclusive create. */
export function acquireDatadirLock(dir) {
  const key = path.resolve(String(dir || ''));
  if (held.has(key)) return held.get(key);
  const lockPath = path.join(key, DATADIR_LOCK_NAME);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const state = readLock(lockPath);
    if (state.ours) return adopt(key, lockPath, held.get(key) || { path: lockPath, fd: null });
    if (state.reused) throw reusedPid(state.pid, lockPath);
    if (state.busy) throw inUse(lockPath, state.pid);
    if (state.unreadable) throw unreadableLock(lockPath);
    if (state.pending) {
      pause(20);
      continue;
    }
    const rec = state.stale ? takeStale(lockPath, attempt) : claimFresh(lockPath);
    if (!rec) {
      pause(20);
      continue;
    }
    return adopt(key, lockPath, rec);
  }
  throw inUse(lockPath);
}
