/**
 * A fault that exists only in the rows a peer sent, fields the header does
 * not commit to, is that peer's: final and scored against it, and the block
 * hash is never soft-noted, so the honest block stays fetchable from every
 * other peer (Russell 26 Oct, amending the soft-fail ruling).
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { newIdentity, freshStealthDest } from '../../crypto/address.js';
import { MAGIC_REGTEST, regtestBitsOverride } from '../../crypto/regtest_bits.js';
import { MAGIC_TESTNET } from '../../crypto/asert.js';
import { shearHash } from '../../crypto/shear_hash.js';
import {
  createP2p,
  decodeWireBlock,
  encodeWireBlock,
  failActive,
  fingerprintHelloHash,
  jsonWire,
  notePeerOnlyRefusal,
  P2P_FAIL_DISCONNECT,
} from '../src/p2p.js';
import { createRegtestStore } from './regtest_store.js';
import { closeMineWorkers, mineHeaderParallel } from './mine_worker.mjs';

after(() => closeMineWorkers());

const T0 = 1_700_000_000_000;

async function minedBlock(store, miner) {
  const { tpl } = store.template({ miner, bits: regtestBitsOverride(MAGIC_REGTEST), shareBits: 4, now: T0 });
  const found = await mineHeaderParallel(tpl.header, tpl.bits, 8_192, 1);
  assert.ok(found && found.block, 'need pow');
  const got = await Promise.resolve(store.append({
    header: found.header, txs: tpl.txs, samples: tpl.samples, shareBatch: tpl.shareBatch || [],
    miner: tpl.miner, aLeaves: tpl.aLeaves, bLeaves: tpl.bLeaves, rootA: tpl.rootA, rootB: tpl.rootB, weight: tpl.weight,
  }));
  assert.equal(got.ok, true, got.reason);
  return store.tip();
}

/** The block as a peer's frame decodes it. */
function relayed(block) {
  return decodeWireBlock(JSON.parse(jsonWire(encodeWireBlock(block))));
}

describe('a fault only in the rows a peer sent is that peer\'s', () => {
  it('the store refuses a relayer\'s copy as peerOnly and accepts the honest block after it', async () => {
    const source = createRegtestStore(fs.mkdtempSync(path.join(os.tmpdir(), 'shear-peer-only-a-')), { bits: 4 });
    const miner = freshStealthDest(newIdentity()).dest;
    const honest = await minedBlock(source, miner);
    // Fields a relayer adds that compaction drops, so the header does not
    // commit to them: an unsigned key on the coinbase, and a membership
    // carry on it. Each is refused on the rows as they arrived.
    const poisons = [
      (b) => ({ ...b, txs: [{ ...b.txs[0], relayed: 1 }, ...b.txs.slice(1)] }),
      (b) => ({ ...b, txs: [{ ...b.txs[0], spendTag: Buffer.alloc(32, 7) }, ...b.txs.slice(1)] }),
    ];
    for (const [i, poison] of poisons.entries()) {
      const victim = createRegtestStore(fs.mkdtempSync(path.join(os.tmpdir(), `shear-peer-only-b${i}-`)), { bits: 4 });
      const bad = await Promise.resolve(victim.ingest([poison(relayed(honest))]));
      assert.equal(bad.ok, false, `poison ${i}`);
      assert.equal(bad.peerOnly, true, `poison ${i}: ${bad.reason} is the peer's fault`);
      assert.equal(victim.tip(), null);
      const good = await Promise.resolve(victim.ingest([relayed(honest)]));
      assert.equal(good.ok, true, `poison ${i}: honest copy ${good.reason}`);
      assert.equal(victim.tip().height, 1);
    }
  });

  it('notePeerOnlyRefusal: final for that peer, scored, never soft, and no other peer is held', () => {
    const hash = 'ab'.repeat(32);
    const relayer = { failed: new Set(), softFailed: new Map([[hash, { at: 0, reason: 'unsigned', pin: 'x' }]]), expensiveFails: 0 };
    const honestPeer = { failed: new Set(), softFailed: new Map(), expensiveFails: 0 };
    assert.equal(notePeerOnlyRefusal(relayer, hash), false);
    assert.equal(relayer.failed.has(hash), true);
    assert.equal(relayer.softFailed.has(hash), false, 'the hash is never soft-noted for it');
    assert.equal(relayer.expensiveFails, 1, 'scored');
    assert.equal(failActive(relayer, hash), true);
    assert.equal(failActive(honestPeer, hash), false, 'every other peer can still serve it');
    let banned = false;
    for (let i = 0; i < P2P_FAIL_DISCONNECT + 2 && !banned; i += 1) banned = notePeerOnlyRefusal(relayer, `${i}`.padStart(64, '0'));
    assert.equal(banned, true, 'a relayer that keeps doing it is banned');
  });

  it('p2p: the relayer is scored and the honest seed\'s block is taken', async () => {
    let height = 4;
    const tipHash = Buffer.alloc(32, 3);
    const header = Buffer.alloc(128, 0x11);
    tipHash.copy(header, 4);
    header.writeUInt32LE(0, 108);
    const hash = shearHash(header).toString('hex');
    const ingested = [];
    const store = {
      blocks: [{ header: Buffer.alloc(128, 3), hash: tipHash, height: 4 }],
      tip: () => ({ height, hash: height === 4 ? tipHash : Buffer.from(hash, 'hex') }),
      chainWorkHex: () => (height === 4 ? '0x10' : '0x20'),
      ingest(fork) {
        const b = fork[0];
        ingested.push(b);
        // The store's verdict: a relayer's added field is peerOnly.
        if (b?.txs?.[0]?.relayed != null) return { ok: false, reason: 'unsigned', peerOnly: true, at: 0 };
        height = 5;
        return { ok: true };
      },
    };
    const p2p = createP2p({ store, port: 0, host: '127.0.0.1', magic: MAGIC_TESTNET });
    const serve = (txs) => (sock, msg) => {
      if (msg.type === 'hello') {
        sock.write(`${JSON.stringify({ type: 'hello', magic: MAGIC_TESTNET, fingerprint: fingerprintHelloHash(MAGIC_TESTNET) })}\n`);
        sock.write(`${JSON.stringify({ type: 'tip', magic: MAGIC_TESTNET, height: 5, hash, work: '0x20' })}\n`);
      }
      if (msg.type === 'getheaders') {
        sock.write(`${JSON.stringify({ type: 'headers', magic: MAGIC_TESTNET, headers: [{ hash, height: 5, header: header.toString('hex') }] })}\n`);
      }
      if (msg.type === 'getblock' && msg.hash === hash) {
        sock.write(`${JSON.stringify({ type: 'block', magic: MAGIC_TESTNET, block: { header: header.toString('hex'), hash, height: 5, txs, shareBatch: [] } })}\n`);
      }
    };
    const evil = await listenSeed(serve([{ coinbase: true, relayed: 1 }]));
    let honestUp = null;
    let sameIp = null;
    try {
      await p2p.listen();
      await p2p.dialSeeds([`127.0.0.1:${evil.port}`]);
      await waitFor(() => ingested.some((b) => b?.txs?.[0]?.relayed != null), 5000, 'the relayer was never asked');
      await waitFor(() => [...p2p.peers.values()].some((r) => r.failed instanceof Set && r.failed.has(hash)), 3000, 'the relayer was not marked');
      const relayer = [...p2p.peers.values()].find((r) => r.failed instanceof Set && r.failed.has(hash));
      assert.ok(Number(relayer.expensiveFails) >= 1, 'the relayer is scored');
      assert.equal(relayer.softFailed instanceof Map && relayer.softFailed.has(hash), false, 'never soft-noted');
      // One link per address stays the rule (anti-sybil): a second seed on
      // the relayer's IP is never a second peer.
      sameIp = await listenSeed(serve([]));
      await p2p.dialSeeds([`127.0.0.1:${sameIp.port}`]);
      assert.equal([...p2p.peers.values()].filter((r) => r.remote === '127.0.0.1').length, 1, 'one link per IP');
      // Another address: p2p keeps one link per peer address, as a node
      // meets honest peers on their own IPs. connect() dials loopback only as
      // 127.0.0.1 or ::1, so the honest seed is on ::1.
      honestUp = await listenSeed(serve([]), '::1');
      await p2p.dialSeeds([`::1:${honestUp.port}`]);
      try {
        await waitFor(() => height === 5, 8000, 'the honest block was not taken from the honest seed');
      } catch (err) {
        // The peers' sync state, for the failure report.
        const state = [...p2p.peers.values()].map((r) => ({
          remote: r.remote, helloAt: !!r.helloAt, syncing: r.syncing, syncEligible: r.syncEligible,
          demoted: Number(r.demoteUntil) > Date.now(), adHeight: r.adHeight, gossipHeight: r.gossipHeight,
          want: r.want, pending: [...(r.pending || [])], failed: [...(r.failed || [])], wantHeight: r.wantHeight,
        }));
        throw new Error(`${err.message}: ${JSON.stringify(state)}`);
      }
      assert.equal(ingested.filter((b) => b?.txs?.[0]?.relayed != null).length, 1, 'the relayer\'s copy was verified once');
    } finally {
      evil.close();
      honestUp?.close();
      sameIp?.close();
      p2p.close();
    }
  });
});

function listenSeed(onLine, host = '127.0.0.1') {
  const sockets = new Set();
  return new Promise((resolve, reject) => {
    const server = net.createServer((sock) => {
      sockets.add(sock);
      sock.on('close', () => sockets.delete(sock));
      let buf = '';
      sock.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const raw = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!raw) continue;
          let msg;
          try { msg = JSON.parse(raw); } catch { continue; }
          onLine(sock, msg);
        }
      });
    });
    server.once('error', reject);
    server.listen(0, host, () => {
      resolve({
        port: server.address().port,
        close() {
          for (const sock of sockets) sock.destroy();
          server.close();
        },
      });
    });
  });
}

function waitFor(pred, ms, label) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = setInterval(() => {
      let ok = false;
      try { ok = !!pred(); } catch (err) {
        clearInterval(tick);
        reject(err);
        return;
      }
      if (ok) {
        clearInterval(tick);
        resolve();
        return;
      }
      if (Date.now() - start >= ms) {
        clearInterval(tick);
        reject(new Error(label));
      }
    }, 20);
  });
}
