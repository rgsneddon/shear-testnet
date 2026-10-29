// PSA r3-2: the datadir-acl-windows gate could not create its second local
// user (a 20-character password makes `net user /add` prompt Y/N; no answer
// on stdin fails it), so the :(F) case never ran. A mock of net.exe's rule
// runs here on Linux.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const diag = path.join(root, 'sheark-miner/bench/win_acl_diag.mjs');
const modPath = path.join(root, 'sheark-miner/bench/win_acl_user.mjs');
const load = async () => {
  assert.ok(fs.existsSync(modPath), 'sheark-miner/bench/win_acl_user.mjs missing');
  return import(modPath);
};

// net.exe as seen on windows-latest: a password over 14 characters asks
// (Y/N) and, with no answer, fails.
function mockNet(calls, { fail = false } = {}) {
  return (file, args, opts) => {
    calls.push([file, ...args]);
    assert.equal(file, 'net');
    if (args[3] === '/add') {
      if (fail) throw new Error('System error 5 has occurred. Access is denied.');
      if (args[2].length > 14) {
        if (!opts || opts.input === undefined || !/^[yY]/.test(String(opts.input))) throw new Error('The password entered is longer than 14 characters. ... No valid response was provided.');
      }
    }
    return 'The command completed successfully.\r\n';
  };
}

describe('datadir-acl-windows: the second local user is created without a prompt', () => {
  it('the password is random, at most 14 characters, and meets the complexity classes', async () => {
    const { netUserPassword, NET_PASSWORD_MAX } = await load();
    assert.equal(NET_PASSWORD_MAX, 14);
    const seen = new Set();
    for (let i = 0; i < 200; i++) {
      const pw = netUserPassword();
      assert.ok(pw.length <= 14 && pw.length >= 12, pw);
      assert.match(pw, /[A-Z]/);
      assert.match(pw, /[a-z]/);
      assert.match(pw, /[0-9]/);
      assert.match(pw, /[^A-Za-z0-9]/);
      seen.add(pw);
    }
    assert.equal(seen.size, 200);
  });
  it('the mock net.exe refuses the old 20-character password with no answer (the r3-2 failure)', () => {
    const net = mockNet([]);
    assert.throws(() => net('net', ['user', 'shearaclabc123', `Aa1!${'x'.repeat(16)}`, '/add'], { encoding: 'utf8' }), /No valid response/);
  });
  it('the :(F) case runs: the user is made once and every case gets its grant', async () => {
    const { otherUser } = await load();
    const calls = [];
    const failures = [];
    const u = otherUser({ exec: mockNet(calls), name: 'shearaclabc123', failures });
    for (let i = 0; i < 6; i++) assert.equal(u.grant(`case ${i}`), 'shearaclabc123:(F)');
    u.cleanup();
    assert.deepEqual(failures, []);
    assert.equal(calls.filter((c) => c[4] === '/add').length, 1, JSON.stringify(calls));
    assert.equal(calls.filter((c) => c[3] === '/delete').length, 1);
  });
  it('a failed creation fails every case that needed the user (never a pass) and is not retried', async () => {
    const { otherUser } = await load();
    const calls = [];
    const failures = [];
    const u = otherUser({ exec: mockNet(calls, { fail: true }), name: 'shearaclabc123', failures });
    for (let i = 0; i < 6; i++) assert.equal(u.grant(`case ${i}`), null);
    u.cleanup();
    assert.equal(calls.filter((c) => c[4] === '/add').length, 1);
    assert.equal(failures.length, 7, failures.join('\n'));
    assert.match(failures[0], /could not create the second local user/);
  });
  it('win_acl_diag.mjs uses it, with no inline 16+ character password', () => {
    const src = fs.readFileSync(diag, 'utf8');
    assert.match(src, /from '\.\/win_acl_user\.mjs'/);
    assert.doesNotMatch(src, /randomBytes\(12\)\.toString\('base64url'\)/);
    assert.match(src, /otherUser\(/);
    assert.match(src, /\.cleanup\(\)/);
  });
});
