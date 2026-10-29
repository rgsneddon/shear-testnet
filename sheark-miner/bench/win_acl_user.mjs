// PSA r3-2: the second local user for win_acl_diag.mjs's :(F) case.
// `net user NAME PASSWORD /add` asks "longer than 14 characters ... (Y/N)?"
// for a password over 14 characters; with no answer on stdin it fails ("No
// valid response was provided"), so the case never ran on the runner. The
// password here is 14 characters (random, with upper, lower, digit and
// symbol for the complexity policy), stdin is closed, and the user is
// created at most once per run. A failed or skipped creation is a gate
// failure for every case that needed the user, never a pass.
import { randomBytes } from 'node:crypto';

export const NET_PASSWORD_MAX = 14;
const ALNUM = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

export function netUserPassword(rand = randomBytes) {
  const b = rand(NET_PASSWORD_MAX);
  let body = '';
  for (let i = 0; i < NET_PASSWORD_MAX - 4; i++) body += ALNUM[b[i] % ALNUM.length];
  // One of each class, then the random body: 14 characters in all.
  const pw = `${'ABCDEFGHJKLMNPQRSTUVWXYZ'[b[10] % 24]}${'abcdefghijkmnopqrstuvwxyz'[b[11] % 25]}${'23456789'[b[12] % 8]}${'!#%+-=_'[b[13] % 7]}${body}`;
  return pw;
}

// exec(file, args, opts) is child_process.execFileSync or a mock.
export function otherUser({ exec, name, failures, rand = randomBytes }) {
  let state = 'new';
  let why = '';
  return {
    name,
    // The icacls grant for the :(F) case, or null after recording a failure.
    grant(label) {
      if (state === 'new') {
        state = 'failed';
        try {
          exec('net', ['user', name, netUserPassword(rand), '/add'], { encoding: 'utf8', input: '', stdio: ['pipe', 'pipe', 'pipe'] });
          state = 'made';
        } catch (e) {
          why = String(e.message || e).split('\n')[0];
          failures.push(`could not create the second local user ${name}: ${why}`);
        }
      }
      if (state === 'made') return `${name}:(F)`;
      failures.push(`${label}: skipped, no second local user (${why})`);
      return null;
    },
    cleanup() {
      if (state !== 'made') return;
      try { exec('net', ['user', name, '/delete'], { encoding: 'utf8', input: '', stdio: ['pipe', 'pipe', 'pipe'] }); } catch (e) { failures.push(`net user ${name} /delete: ${e.message}`); }
    },
    get made() { return state === 'made'; },
  };
}
