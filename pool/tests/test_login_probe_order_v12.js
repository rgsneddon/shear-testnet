import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { SHEARK_MINER_VERSION } from '../../crypto/asert.js';
import { admitBaseFromAddress, freshStealthDest, newIdentity } from '../../crypto/address.js';
import { payeeDecodeOk, payeeProbeCount } from '../../crypto/n1.js';
import {
  IP_SOFT_STRIKES,
  LOGIN_PER_IP_MAX,
  configuredFeeIdentity,
  createPool,
} from '../src/pool.js';

const LINES = 256;
// 92d2cfc3 ran 256 lines in ~2 ms. 920f1469 took ~3.1 s. Headroom is for CI noise.
const REFUSED_BURST_MS = 25;
const FRESH_BURST_MS = 1000;

function openPool() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-login-probe-'));
  const fee = configuredFeeIdentity();
  assert.equal(fee.ok, true);
  const pool = createPool({ dataDir: dir, stratumPort: 0, httpPort: 0, miner: fee.feeDest });
  // The first template build is not login work. Keep it out of the timings.
  pool.issueJob();
  return pool;
}

function coldDests(n) {
  const id = newIdentity();
  const out = [];
  for (let i = 0; i < n; i += 1) out.push(freshStealthDest(id).dest);
  assert.ok(admitBaseFromAddress(out[0]), 'a long dest carries B');
  return out;
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

function loginLine(dest, i, extra = {}) {
  return JSON.stringify({
    id: i,
    method: 'login',
    params: { login: dest, client: 'ShearHash', version: SHEARK_MINER_VERSION, threads: 1, ...extra },
  });
}

function burst(sock, dests) {
  const body = `${dests.map((d, i) => loginLine(d, i)).join('\n')}\n`;
  const probes = payeeProbeCount();
  const t0 = process.hrtime.bigint();
  sock.emit('data', Buffer.from(body));
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return { ms, probes: payeeProbeCount() - probes, bytes: body.length };
}

function replies(sock) {
  return sock.lines.map((s) => JSON.parse(s));
}

describe('PSA-920-1 login: IP deny and budget before the FS-1 leaf probe', () => {
  it('a budget-spent IP pays decode only for 256 cold long-dest lines', () => {
    const pool = openPool();
    try {
      const ip = '10.9.0.1';
      const first = connect(pool, ip);
      const fresh = burst(first, coldDests(LINES));
      const got = replies(first);
      assert.equal(got.length, LOGIN_PER_IP_MAX + 1, 'the socket stops at the first refusal');
      assert.ok(got.slice(0, LOGIN_PER_IP_MAX).every((m) => m.result?.status === 'OK'));
      assert.equal(got[LOGIN_PER_IP_MAX].error, 'busy');
      assert.equal(first.ended, true);
      assert.equal(fresh.probes, LOGIN_PER_IP_MAX, 'only budgeted logins probe the leaf');
      assert.ok(fresh.ms < FRESH_BURST_MS, `fresh IP burst ${fresh.ms.toFixed(1)} ms`);

      const before = pool.miners.size;
      const second = connect(pool, ip);
      const spent = burst(second, coldDests(LINES));
      console.log(JSON.stringify({
        event: 'psa_920_1_timing',
        lines: LINES,
        bytes: spent.bytes,
        freshMs: Number(fresh.ms.toFixed(2)),
        spentMs: Number(spent.ms.toFixed(2)),
      }));
      assert.deepEqual(replies(second).map((m) => m.error), ['busy']);
      assert.equal(spent.probes, 0, 'a refused login probes no leaf');
      assert.equal(pool.miners.size, before);
      assert.ok(spent.ms < REFUSED_BURST_MS, `budget-spent burst ${spent.ms.toFixed(2)} ms`);
    } finally {
      pool.close();
    }
  });

  it('a denied IP is refused before any decode', () => {
    const pool = openPool();
    try {
      const ip = '10.9.0.2';
      for (let i = 0; i < IP_SOFT_STRIKES; i += 1) {
        const s = connect(pool, ip);
        s.emit('data', Buffer.from(`${JSON.stringify({ id: 1, method: 'login', params: { login: coldDests(1)[0], client: 'other' } })}\n`));
      }
      const sock = connect(pool, ip);
      const got = burst(sock, coldDests(LINES));
      assert.deepEqual(replies(sock).map((m) => m.error), ['banned']);
      assert.equal(got.probes, 0);
      assert.equal(pool.miners.size, 0);
      assert.ok(got.ms < REFUSED_BURST_MS, `denied burst ${got.ms.toFixed(2)} ms`);
    } finally {
      pool.close();
    }
  });

  it('data after a refusal is not parsed', () => {
    const pool = openPool();
    try {
      const sock = connect(pool, '10.9.0.3');
      sock.emit('data', Buffer.from(`${JSON.stringify({ id: 1, method: 'login', params: { login: 'x', client: 'other' } })}\n`));
      assert.deepEqual(replies(sock).map((m) => m.error), ['client_refused']);
      const probes = payeeProbeCount();
      sock.emit('data', Buffer.from(`${coldDests(8).map((d, i) => loginLine(d, i)).join('\n')}\n`));
      assert.equal(sock.lines.length, 1);
      assert.equal(payeeProbeCount(), probes);
      assert.equal(pool.miners.size, 0);
    } finally {
      pool.close();
    }
  });

  it('the leaf probe is cached: a known worker reconnects without a probe', () => {
    const pool = openPool();
    try {
      const [d] = coldDests(1);
      const a = connect(pool, '10.9.0.4');
      const first = burst(a, [d]);
      assert.equal(replies(a)[0].result?.status, 'OK');
      assert.ok(first.probes >= 1, 'the first login probes the leaf');
      const b = connect(pool, '10.9.0.4');
      const again = burst(b, [d]);
      assert.equal(replies(b)[0].result?.status, 'OK');
      assert.equal(again.probes, 0);
    } finally {
      pool.close();
    }
  });

  it('pre-budget decode never probes the leaf', () => {
    const before = payeeProbeCount();
    assert.equal(payeeDecodeOk('not-a-dest'), true, 'a non-dest is not a payee');
    assert.equal(payeeDecodeOk(coldDests(1)[0]), true);
    assert.equal(payeeProbeCount(), before);
  });
});
