/**
 * SHEAR_RAM explorer node. Replaces node:fs write methods so a missed
 * call site still throws. Reads stay available.
 */
import fs from 'node:fs';

const RAM = 'shear_ram';

const WRITE_NAMES = [
  'appendFile',
  'appendFileSync',
  'chmod',
  'chmodSync',
  'chown',
  'chownSync',
  'copyFile',
  'copyFileSync',
  'cp',
  'cpSync',
  'createWriteStream',
  'fchmod',
  'fchmodSync',
  'fchown',
  'fchownSync',
  'fdatasync',
  'fdatasyncSync',
  'fsync',
  'fsyncSync',
  'ftruncate',
  'ftruncateSync',
  'futimes',
  'futimesSync',
  'lchmod',
  'lchmodSync',
  'lchown',
  'lchownSync',
  'link',
  'linkSync',
  'lutimes',
  'lutimesSync',
  'mkdir',
  'mkdirSync',
  'mkdtemp',
  'mkdtempSync',
  'rename',
  'renameSync',
  'rm',
  'rmSync',
  'rmdir',
  'rmdirSync',
  'symlink',
  'symlinkSync',
  'truncate',
  'truncateSync',
  'unlink',
  'unlinkSync',
  'utimes',
  'utimesSync',
  'write',
  'writeFile',
  'writeFileSync',
  'writeSync',
  'writev',
  'writevSync',
];

const OPEN_NAMES = ['open', 'openSync'];

let installed = false;

function refuse() {
  throw new Error(RAM);
}

function flagsWrite(flags) {
  if (flags == null || flags === '') return false;
  if (typeof flags === 'number') {
    const bits = fs.constants.O_WRONLY
      | fs.constants.O_RDWR
      | fs.constants.O_CREAT
      | fs.constants.O_TRUNC
      | fs.constants.O_APPEND;
    return (flags & bits) !== 0;
  }
  return /[wa+]/.test(String(flags));
}

function guardOpen(original) {
  return function shearRamOpen(file, flags, ...rest) {
    if (flagsWrite(flags)) refuse();
    return original.call(this, file, flags, ...rest);
  };
}

function replace(target, name, value) {
  if (target == null || typeof target[name] !== 'function') return;
  try {
    target[name] = value;
    return;
  } catch {
    /* ESM export may be read-only; defineProperty below. */
  }
  Object.defineProperty(target, name, {
    value,
    writable: true,
    configurable: true,
  });
}

function patchSurface(target) {
  if (target == null) return;
  for (const name of WRITE_NAMES) replace(target, name, refuse);
  for (const name of OPEN_NAMES) {
    const original = target[name];
    if (typeof original === 'function') replace(target, name, guardOpen(original));
  }
}

/** Install once per process. A second call leaves the first wrappers in place. */
export function installRamFs() {
  if (installed) return;
  installed = true;
  patchSurface(fs);
  patchSurface(fs.promises);
}
