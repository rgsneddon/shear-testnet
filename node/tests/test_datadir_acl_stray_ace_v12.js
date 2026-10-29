// PR146 (PSA r2-2): on real Windows a datadir with an extra explicit ACE
// (icacls /grant *S-1-1-0:(R)) was refused, not repaired. /grant:r replaces
// only the named trustees' ACEs and /inheritance:r drops only inherited ones,
// so the stray ACE survived the rewrite and the re-verify threw
// datadir_acl:verify every time. The fix strips every ACE for a trustee
// other than the user, SYSTEM and Administrators (icacls /remove), then
// re-verifies; it still fails closed if the re-check shows the ACE, and it
// warns that keys in the datadir may have been readable.
//
// The ACL layer is mocked so this runs on Linux: MockAcl models what icacls
// does to a DACL (/inheritance:r, /grant:r, /remove, /setowner, /T) and
// serves the SDDL readSecurity would return. Real Windows is the
// datadir-acl-windows job (sheark-miner/bench/win_acl_diag.mjs).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureDatadir, SHEWALL_FILE } from '../src/datadir_acl.js';

const USER = 'S-1-5-21-3776380004-1005456608-3524014338-1001';
const SY = 'S-1-5-18';
const BA = 'S-1-5-32-544';
const EVERYONE = 'S-1-1-0';
const USERS = 'S-1-5-32-545';
const AUTH_USERS = 'S-1-5-11';
const OTHER_USER = 'S-1-5-21-3776380004-1005456608-3524014338-1002';
const SYSTEM_DIR = 'C:\\Windows\\System32';
const SYSTEM_ROOT = 'C:\\Windows';

const ace = (type, flags, rights, sid) => ({ type, flags, rights, sid });

class MockAcl {
  constructor(dir, { stubborn = [] } = {}) {
    this.dir = dir;
    this.stubborn = new Set(stubborn); // SIDs /remove leaves in place
    this.calls = [];
    this.rows = new Map();
    // A fresh directory: unprotected, the usual inherited ACEs.
    const inherited = (kind) => [
      ace('A', kind === 'dir' ? ['OI', 'CI', 'ID'] : ['ID'], 'FA', SY),
      ace('A', kind === 'dir' ? ['OI', 'CI', 'ID'] : ['ID'], 'FA', BA),
      ace('A', kind === 'dir' ? ['OI', 'CI', 'ID'] : ['ID'], 'FA', USER),
    ];
    this.kindOf = new Map([[dir, 'dir']]);
    this.rows.set(dir, { owner: USER, protected: false, aces: inherited('dir') });
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      const kind = fs.statSync(p).isDirectory() ? 'dir' : 'file';
      this.kindOf.set(p, kind);
      this.rows.set(p, { owner: USER, protected: false, aces: inherited(kind) });
    }
  }

  add(p, a) { this.rows.get(p).aces.push(a); }

  sddl(p) {
    const r = this.rows.get(p);
    const body = r.aces.map((a) => `(${a.type};${a.flags.join('')};${a.rights};;;${a.sid})`).join('');
    return `O:${r.owner}G:${USER.replace(/-\d+$/, '-513')}D:${r.protected ? 'PAI' : 'AI'}${body}`;
  }

  readSecurity = (p) => {
    if (!this.rows.has(p)) throw new Error(`no such path ${p}`);
    return { owner: this.rows.get(p).owner, sddl: this.sddl(p) };
  };

  // icacls.exe <dir> ... /T /L: every switch applies to the dir and all children.
  execFileSync = (exe, args) => {
    assert.match(String(exe), /icacls\.exe$/i);
    this.calls.push(args.slice());
    const [, ...rest] = args;
    let i = 0;
    while (i < rest.length) {
      const sw = rest[i].toLowerCase();
      i += 1;
      const operands = [];
      while (i < rest.length && !rest[i].startsWith('/')) { operands.push(rest[i]); i += 1; }
      for (const [p, r] of this.rows) {
        const kind = this.kindOf.get(p);
        if (sw === '/inheritance:r') {
          r.aces = r.aces.filter((a) => !a.flags.includes('ID'));
          r.protected = true;
        } else if (sw === '/grant:r') {
          const specs = operands.map((o) => {
            const m = /^\*(S-[\d-]+):((?:\((?:OI|CI)\))*)F$/i.exec(o);
            assert.ok(m, `grant spec ${o}`);
            return { sid: m[1].toUpperCase(), flags: m[2] ? ['OI', 'CI'] : [] };
          });
          const named = new Set(specs.map((s) => s.sid));
          r.aces = r.aces.filter((a) => !(a.type === 'A' && named.has(a.sid)));
          for (const s of specs) {
            if (kind === 'file' && s.flags.length) continue; // inherit-only on a file
            r.aces.push(ace('A', s.flags, 'FA', s.sid));
          }
        } else if (sw.startsWith('/remove')) {
          const types = sw === '/remove:g' ? ['A'] : sw === '/remove:d' ? ['D'] : ['A', 'D'];
          for (const o of operands) {
            const sid = o.replace(/^\*/, '').toUpperCase();
            if (this.stubborn.has(sid)) continue;
            r.aces = r.aces.filter((a) => !(a.sid === sid && types.includes(a.type)));
          }
        } else if (sw === '/setowner') {
          r.owner = operands[0].replace(/^\*/, '').toUpperCase();
        } else if (sw === '/t' || sw === '/l') {
          // every path already
        } else {
          throw new Error(`mock icacls: unhandled switch ${sw}`);
        }
      }
    }
    return 'Successfully processed files\r\n';
  };
}

function fixture({ shewall = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-acl-stray-'));
  if (shewall) fs.writeFileSync(path.join(dir, SHEWALL_FILE), 'k');
  return dir;
}

function ensure(dir, acl, warnings) {
  return ensureDatadir(dir, {
    platform: 'win32',
    getSystemDirectory: () => SYSTEM_DIR,
    readSystemRoot: () => SYSTEM_ROOT,
    realpathSync: (f) => String(f),
    readUserSid: () => USER,
    readSecurity: acl.readSecurity,
    execFileSync: acl.execFileSync,
    warn: (msg) => warnings.push(String(msg)),
  });
}

// Bring the mock to the settled, correct state first (a fresh datadir).
function settled(opts) {
  const dir = fixture(opts);
  const acl = new MockAcl(dir, opts);
  const w = [];
  assert.equal(ensure(dir, acl, w).applied, true);
  assert.equal(ensure(dir, acl, w).applied, false);
  assert.deepEqual(w, [], 'a fresh datadir is not a stray-ACE warning');
  acl.calls.length = 0;
  return { dir, acl };
}

describe('datadir ACL: a stray explicit ACE is repaired, then re-verified (PSA r2-2)', () => {
  const cases = [
    ['Everyone:(R)', ace('A', [], 'FR', EVERYONE)],
    ['Users:(RX)', ace('A', [], '0x1200a9', USERS)],
    ['Authenticated Users:(M)', ace('A', ['OI', 'CI'], '0x1301bf', AUTH_USERS)],
    ['a second local user:(F)', ace('A', ['OI', 'CI'], 'FA', OTHER_USER)],
    ['a deny ACE for Everyone', ace('D', [], 'FA', EVERYONE)],
  ];
  for (const where of ['dir', 'file']) {
    for (const [label, extra] of cases) {
      it(`${label} on the ${where}: repaired (applied true), warned, then settled`, () => {
        const { dir, acl } = settled();
        const target = where === 'dir' ? dir : path.join(dir, SHEWALL_FILE);
        acl.add(target, { ...extra });
        const w = [];
        try {
          const out = ensure(dir, acl, w);
          assert.equal(out.applied, true);
          assert.deepEqual(out.removed, [extra.sid]);
          assert.ok(!acl.sddl(target).includes(extra.sid), acl.sddl(target));
          assert.ok(acl.calls.some((c) => c[1] === '/remove' && c.includes(`*${extra.sid}`)), JSON.stringify(acl.calls));
          assert.equal(w.length, 1, w.join('\n'));
          assert.match(w[0], /may have been readable/);
          assert.ok(w[0].includes(extra.sid), w[0]);
          const again = ensure(dir, acl, w);
          assert.equal(again.applied, false);
          assert.equal(w.length, 1, 'no warning once settled');
        } finally {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      });
    }
  }

  it('fails closed (datadir_acl:verify) when the re-check still shows the stray ACE, and still warns', () => {
    const dir = fixture();
    const acl = new MockAcl(dir, { stubborn: [EVERYONE] });
    const w = [];
    try {
      assert.equal(ensure(dir, acl, w).applied, true);
      acl.add(dir, ace('A', [], 'FR', EVERYONE));
      assert.throws(() => ensure(dir, acl, w), /datadir_acl:verify/);
      assert.throws(() => ensure(dir, acl, w), /datadir_acl:verify/, 'never accepted on a later call');
      assert.ok(w.length >= 1 && w.every((m) => /may have been readable/.test(m)), w.join('\n'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a fresh datadir with only inherited ACEs is set with no /remove and no warning', () => {
    const dir = fixture({ shewall: false });
    const acl = new MockAcl(dir);
    const w = [];
    try {
      assert.equal(ensure(dir, acl, w).applied, true);
      assert.ok(!acl.calls.some((c) => c[1] === '/remove'), JSON.stringify(acl.calls));
      assert.deepEqual(w, []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an inherited stray ACE on an existing shewall.bin is removed and warned about', () => {
    const dir = fixture();
    const acl = new MockAcl(dir);
    acl.add(path.join(dir, SHEWALL_FILE), ace('A', ['ID'], 'FR', USERS));
    acl.add(dir, ace('A', ['OI', 'CI', 'ID'], 'FR', USERS));
    const w = [];
    try {
      assert.equal(ensure(dir, acl, w).applied, true);
      assert.equal(w.length, 1, w.join('\n'));
      assert.ok(w[0].includes(USERS));
      assert.equal(ensure(dir, acl, w).applied, false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
