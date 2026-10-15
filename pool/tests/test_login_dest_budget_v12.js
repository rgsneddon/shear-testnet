import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { SHEARK_MINER_VERSION } from '../../crypto/asert.js';
import { encodeDest, freshStealthDest, newIdentity } from '../../crypto/address.js';
import { payeeFs1Ok, payeeProbeCount } from '../../crypto/n1.js';
import {
  LOGIN_DESTS_PER_SOCKET,
  LOGIN_PER_IP_MAX,
  LOGIN_PER_PREFIX_MAX,
  configuredFeeIdentity,
  createPool,
  loginBudgetPrefix,
} from '../src/pool.js';

function openPool() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-login-dest-'));
  const fee = configuredFeeIdentity();
  assert.equal(fee.ok, true);
  const pool = createPool({ dataDir: dir, stratumPort: 0, httpPort: 0, miner: fee.feeDest });
  pool.issueJob();
  return pool;
}

function coldDests(n) {
  const id = newIdentity();
  const out = [];
  for (let i = 0; i < n; i += 1) out.push(freshStealthDest(id).dest);
  return out;
}

function shortDest(n) {
  const body = Buffer.alloc(20, 0);
  body.writeUInt32BE(n + 1, 0);
  return encodeDest(body);
}

function connect(pool, ip) {
  const sock = new EventEmitter();
  sock.remoteAddress = ip;
  sock.lines = [];
  sock.ended = false;
  sock.setNoDelay = () => {};
  sock.write = (s) => { sock.lines.push(String(s)); return true; };
  sock.end = (s) => { if (s) sock.lines.push(String(s)); sock.ended = true; };
  sock.destroy = () => { sock.ended = true; };
  pool.stratum.emit('connection', sock);
  return sock;
}

function loginLine(login, i, extra = {}) {
  return JSON.stringify({
    id: i,
    method: 'login',
    params: { login, client: 'ShearHash', version: SHEARK_MINER_VERSION, threads: 1, ...extra },
  });
}

function burst(sock, body) {
  const probes = payeeProbeCount();
  const t0 = process.hrtime.bigint();
  sock.emit('data', Buffer.from(body));
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return { ms, probes: payeeProbeCount() - probes };
}

function replies(sock) {
  return sock.lines.map((s) => JSON.parse(s));
}

describe('login budget prefix', () => {
  it('groups IPv4 /24 and IPv6 /48', () => {
    assert.equal(loginBudgetPrefix('10.1.2.3'), '10.1.2.0/24');
    assert.equal(loginBudgetPrefix('10.1.2.255'), loginBudgetPrefix('10.1.2.1'));
    assert.notEqual(loginBudgetPrefix('10.1.3.1'), loginBudgetPrefix('10.1.2.1'));
    assert.equal(loginBudgetPrefix('::ffff:10.1.2.9'), '10.1.2.0/24');
    const a = loginBudgetPrefix('2001:db8:abcd:12::1');
    const b = loginBudgetPrefix('2001:0db8:abcd:ffff::2');
    assert.equal(a, '2001:0db8:abcd::/48');
    assert.equal(a, b);
    assert.notEqual(loginBudgetPrefix('2001:db8:abce::1'), a);
    assert.equal(loginBudgetPrefix(''), '');
    assert.equal(loginBudgetPrefix('not-an-ip'), '');
  });
});

describe('PSA-920-1b same name, fresh dest', () => {
  const name = `${shortDest(900000)}.rig`;
  for (const n of [1, 64, 256, 4096]) {
    it(`${n} lines probe at most the per-IP budget`, () => {
      const pool = openPool();
      try {
        const dests = coldDests(n);
        const body = `${dests.map((d, i) => loginLine(name, i, { dest: d })).join('\n')}\n`;
        const sock = connect(pool, `10.9.20.${n % 200}`);
        const got = burst(sock, body);
        const cap = Math.min(n, LOGIN_PER_IP_MAX, LOGIN_DESTS_PER_SOCKET);
        assert.equal(got.probes, cap, `${n} lines probed ${got.probes}`);
        assert.ok(got.probes <= LOGIN_PER_IP_MAX);
        const msgs = replies(sock);
        assert.equal(msgs.length, n > cap ? cap + 1 : cap);
        assert.ok(msgs.slice(0, cap).every((m) => m.result?.status === 'OK'));
        if (n > cap) {
          assert.equal(msgs[cap].error, 'busy');
          assert.equal(sock.ended, true);
          assert.ok(got.ms < 5000, `${n} lines took ${got.ms.toFixed(1)} ms`);
        }
        assert.equal(pool.miners.size, 1);
      } finally {
        pool.close();
      }
    });
  }

  it('a socket cannot rotate dests after the leaf is cached', () => {
    const pool = openPool();
    try {
      const extra = LOGIN_DESTS_PER_SOCKET + 3;
      const dests = coldDests(extra);
      for (const d of dests) assert.equal(payeeFs1Ok(d), true);
      const body = `${dests.map((d, i) => loginLine(name, i, { dest: d })).join('\n')}\n`;
      const sock = connect(pool, '10.9.21.1');
      const got = burst(sock, body);
      assert.equal(got.probes, 0, 'a cached dest is not probed again');
      const msgs = replies(sock);
      assert.equal(msgs.length, LOGIN_DESTS_PER_SOCKET + 1);
      assert.ok(msgs.slice(0, LOGIN_DESTS_PER_SOCKET).every((m) => m.result?.status === 'OK'));
      assert.equal(msgs[LOGIN_DESTS_PER_SOCKET].error, 'busy');
      assert.equal(sock.ended, true);
    } finally {
      pool.close();
    }
  });

  it('an IPv4 /24 budget stops a fresh address before the leaf probe', () => {
    const pool = openPool();
    try {
      for (let i = 0; i < LOGIN_PER_PREFIX_MAX; i += 1) {
        const sock = connect(pool, `10.50.1.${i + 1}`);
        const got = burst(sock, `${loginLine(shortDest(1000 + i), i)}\n`);
        assert.equal(got.probes, 0);
        assert.equal(replies(sock)[0].result?.status, 'OK');
      }
      const blocked = connect(pool, '10.50.1.200');
      const [long] = coldDests(1);
      const denied = burst(blocked, `${loginLine(long, 1)}\n`);
      assert.equal(replies(blocked)[0].error, 'busy');
      assert.equal(denied.probes, 0);
      const other = connect(pool, '10.50.2.1');
      const [next] = coldDests(1);
      const allowed = burst(other, `${loginLine(next, 2)}\n`);
      assert.equal(replies(other)[0].result?.status, 'OK');
      assert.equal(allowed.probes, 1);
    } finally {
      pool.close();
    }
  });

  it('an IPv6 /48 budget stops a fresh address before the leaf probe', () => {
    const pool = openPool();
    try {
      for (let i = 0; i < LOGIN_PER_PREFIX_MAX; i += 1) {
        const sock = connect(pool, `2001:db8:920::${i + 1}`);
        const got = burst(sock, `${loginLine(shortDest(2000 + i), i)}\n`);
        assert.equal(got.probes, 0);
        assert.equal(replies(sock)[0].result?.status, 'OK');
      }
      const blocked = connect(pool, '2001:db8:920::ffff');
      const [long] = coldDests(1);
      const denied = burst(blocked, `${loginLine(long, 1)}\n`);
      assert.equal(replies(blocked)[0].error, 'busy');
      assert.equal(denied.probes, 0);
      const other = connect(pool, '2001:db8:921::1');
      const [next] = coldDests(1);
      const allowed = burst(other, `${loginLine(next, 2)}\n`);
      assert.equal(replies(other)[0].result?.status, 'OK');
      assert.equal(allowed.probes, 1);
    } finally {
      pool.close();
    }
  });
});
