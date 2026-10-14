/**
 * Windows ignores mkdir mode bits. A datadir stays user-only only when the
 * DACL says so. Other platforms do not report a DACL.
 */
import fs from 'node:fs';
import { execFileSync as execFileSyncDefault } from 'node:child_process';

export function ensureDatadir(dir, {
  platform = process.platform,
  execFileSync = execFileSyncDefault,
} = {}) {
  fs.mkdirSync(dir, { recursive: true });
  if (platform !== 'win32') return { applied: false };
  const user = String(execFileSync('whoami', { encoding: 'utf8', windowsHide: true }) || '').trim();
  if (!user) throw new Error('datadir_acl:whoami');
  execFileSync('icacls', [dir, '/inheritance:r', '/grant:r', `${user}:(OI)(CI)F`], {
    encoding: 'utf8',
    windowsHide: true,
  });
  return { applied: true, user };
}
