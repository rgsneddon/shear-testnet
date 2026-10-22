/**
 * R3: a hello carries sha256(consensusFingerprint). Same magic and a different
 * fingerprint do not peer. A matching fingerprint does.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createStore } from '../src/store.js';
import { createP2p, fingerprintHelloHash } from '../src/p2p.js';
import { MAGIC_TESTNET, consensusFingerprint } from '../../crypto/asert.js';

const FP_A = 'aa'.repeat(32);
const FP_B = 'bb'.repeat(32);

function waitUntil(pred, ms = 2500) {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      let ok = false;
      try { ok = pred(); } catch (err) { reject(err); return; }
      if (ok) { resolve(true); return; }
      if (Date.now() - t0 > ms) { reject(new Error('timeout')); return; }
      setTimeout(tick, 20);
    };
    tick();
  });
}

function openPair(fingerprintA, fingerprintB) {
  const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-fp-a-'));
  const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-fp-b-'));
  const storeA = createStore(dirA);
  const storeB = createStore(dirB);
  const a = createP2p({
    store: storeA, port: 0, host: '127.0.0.1', magic: MAGIC_TESTNET, fingerprint: fingerprintA,
  });
  const b = createP2p({
    store: storeB, port: 0, host: '127.0.0.1', magic: MAGIC_TESTNET, fingerprint: fingerprintB,
  });
  return {
    a,
    b,
    async close() {
      try { a.close(); } catch { /* ignore */ }
      try { b.close(); } catch { /* ignore */ }
      fs.rmSync(dirA, { recursive: true, force: true });
      fs.rmSync(dirB, { recursive: true, force: true });
    },
  };
}

describe('p2p fingerprint handshake', { timeout: 20000 }, () => {
  it('sha256 of the consensus fingerprint is the hello hash', () => {
    const want = createHash('sha256').update(consensusFingerprint(MAGIC_TESTNET), 'utf8').digest('hex');
    assert.equal(fingerprintHelloHash(MAGIC_TESTNET), want);
    assert.equal(want.length, 64);
  });

  it('same MAGIC and different fingerprints do not peer', async () => {
    const logs = [];
    const orig = console.error;
    console.error = (...args) => {
      logs.push(args.map((x) => String(x)).join(' '));
      orig(...args);
    };
    const pair = openPair(FP_A, FP_B);
    try {
      const bound = await pair.a.listen();
      await pair.b.listen();
      await pair.b.connect('127.0.0.1', bound.port);
      await waitUntil(() => pair.a.peers.size === 0 && pair.b.peers.size === 0);
      await waitUntil(() => [...pair.a.sockets].every((s) => s.destroyed)
        && [...pair.b.sockets].every((s) => s.destroyed));
      assert.equal(pair.a.liveOnline(), 1);
      assert.equal(pair.b.liveOnline(), 1);
      assert.ok(
        logs.some((line) => line.includes('"reason":"fingerprint"')),
        `expected a fingerprint refuse log, got ${logs.join('\n')}`,
      );
    } finally {
      console.error = orig;
      await pair.close();
    }
  });

  it('matching fingerprints peer', async () => {
    const pair = openPair(FP_A, FP_A);
    try {
      const bound = await pair.a.listen();
      await pair.b.listen();
      await pair.b.connect('127.0.0.1', bound.port);
      await waitUntil(() => pair.a.peers.size === 1 && pair.b.peers.size === 1);
      for (const node of [pair.a, pair.b]) {
        const rec = [...node.peers.values()][0];
        assert.match(String(rec.nodeId || ''), /^[0-9a-f]{8,32}$/);
        assert.equal(node.liveOnline(), 2);
      }
    } finally {
      await pair.close();
    }
  });
});
