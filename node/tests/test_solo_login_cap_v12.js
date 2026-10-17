import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { freshStealthDest, newIdentity } from '../../crypto/address.js';
import { payeeProbeCount } from '../../crypto/n1.js';
import { createSoloStratum, SOLO_LOGINS_PER_SOCKET } from '../src/solo_stratum.js';

function coldDests(n) {
  const id = newIdentity();
  const out = [];
  for (let i = 0; i < n; i += 1) out.push(freshStealthDest(id).dest);
  return out;
}

function openSolo() {
  const store = {
    jobs: new Map(),
    tip() { return { height: 0, hash: Buffer.alloc(32, 1) }; },
    template() {
      return { job: { jobId: 'solo-job', header: '00'.repeat(80), shareBits: 8, bits: 8 } };
    },
    on() { return () => {}; },
  };
  return createSoloStratum({ store, port: 0, host: '127.0.0.1', restampMs: 0 });
}

function loginBody(dests) {
  return `${dests.map((dest, i) => JSON.stringify({
    id: i,
    method: 'login',
    params: { login: `${dest}.solo`, threads: 1 },
  })).join('\n')}\n`;
}

function send(port, body, expectLines) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1');
    let buf = '';
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { sock.destroy(); } catch { /* ignore */ }
      resolve(buf.split('\n').filter(Boolean).map((s) => JSON.parse(s)));
    };
    const timer = setTimeout(() => {
      done = true;
      try { sock.destroy(); } catch { /* ignore */ }
      reject(new Error('solo login timeout'));
    }, 20_000);
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      const lines = buf.split('\n').filter(Boolean);
      if (lines.length >= expectLines) sock.end();
    });
    sock.on('error', (err) => {
      if (err?.code === 'ECONNRESET' || err?.code === 'EPIPE') return;
      if (!done) {
        done = true;
        clearTimeout(timer);
        reject(err);
      }
    });
    sock.on('close', finish);
    sock.on('connect', () => sock.write(body));
  });
}

describe('solo stratum per-socket login cap', () => {
  for (const n of [1, 64, 256, 4096]) {
    it(`${n} fresh-dest logins probe at most the socket cap`, async () => {
      const stratum = openSolo();
      const bound = await stratum.listen();
      try {
        const before = payeeProbeCount();
        const cap = Math.min(n, SOLO_LOGINS_PER_SOCKET);
        const msgs = await send(bound.port, loginBody(coldDests(n)), n > cap ? cap + 1 : cap);
        const probes = payeeProbeCount() - before;
        assert.equal(probes, cap, `${n} lines probed ${probes}`);
        assert.ok(probes <= SOLO_LOGINS_PER_SOCKET);
        assert.equal(msgs.length, n > cap ? cap + 1 : cap);
        assert.ok(msgs.slice(0, cap).every((m) => m.result?.status === 'OK'));
        if (n > cap) assert.equal(msgs[cap].error, 'busy');
      } finally {
        stratum.close();
      }
    });
  }
});
