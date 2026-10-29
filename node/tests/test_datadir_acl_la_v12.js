// R41: the datadir DACL check accepts the SDDL alias LA when the current
// user is the built-in Administrator (RID 500). Windows writes that account
// as "LA" in SDDL (owner and ACE trustee), as it does for runneradmin on a
// GitHub Windows runner and for Administrator on a Windows Server VPS. The
// check compared "LA" with the user's SID, refused a correct DACL, re-ran
// icacls and then threw datadir_acl:verify, so the node store could not open
// any datadir on such a machine. LA for any other user is another account and
// still fails closed.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureDatadir, resolveMachineAliases } from '../src/datadir_acl.js';

const MACHINE = 'S-1-5-21-3776380004-1005456608-3524014338';
const ADMIN_500 = `${MACHINE}-500`;
const OTHER_USER = `${MACHINE}-1001`;
const SYSTEM_DIR = 'D:\\Windows\\System32';
const SYSTEM_ROOT = 'D:\\Windows';

// The SDDL the runner returned for a datadir icacls had just set (R41 Windows
// diagnostic, run 40697599769), with its group SID.
const RUNNER_SDDL = `O:LAG:${MACHINE}-513D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;LA)`;

function run(userSid, sddl) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-acl-la-'));
  let icacls = 0;
  try {
    return {
      out: ensureDatadir(dir, {
        platform: 'win32',
        getSystemDirectory: () => SYSTEM_DIR,
        readSystemRoot: () => SYSTEM_ROOT,
        realpathSync: (f) => String(f),
        readUserSid: () => userSid,
        readSecurity: () => ({ owner: userSid, sddl }),
        execFileSync: () => { icacls += 1; return 'Successfully processed 1 files\r\n'; },
      }),
      icacls,
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('datadir DACL with the LA alias (R41)', () => {
  it('LA resolves to RID 500 of the current user machine prefix', () => {
    assert.equal(resolveMachineAliases(RUNNER_SDDL, ADMIN_500),
      `O:${ADMIN_500}G:${MACHINE}-513D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;${ADMIN_500})`);
  });

  it('the built-in Administrator\'s correct DACL is accepted, with no icacls rewrite', () => {
    const { out, icacls } = run(ADMIN_500, RUNNER_SDDL);
    assert.equal(out.applied, false);
    assert.equal(icacls, 0);
  });

  it('for any other user an LA trustee is another account: still refused', () => {
    assert.throws(() => run(OTHER_USER, RUNNER_SDDL.replace('O:LA', `O:${OTHER_USER}`)), /datadir_acl:verify/);
  });
});
