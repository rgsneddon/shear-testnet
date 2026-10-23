/**
 * One writer for a book directory.
 * The lock file records the holder pid, host, and start time. A live pid on
 * this host refuses the second process. A dead pid on this host is stale:
 * one process at a time renames that file aside, creates a new one
 * exclusively, and keeps it only when a re-read shows this pid. Restore uses
 * a hard link so it cannot overwrite a lock someone else already created.
 * An unreadable lock, a lock that is not JSON, and a lock from another host
 * fail closed. A claim whose pid was reused, or whose host is not this one,
 * is removed. A live claim on this host is left in place. The same process
 * may open the book again.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DATADIR_LOCK_NAME = 'datadir.lock';
export const DATADIR_CLAIM_NAME = 'datadir.lock.claim';
const CLAIM_NAME = DATADIR_CLAIM_NAME;

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
  let info;
  try {
    info = JSON.parse(text);
  } catch {
    return { corrupt: true };
  }
  if (!info || typeof info !== 'object') return { corrupt: true };
  const pid = Number(info.pid);
  const host = typeof info.host === 'string' ? info.host : '';
  if (host && host !== os.hostname()) return { foreign: true, host, pid };
  if (!Number.isInteger(pid) || pid <= 0) return { corrupt: true };
  if (pid === process.pid) return { ours: true, pid, host };
  if (pidAlive(pid)) {
    const recorded = String(info.start || '');
    const live = procStartId(pid);
    if (recorded && live && recorded !== live) return { reused: true, pid, host };
    return { busy: true, pid, host };
  }
  return { stale: true, pid, host };
}

function inUse(lockPath, pid, host) {
  const who = Number.isInteger(Number(pid)) && Number(pid) > 0 ? `pid ${pid}` : 'pid unknown';
  const where = host ? String(host) : 'unknown';
  const err = new Error(`datadir in use by ${who} on host ${where}: delete ${lockPath}`);
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

function corruptLock(lockPath) {
  const err = new Error(`datadir lock is not json: ${lockPath}`);
  err.code = 'datadir_lock_corrupt';
  return err;
}

function foreignHost(host, lockPath) {
  const err = new Error(`datadir lock from host ${host}: ${lockPath}`);
  err.code = 'datadir_lock_foreign';
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
    return Number(info?.pid) === process.pid && String(info?.host || '') === os.hostname();
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

/** Put a moved lock back without replacing a file that is already at the path. */
function restoreAside(aside, lockPath) {
  try {
    fs.linkSync(aside, lockPath);
  } catch (err) {
    if (err?.code === 'EEXIST') return false;
    return false;
  }
  try { fs.unlinkSync(aside); } catch { /* ignore */ }
  return true;
}

/**
 * Rename a stale lock aside, create the lock exclusively, then keep it only
 * when the new file still names this pid. A live file observed after the
 * rename is linked back. An unreadable or non-JSON file is never removed.
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
    restoreAside(aside, lockPath);
    throw unreadableLock(lockPath);
  }
  if (moved.corrupt) {
    restoreAside(aside, lockPath);
    throw corruptLock(lockPath);
  }
  if (moved.foreign) {
    restoreAside(aside, lockPath);
    throw foreignHost(moved.host, lockPath);
  }
  if (moved.reused) {
    restoreAside(aside, lockPath);
    throw reusedPid(moved.pid, lockPath);
  }
  if (moved.busy) {
    restoreAside(aside, lockPath);
    throw inUse(lockPath, moved.pid, moved.host);
  }
  if (moved.ours || moved.pending) {
    restoreAside(aside, lockPath);
    return null;
  }
  const rec = claimFresh(lockPath);
  if (rec) {
    try { fs.unlinkSync(aside); } catch { /* ignore */ }
  }
  return rec;
}

function releaseClaim(rec) {
  if (!rec) return;
  try { if (rec.fd != null) fs.closeSync(rec.fd); } catch { /* ignore */ }
  try { fs.unlinkSync(rec.path); } catch { /* ignore */ }
}

function clearClaimFile(claimPath) {
  const aside = `${claimPath}.${process.pid}.aside`;
  try {
    fs.renameSync(claimPath, aside);
    fs.unlinkSync(aside);
    return true;
  } catch {
    return false;
  }
}

/**
 * One takeover at a time. A dead, reused, or foreign claim is removed.
 * A live claim on this host is left in place and the caller fails closed.
 */
function acquireClaim(dir) {
  const claimPath = path.join(dir, CLAIM_NAME);
  let blocked = null;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const fd = fs.openSync(claimPath, 'wx', 0o600);
      fs.writeFileSync(fd, `${JSON.stringify(lockRecord())}\n`);
      return { fd, path: claimPath };
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
      const state = readLock(claimPath);
      if (state.missing) continue;
      if (state.unreadable) throw unreadableLock(claimPath);
      if (state.stale || state.corrupt || state.reused || state.foreign) {
        clearClaimFile(claimPath);
        continue;
      }
      if (state.ours) {
        try { fs.unlinkSync(claimPath); } catch { /* ignore */ }
        continue;
      }
      if (state.busy) blocked = state;
      pause(10);
    }
  }
  throw inUse(claimPath, blocked?.pid, blocked?.host);
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

function adopt(key, rec) {
  held.set(key, rec);
  armExit();
  return rec;
}

function refuse(state, lockPath) {
  if (state.reused) throw reusedPid(state.pid, lockPath);
  if (state.foreign) throw foreignHost(state.host, lockPath);
  if (state.corrupt) throw corruptLock(lockPath);
  if (state.unreadable) throw unreadableLock(lockPath);
  if (state.busy) throw inUse(lockPath, state.pid, state.host);
  return false;
}

/** Refuse a second process. A dead holder's lock is replaced only by an exclusive create. */
export function acquireDatadirLock(dir) {
  const key = path.resolve(String(dir || ''));
  if (held.has(key)) return held.get(key);
  const lockPath = path.join(key, DATADIR_LOCK_NAME);
  const claim = acquireClaim(key);
  try {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const state = readLock(lockPath);
      if (state.ours) return adopt(key, held.get(key) || { path: lockPath, fd: null });
      if (refuse(state, lockPath)) return null;
      if (state.pending) {
        pause(20);
        continue;
      }
      const rec = state.stale ? takeStale(lockPath, attempt) : claimFresh(lockPath);
      if (!rec) {
        pause(20);
        continue;
      }
      return adopt(key, rec);
    }
    throw inUse(lockPath);
  } finally {
    releaseClaim(claim);
  }
}
