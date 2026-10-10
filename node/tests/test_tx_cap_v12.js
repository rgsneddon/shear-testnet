/**
 * N-49: 8-in/8-out is the first stateless check, the bound-proof identity
 * check is linear, an oversize tx scores the peer, and a wallet POST is
 * capped before the body is buffered. Coinbase keeps its payee outputs.
 * Any amount, any count above the cap, any declared body up to the frame.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createStore } from '../src/store.js';
import { verifyBlock, digestTx } from '../src/chain.js';
import { decodeHeader, encodeHeader } from '../../crypto/header.js';
import { merkleRoot } from '../../crypto/merkle.js';
import {
  flowInputsBound,
  sameSpendProof,
  txSpendTagParses,
  resetTxSpendTagParses,
} from '../../crypto/note.js';
import { admitMempool, emptyMempool } from '../../crypto/mempool.js';
import { newIdentity } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import {
  createP2p,
  P2P_MAX_FRAME_DEFAULT,
  P2P_FAIL_DISCONNECT,
} from '../src/p2p.js';
import { createPool, judgeShare } from '../../pool/src/pool.js';

const AMOUNTS = [1, 100_000_000_000];
const UNDER_IN = [1, 2, 4, 8];
const OVER_IN = [9, 64];
const FRAME_P = Math.floor(P2P_MAX_FRAME_DEFAULT / 256);

function minerDest() {
  const id = newIdentity();
  return destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
}

let powTag = 1;
function easyPowHash() {
  const h = Buffer.alloc(32);
  h[4] = powTag & 0xff;
  h[5] = (powTag >> 8) & 0xff;
  h[6] = (powTag >> 16) & 0xff;
  powTag += 1;
  return h;
}

function word(n) {
  const b = Buffer.alloc(32);
  b.writeUInt32BE(n >>> 0, 0);
  return b;
}

function shapedFlow(n, nanos, id) {
  const vins = new Array(n);
  const proofs = new Array(n);
  for (let i = 0; i < n; i += 1) {
    const c = word((n * 1000003 + i + 1) >>> 0);
    const tag = word((i + 1) >>> 0);
    tag[31] = n & 0xff;
    vins[i] = { commit: c };
    proofs[i] = { cTilde: c, spendTag: tag };
  }
  const tx = {
    id,
    kind: 'send',
    nanos,
    fee: 1,
    vin: vins,
    vout: [{ kind: 'send', nanos }],
  };
  if (n === 1) tx.admit_proof = proofs[0];
  else tx.admit_proofs = proofs;
  return tx;
}

function shapedOuts(n, nanos, id) {
  const c = word(7);
  return {
    id,
    kind: 'send',
    nanos,
    fee: 1,
    vin: [{ commit: c }],
    admit_proof: { cTilde: c, spendTag: word(8) },
    vout: Array.from({ length: n }, () => ({ kind: 'send', nanos })),
  };
}

function versioned(fill, version) {
  const blob = Buffer.alloc(33, fill);
  blob[0] = version;
  const tag = Buffer.from(blob.subarray(1, 33));
  const c = word(fill + 3);
  return { blob, cTilde: c, spendTag: tag, commit: c };
}

function flowOf(proofs, admit) {
  return {
    kind: 'send',
    vin: proofs.map((p) => ({ commit: p.cTilde })),
    admit_proofs: proofs,
    admit_proof: admit,
    vout: [{ kind: 'send', nanos: 1 }],
  };
}

function boundAt(p) {
  const vins = new Array(p);
  const proofs = new Array(p);
  for (let i = 0; i < p; i += 1) {
    const blob = Buffer.alloc(33);
    blob[0] = 2;
    blob.writeUInt32BE(i + 1, 1);
    const tag = Buffer.from(blob.subarray(1, 33));
    const c = Buffer.alloc(32);
    c.writeUInt32BE(i + 1, 28);
    vins[i] = { commit: c };
    proofs[i] = { blob, cTilde: c, spendTag: tag };
  }
  const tx = { kind: 'send', vin: vins, admit_proofs: proofs, vout: [{ kind: 'send' }] };
  const t0 = performance.now();
  const got = flowInputsBound(tx);
  return { ms: performance.now() - t0, reason: got.reason || (got.ok ? 'ok' : 'fail') };
}

function queuePicture(store, nanos) {
  const parts = [];
  for (const n of UNDER_IN.concat(OVER_IN)) {
    resetTxSpendTagParses();
    const before = txSpendTagParses();
    const got = store.queueTx(shapedFlow(n, nanos, `in-${n}-${nanos}`));
    const parsed = txSpendTagParses() - before;
    parts.push(`${n}:${got.reason || (got.ok ? 'ok' : 'fail')}/p${parsed}/c${got.proofChecked ? 1 : 0}`);
  }
  for (const n of [1, 8, 9, 20]) {
    resetTxSpendTagParses();
    const before = txSpendTagParses();
    const got = store.queueTx(shapedOuts(n, nanos, `out-${n}-${nanos}`));
    const parsed = txSpendTagParses() - before;
    parts.push(`o${n}:${got.reason || (got.ok ? 'ok' : 'fail')}/p${parsed}/c${got.proofChecked ? 1 : 0}`);
  }
  const withdraw = store.queueTx({
    id: `wd-${nanos}`,
    kind: 'withdraw',
    nanos,
    vin: [],
    vout: [{ kind: 'withdraw', nanos }],
  });
  parts.push(`wd0:${withdraw.reason || (withdraw.ok ? 'ok' : 'fail')}/c${withdraw.proofChecked ? 1 : 0}`);
  const coinbase = store.queueTx({
    id: `cb-${nanos}`,
    coinbase: true,
    vin: [{ coinbase: true, height: 1 }],
    vout: Array.from({ length: 20 }, () => ({ kind: 'pot', nanos })),
  });
  parts.push(`cb20:${coinbase.reason || (coinbase.ok ? 'ok' : 'fail')}/c${coinbase.proofChecked ? 1 : 0}`);
  const carried = store.queueTx({
    id: `cb-carry-${nanos}`,
    coinbase: true,
    vin: [{ coinbase: true, height: 1 }],
    vout: [{ kind: 'pot', nanos }, { kind: 'finder-fee', nanos: 1 }, { kind: 'reserve-fee', nanos: 1 }],
    admit_proof: { cTilde: word(1), spendTag: word(2) },
  });
  parts.push(`carry:${carried.reason || (carried.ok ? 'ok' : 'fail')}/c${carried.proofChecked ? 1 : 0}`);
  const lock = store.queueTx({
    id: `lock-${nanos}`,
    kind: 'lock',
    nanos,
    vin: Array.from({ length: 9 }, () => ({ commit: word(1) })),
    vout: [{ kind: 'lock', nanos }],
  });
  parts.push(`lock9:${lock.reason || (lock.ok ? 'ok' : 'fail')}/c${lock.proofChecked ? 1 : 0}`);
  return parts.join(' ');
}

function admitPicture(nanos) {
  const book = emptyMempool();
  const parts = [];
  for (const n of [1, 8, 9, 64]) {
    resetTxSpendTagParses();
    const before = txSpendTagParses();
    const got = admitMempool(book, shapedFlow(n, nanos, `adm-${n}-${nanos}`), { baseFee: 1 });
    parts.push(`${n}:${got.reason || (got.ok ? 'ok' : 'fail')}/p${txSpendTagParses() - before}`);
  }
  const outs = admitMempool(book, shapedOuts(9, nanos, `adm-out-${nanos}`), { baseFee: 1 });
  parts.push(`o9:${outs.reason || (outs.ok ? 'ok' : 'fail')}`);
  const coinbase = admitMempool(book, {
    coinbase: true,
    vin: [{ coinbase: true, height: 1 }],
    vout: Array.from({ length: 24 }, () => ({ kind: 'pot', nanos })),
  }, { baseFee: 1 });
  parts.push(`cb:${coinbase.reason || (coinbase.ok ? 'ok' : 'fail')}`);
  return parts.join(' ');
}

function p99(samples) {
  const s = samples.slice().sort((a, b) => a - b);
  if (!s.length) return 0;
  const i = Math.min(s.length - 1, Math.ceil(s.length * 0.99) - 1);
  return s[Math.max(0, i)];
}

function shareOnce() {
  const t0 = performance.now();
  try {
    judgeShare({
      job: { shareBits: 8, shareBitsPrev: 0, shareBitsAt: 0, blockBits: 8 },
      hash: Buffer.alloc(32, 1),
      header: Buffer.alloc(128),
      shareBits: 8,
    });
  } catch { /* timing only */ }
  return performance.now() - t0;
}

function headersOnly(port, declared, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (code) => {
      if (settled) return;
      settled = true;
      resolve(code);
    };
    const req = http.request({
      host: '127.0.0.1',
      port,
      method: 'POST',
      path: '/api/wallet/send',
      agent: false,
      headers: {
        'content-type': 'application/json',
        'content-length': String(declared),
      },
      timeout: timeoutMs,
    }, (res) => {
      res.resume();
      done(res.statusCode);
    });
    req.on('timeout', () => {
      req.destroy();
      done(0);
    });
    req.on('error', () => done(0));
    req.flushHeaders();
  });
}

function postBytes(port, nbytes) {
  const payload = Buffer.from(JSON.stringify({
    kind: 'send',
    pad: 'x'.repeat(Math.max(0, nbytes)),
  }));
  return new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      method: 'POST',
      path: '/api/wallet/send',
      agent: false,
      headers: { 'content-type': 'application/json', 'content-length': String(payload.length) },
      timeout: 5000,
    }, (res) => {
      res.resume();
      const code = res.statusCode;
      res.on('end', () => resolve(code));
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(0);
    });
    req.on('error', () => resolve(0));
    req.end(payload);
  });
}

function postChunked(port, cap) {
  return new Promise((resolve) => {
    let status = 0;
    let sent = 0;
    let settled = false;
    const done = (row) => {
      if (settled) return;
      settled = true;
      resolve(row);
    };
    const req = http.request({
      host: '127.0.0.1',
      port,
      method: 'POST',
      path: '/api/wallet/send',
      agent: false,
      headers: { 'content-type': 'application/json' },
      timeout: 20000,
    }, (res) => {
      status = res.statusCode;
      res.resume();
      res.on('end', () => done({ status, sent }));
    });
    req.on('error', () => done({ status, sent }));
    req.on('timeout', () => {
      req.destroy();
      done({ status, sent });
    });
    const chunk = Buffer.alloc(256 * 1024, 0x61);
    const pump = () => {
      if (settled) return;
      if (sent > cap) {
        req.end();
        return;
      }
      sent += chunk.length;
      if (!req.write(chunk)) req.once('drain', pump);
      else setImmediate(pump);
    };
    pump();
  });
}

describe('v12 tx input and output cap', { concurrency: 1 }, () => {
  it('rejects any oversize tx before a proof parse, and still binds a listed proof', async () => {
    const one = versioned(9, 2);
    const copy = {
      blob: Buffer.from(one.blob),
      cTilde: Buffer.from(one.cTilde),
      spendTag: Buffer.from(one.spendTag),
    };
    assert.equal(sameSpendProof(one, copy), true);
    assert.equal(flowInputsBound(flowOf([one], copy)).ok, true);
    const other = versioned(4, 3);
    assert.equal(flowInputsBound(flowOf([one], other)).reason, 'admit_membership');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-tx-cap-'));
    const store = createStore(dir);
    try {
      const pictures = [];
      for (const nanos of AMOUNTS) {
        const q = queuePicture(store, nanos);
        const a = admitPicture(nanos);
        pictures.push(`q ${nanos} ${q} | a ${a}`);
        for (const n of OVER_IN) {
          resetTxSpendTagParses();
          const before = txSpendTagParses();
          const got = store.queueTx(shapedFlow(n, nanos, `cap-${n}-${nanos}`));
          assert.equal(got.reason, 'tx_cap', `${nanos} in ${n} ${q}`);
          assert.equal(txSpendTagParses(), before, `${nanos} in ${n} parsed`);
          assert.equal(got.proofChecked, true, `${nanos} in ${n} score`);
          const outs = store.queueTx(shapedOuts(n === 9 ? 9 : 20, nanos, `cap-out-${n}-${nanos}`));
          assert.equal(outs.reason, 'tx_cap', `${nanos} out ${outs.reason}`);
          assert.equal(outs.proofChecked, true);
        }
        for (const n of UNDER_IN) {
          const got = store.queueTx(shapedFlow(n, nanos, `under-${n}-${nanos}-b`));
          assert.notEqual(got.reason, 'tx_cap', `${nanos} under ${n} ${got.reason}`);
          assert.notEqual(got.proofChecked, true, `${nanos} under ${n}`);
        }
        const withdraw = store.queueTx({
          id: `wd-ok-${nanos}`,
          kind: 'withdraw',
          nanos,
          vin: [],
          vout: [{ kind: 'withdraw', nanos }],
        });
        assert.notEqual(withdraw.reason, 'tx_cap', `withdraw ${withdraw.reason}`);
        const cb = store.queueTx({
          id: `cb-ok-${nanos}`,
          coinbase: true,
          vin: [{ coinbase: true, height: 1 }],
          vout: Array.from({ length: 20 }, (_, i) => ({ kind: i % 5 === 0 ? 'pot' : 'hash', nanos })),
        });
        assert.notEqual(cb.reason, 'tx_cap', `coinbase ${cb.reason}`);
        assert.notEqual(cb.proofChecked, true);
        const carried = store.queueTx({
          id: `cb-carry-ok-${nanos}`,
          coinbase: true,
          vin: [{ coinbase: true, height: 1 }],
          vout: [{ kind: 'pot', nanos }],
          admit_proof: { cTilde: word(5), spendTag: word(6) },
          admit_proofs: [{ cTilde: word(5), spendTag: word(6) }, { cTilde: word(7), spendTag: word(8) }],
        });
        assert.equal(carried.reason, 'admit_membership', `carry ${carried.reason}`);
        const admitted = admitMempool(emptyMempool(), shapedFlow(9, nanos, `adm-cap-${nanos}`), { baseFee: 1 });
        assert.equal(admitted.reason, 'tx_cap', `admit ${admitted.reason} ${a}`);
        const admittedOut = admitMempool(emptyMempool(), shapedOuts(9, nanos, `adm-out-cap-${nanos}`), { baseFee: 1 });
        assert.equal(admittedOut.reason, 'tx_cap', `admit out ${admittedOut.reason}`);
        const admittedCb = admitMempool(emptyMempool(), {
          coinbase: true,
          vin: [{ coinbase: true, height: 1 }],
          vout: Array.from({ length: 24 }, () => ({ kind: 'pot', nanos })),
        }, { baseFee: 1 });
        assert.notEqual(admittedCb.reason, 'tx_cap', `admit coinbase ${admittedCb.reason}`);
      }
      console.log(pictures.join('\n'));

      const dest = minerDest();
      const t0 = 1_700_000_000_000;
      const tpl = store.template({ miner: dest, shareBits: 4, now: t0 }).tpl;
      const over = shapedFlow(9, AMOUNTS[0], 'block-9');
      const txs = tpl.txs.concat([over]);
      const decoded = decodeHeader(Buffer.from(tpl.header));
      decoded.merkleRoot = merkleRoot(txs.map(digestTx));
      resetTxSpendTagParses();
      const before = txSpendTagParses();
      let blockGot = verifyBlock({
        header: encodeHeader(decoded),
        txs,
        samples: tpl.samples,
        shareBatch: [],
        miner: dest,
        aLeaves: tpl.aLeaves,
        bLeaves: tpl.bLeaves,
        rootA: tpl.rootA,
        rootB: tpl.rootB,
      }, null, {
        trustedPowHash: easyPowHash(),
        skipSharePow: true,
        nowMs: t0,
        genesisMs: t0,
      });
      if (blockGot && typeof blockGot.then === 'function') blockGot = await blockGot;
      assert.equal(blockGot.reason, 'tx_cap', `block ${blockGot.reason}`);
      assert.equal(txSpendTagParses(), before, 'block parsed a proof');

      const fatCb = {
        ...tpl.txs[0],
        vout: tpl.txs[0].vout.concat(Array.from({ length: 16 }, () => ({ kind: 'hash', nanos: 1 }))),
      };
      const cbTxs = [fatCb];
      const decodedCb = decodeHeader(Buffer.from(tpl.header));
      decodedCb.merkleRoot = merkleRoot(cbTxs.map(digestTx));
      let cbGot = verifyBlock({
        header: encodeHeader(decodedCb),
        txs: cbTxs,
        samples: tpl.samples,
        shareBatch: [],
        miner: dest,
        aLeaves: tpl.aLeaves,
        bLeaves: tpl.bLeaves,
        rootA: tpl.rootA,
        rootB: tpl.rootB,
      }, null, {
        trustedPowHash: easyPowHash(),
        skipSharePow: true,
        nowMs: t0,
        genesisMs: t0,
      });
      if (cbGot && typeof cbGot.then === 'function') cbGot = await cbGot;
      assert.notEqual(cbGot.reason, 'tx_cap', `coinbase block ${cbGot.reason} outs ${fatCb.vout.length}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('bounds a frame of proofs in under 50 ms at the cap and at frame size', () => {
    const small = boundAt(8);
    console.log(`flowInputsBound P=8 ${small.ms.toFixed(3)} ms ${small.reason}`);
    assert.ok(small.ms < 50, `P=8 ${small.ms.toFixed(3)} ms`);
    assert.equal(small.reason, 'ok');
    const mid = boundAt(1024);
    console.log(`flowInputsBound P=1024 ${mid.ms.toFixed(3)} ms ${mid.reason}`);
    assert.ok(mid.ms < 50, `P=1024 ${mid.ms.toFixed(3)} ms ${mid.reason}`);
    // The first frame-sized call also compiles the loop. Time the next call.
    // A quadratic scan stays slow on that next call; the old one was hundreds of ms.
    const compiled = boundAt(FRAME_P);
    const frame = boundAt(FRAME_P);
    console.log(`flowInputsBound frame P=${FRAME_P} compile ${compiled.ms.toFixed(3)} ms steady ${frame.ms.toFixed(3)} ms ${frame.reason}`);
    assert.equal(compiled.reason, 'ok');
    assert.ok(compiled.ms < 400, `frame compile P=${FRAME_P} ${compiled.ms.toFixed(3)} ms`);
    assert.ok(frame.ms < 50, `frame P=${FRAME_P} ${frame.ms.toFixed(3)} ms ${frame.reason}`);
    assert.equal(frame.reason, 'ok');
  });

  it('scores a replayed oversize tx on the p2p ingest path', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-tx-cap-p2p-'));
    const store = createStore(dir);
    const net = createP2p({ store, port: 0, host: '127.0.0.1' });
    try {
      assert.equal(typeof net.ingestRemoteTx, 'function');
      const sock = {
        remoteAddress: '203.0.113.9',
        destroyed: false,
        destroy() { this.destroyed = true; },
        write() {},
      };
      const rec = { expensiveFails: 0, remote: '203.0.113.9' };
      net.peers.set(sock, rec);
      const tx = shapedFlow(9, AMOUNTS[1], 'replay-oversize');
      net.ingestRemoteTx(tx, sock);
      const once = rec.expensiveFails;
      net.ingestRemoteTx(tx, sock);
      assert.ok(once >= 1, `first score ${once}`);
      assert.ok(rec.expensiveFails > once, `replay ${once} -> ${rec.expensiveFails}`);
      const fresh = {
        remoteAddress: '203.0.113.10',
        destroyed: false,
        destroy() { this.destroyed = true; },
        write() {},
      };
      const ban = { expensiveFails: 0, remote: '203.0.113.10' };
      net.peers.set(fresh, ban);
      for (let i = 0; i < P2P_FAIL_DISCONNECT; i += 1) {
        net.ingestRemoteTx(shapedFlow(9, 1, `ban-${i}`), fresh);
      }
      assert.equal(fresh.destroyed, true, `fails ${ban.expensiveFails}`);
      const honestSock = {
        remoteAddress: '203.0.113.11',
        destroyed: false,
        destroy() { this.destroyed = true; },
        write() {},
      };
      const honest = { expensiveFails: 0, remote: '203.0.113.11' };
      net.peers.set(honestSock, honest);
      net.ingestRemoteTx(shapedFlow(1, 1, 'honest-under'), honestSock);
      assert.equal(honest.expensiveFails, 0);
      assert.equal(honestSock.destroyed, false);
    } finally {
      try { net.close(); } catch { /* ignore */ }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('caps a wallet POST before the body is read and leaves share calls responsive', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-tx-cap-http-'));
    const pool = createPool({ dataDir: dir, stratumPort: 0, httpPort: 0 });
    const port = await new Promise((resolve, reject) => {
      pool.stratum.listen(0, '127.0.0.1', () => {
        pool.httpServer.listen(0, '127.0.0.1', () => resolve(pool.httpServer.address().port));
      });
      pool.stratum.on('error', reject);
      pool.httpServer.on('error', reject);
    });
    const gaps = [];
    let last = performance.now();
    let stop = false;
    const pulse = () => {
      const now = performance.now();
      gaps.push(now - last);
      last = now;
      shareOnce();
      if (!stop) setImmediate(pulse);
    };
    try {
      for (const n of [1024, 4096, 64 * 1024]) {
        const code = await postBytes(port, n);
        assert.notEqual(code, 413, `small ${n} -> ${code}`);
        assert.notEqual(code, 0, `small ${n} hung`);
      }
      const atCap = await headersOnly(port, P2P_MAX_FRAME_DEFAULT, 250);
      assert.notEqual(atCap, 413, `exact frame declared ${atCap}`);
      const chunked = await postChunked(port, P2P_MAX_FRAME_DEFAULT);
      last = performance.now();
      gaps.length = 0;
      pulse();
      const posts = [];
      for (let i = 0; i < 100; i += 1) {
        posts.push(headersOnly(port, 64 * 1024 * 1024, 800));
      }
      const codes = await Promise.all(posts);
      stop = true;
      const shareP99 = p99(gaps);
      console.log(`chunked status ${chunked.status} sent ${chunked.sent} | oversize ${codes[0]} n ${codes.length} shareP99 ${shareP99.toFixed(3)} gaps ${gaps.length}`);
      assert.equal(chunked.status, 413, `chunked ${chunked.status} sent ${chunked.sent}`);
      assert.ok(chunked.sent < P2P_MAX_FRAME_DEFAULT + (2 * 1024 * 1024), `chunked buffered ${chunked.sent}`);
      assert.ok(codes.every((c) => c === 413), `oversize ${codes[0]}`);
      assert.ok(shareP99 < 100, `share p99 ${shareP99.toFixed(3)} ms`);
    } finally {
      stop = true;
      try { pool.close(); } catch { /* ignore */ }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
