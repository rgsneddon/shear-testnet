/**
 * Weight-table caps. Any count above the cap, any of the listed amounts.
 * The gate is the shipped queue, mempool, template, and verifyBlock path.
 * A reject is the cap reason before a proof parse. FRAME_MIN stays above
 * today's frames and is not raised here.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createStore } from '../src/store.js';
import { verifyBlock, digestTx } from '../src/chain.js';
import { decodeHeader, encodeHeader } from '../../crypto/header.js';
import { merkleRoot } from '../../crypto/merkle.js';
import { admitMempool, emptyMempool } from '../../crypto/mempool.js';
import { newIdentity } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { txSpendTagParses, resetTxSpendTagParses } from '../../crypto/note.js';
import { resetTypedProofVerifies, typedProofVerifyCount } from '../../crypto/admit_v3.js';
import { P2P_MAX_FRAME_DEFAULT } from '../src/p2p.js';
import { IPC_MAX_FRAME } from '../src/p2p_ipc.js';
import {
  B_MAX,
  C_MAX,
  COINBASE_EXTRA_NOTES,
  FALLBACK_IPC_FRAME,
  FRAME_MIN,
  K_VW,
  MAX_BLOCK_RESERVE_TXS,
  MAX_BLOCK_VERIFY_WEIGHT,
  PAYEE_ROW_BYTES,
  R_BYTES,
  R_VW_BYTES,
  R_VW_WEIGHT,
  R_WEIGHT,
  TEMPLATE_BUDGET_MS,
  VW_KIND,
  W_PAYEE,
  blockBudget,
  blockVerifyWeight,
  payeeCapFallback,
  payeeCapLive,
  payeeCapNormal,
  publicBytes,
  selectBodyIndexes,
  txVerifyWeight,
} from '../../crypto/block_budget.js';

const AMOUNTS = [1, 100_000_000_000];
const RESERVE_COUNTS = [0, 1, 32, 33];
const VW_COUNTS = [0, 1, 8, 9];

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

function outs(n, kind, nanos) {
  const rows = new Array(n);
  for (let i = 0; i < n; i += 1) rows[i] = { kind, nanos };
  return rows;
}

function bodyTx(nIn, nOut, id, nanos) {
  const vin = new Array(nIn);
  const vout = new Array(nOut);
  for (let i = 0; i < nIn; i += 1) vin[i] = {};
  for (let i = 0; i < nOut; i += 1) vout[i] = { kind: 'send', nanos };
  return { id, kind: 'send', fee: 1, nanos, vin, vout };
}

function reserveTx(i, kind, nanos, portal) {
  const tx = {
    id: `${kind}-${i}-${nanos}`,
    kind,
    nanos,
    fee: 1 + (i % 7),
    portalId: portal,
    payoutPortalId: portal,
    vout: [{ kind, nanos }],
  };
  if (kind !== 'withdraw') tx.vin = [{}];
  else tx.vin = [];
  return tx;
}

function fillWeight(target, nanos) {
  const cb = { coinbase: true, height: 1, vin: [{ coinbase: true, height: 1 }], vout: [] };
  const body = [];
  const menu = [];
  for (let nIn = 8; nIn >= 0; nIn -= 1) {
    for (let nOut = 8; nOut >= 0; nOut -= 1) menu.push([nIn, nOut]);
  }
  menu.sort((a, b) => txVerifyWeight(bodyTx(b[0], b[1], 'm', nanos)) - txVerifyWeight(bodyTx(a[0], a[1], 'm', nanos)));
  let guard = 0;
  while (blockVerifyWeight([cb, ...body]) < target && guard < 100000) {
    guard += 1;
    let placed = false;
    for (let m = 0; m < menu.length; m += 1) {
      const [nIn, nOut] = menu[m];
      const tx = bodyTx(nIn, nOut, `w-${body.length}-${nanos}`, nanos);
      if (blockVerifyWeight([cb, ...body, tx]) <= target) {
        body.push(tx);
        placed = true;
        break;
      }
    }
    if (!placed) break;
  }
  while (blockVerifyWeight([cb, ...body]) < target && cb.vout.length < K_VW) {
    cb.vout.push({ kind: VW_KIND, nanos });
  }
  return { cb, body, weight: blockVerifyWeight([cb, ...body]) };
}

async function blockResult(store, txs, t0) {
  const tpl = store.template({ miner: minerDest(), shareBits: 4, now: t0 }).tpl;
  const decoded = decodeHeader(Buffer.from(tpl.header));
  decoded.merkleRoot = merkleRoot(txs.map(digestTx));
  resetTxSpendTagParses();
  resetTypedProofVerifies();
  const tags = txSpendTagParses();
  const proofs = typedProofVerifyCount();
  const started = performance.now();
  let got = verifyBlock({
    header: encodeHeader(decoded),
    txs,
    samples: tpl.samples,
    shareBatch: [],
    miner: tpl.miner,
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
  if (got && typeof got.then === 'function') got = await got;
  return {
    got,
    ms: performance.now() - started,
    parsed: txSpendTagParses() - tags,
    proofs: typedProofVerifyCount() - proofs,
  };
}

describe('v12 block budget', { concurrency: 1 }, () => {
  it('rejects a block over the signed caps before a proof, and keeps a block at the cap', async () => {
    assert.equal(C_MAX + R_BYTES + R_VW_BYTES, B_MAX);
    assert.equal(MAX_BLOCK_VERIFY_WEIGHT - R_WEIGHT - R_VW_WEIGHT, 33_056);
    const normal = payeeCapNormal();
    const fallback = payeeCapFallback();
    const live = payeeCapLive();
    assert.equal(normal, Math.floor(C_MAX / PAYEE_ROW_BYTES));
    assert.equal(fallback, live);
    assert.ok(live >= 1);
    assert.ok(W_PAYEE * (live + COINBASE_EXTRA_NOTES) + R_WEIGHT + R_VW_WEIGHT <= MAX_BLOCK_VERIFY_WEIGHT);
    assert.ok(W_PAYEE * (normal + COINBASE_EXTRA_NOTES) + R_WEIGHT + R_VW_WEIGHT <= MAX_BLOCK_VERIFY_WEIGHT);
    assert.ok(P2P_MAX_FRAME_DEFAULT < FRAME_MIN, `p2p ${P2P_MAX_FRAME_DEFAULT}`);
    assert.ok(IPC_MAX_FRAME < FRAME_MIN, `ipc ${IPC_MAX_FRAME}`);
    assert.equal(IPC_MAX_FRAME, FALLBACK_IPC_FRAME);
    assert.equal(TEMPLATE_BUDGET_MS, 1_000);
    assert.equal(MAX_BLOCK_RESERVE_TXS, 32);
    assert.equal(K_VW, 8);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-block-budget-'));
    const store = createStore(dir);
    const t0 = 1_700_000_000_000;
    const portal = 'same-portal';
    try {
      for (const nanos of AMOUNTS) {
        const at = fillWeight(MAX_BLOCK_VERIFY_WEIGHT, nanos);
        const over = fillWeight(MAX_BLOCK_VERIFY_WEIGHT + 1, nanos);
        assert.equal(at.weight, MAX_BLOCK_VERIFY_WEIGHT, `weight at ${at.weight}`);
        assert.equal(over.weight, MAX_BLOCK_VERIFY_WEIGHT + 1, `weight over ${over.weight}`);
        const atBlock = await blockResult(store, [at.cb, ...at.body], t0);
        const overBlock = await blockResult(store, [over.cb, ...over.body], t0);
        console.log(`weight ${nanos} at ${atBlock.got.reason} ${atBlock.ms.toFixed(1)} ms over ${overBlock.got.reason} ${overBlock.ms.toFixed(1)} ms parsed ${overBlock.parsed} proofs ${overBlock.proofs}`);
        assert.notEqual(atBlock.got.reason, 'block_weight', `at ${atBlock.got.reason}`);
        assert.equal(overBlock.got.reason, 'block_weight');
        assert.equal(overBlock.parsed, 0);
        assert.equal(overBlock.proofs, 0);
        assert.equal(overBlock.got.proofChecked, false);
        assert.ok(overBlock.ms < 50, `weight reject ${overBlock.ms.toFixed(1)} ms`);

        const cap = live;
        const underCounts = [0, 1, cap - 1, cap];
        const overCounts = [cap + 1, cap + 2];
        for (const n of underCounts) {
          const cb = {
            coinbase: true,
            height: 1,
            vin: [{ coinbase: true, height: 1 }],
            vout: outs(n, 'pot', nanos),
          };
          const got = await blockResult(store, [cb], t0);
          console.log(`payee ${nanos} ${n} ${got.got.reason}`);
          assert.notEqual(got.got.reason, 'payee_cap', `payee ${n} ${got.got.reason}`);
        }
        for (const n of overCounts) {
          const cb = {
            coinbase: true,
            height: 1,
            vin: [{ coinbase: true, height: 1 }],
            vout: outs(n, 'hash', nanos),
          };
          resetTxSpendTagParses();
          const before = txSpendTagParses();
          const queued = store.queueTx(cb);
          const admitted = admitMempool(emptyMempool(), cb, { baseFee: 1 });
          const got = await blockResult(store, [cb], t0);
          console.log(`payee over ${nanos} ${n} q ${queued.reason} a ${admitted.reason} b ${got.got.reason} parsed ${txSpendTagParses() - before}`);
          assert.equal(queued.reason, 'payee_cap');
          assert.equal(admitted.reason, 'payee_cap');
          assert.equal(got.got.reason, 'payee_cap');
          assert.equal(got.parsed, 0);
          assert.equal(queued.proofChecked, false);
        }

        for (const n of VW_COUNTS) {
          const cb = {
            coinbase: true,
            height: 1,
            vin: [{ coinbase: true, height: 1 }],
            vout: outs(n, VW_KIND, nanos),
          };
          const got = await blockResult(store, [cb], t0);
          console.log(`vw ${nanos} ${n} ${got.got.reason} parsed ${got.parsed}`);
          if (n > K_VW) {
            assert.equal(got.got.reason, 'k_vw');
            assert.equal(got.parsed, 0);
            assert.equal(got.proofs, 0);
            const queued = store.queueTx(cb);
            const admitted = admitMempool(emptyMempool(), cb, { baseFee: 1 });
            assert.equal(queued.reason, 'k_vw');
            assert.equal(admitted.reason, 'k_vw');
          } else {
            assert.notEqual(got.got.reason, 'k_vw', `vw ${n} ${got.got.reason}`);
          }
        }

        for (const n of RESERVE_COUNTS) {
          const cb = {
            coinbase: true,
            height: 1,
            vin: [{ coinbase: true, height: 1 }],
            vout: [{ kind: 'pot', nanos }],
          };
          const body = [];
          for (let i = 0; i < n; i += 1) {
            body.push(reserveTx(i, i % 2 === 0 ? 'lock' : 'withdraw', nanos, portal));
          }
          const got = await blockResult(store, [cb, ...body], t0);
          console.log(`reserve ${nanos} ${n} ${got.got.reason} parsed ${got.parsed}`);
          if (n > MAX_BLOCK_RESERVE_TXS) {
            assert.equal(got.got.reason, 'reserve_txs');
            assert.equal(got.parsed, 0);
            assert.equal(got.proofs, 0);
            assert.ok(got.ms < 50, `reserve reject ${got.ms.toFixed(1)} ms`);
          } else {
            assert.notEqual(got.got.reason, 'reserve_txs', `reserve ${n} ${got.got.reason}`);
          }
        }

        const bare = {
          coinbase: true,
          height: 1,
          vin: [{ coinbase: true, height: 1 }],
          vout: [{ kind: 'pot', nanos }],
        };
        const cbNeed = C_MAX - publicBytes(bare);
        assert.ok(cbNeed > 0, `coinbase already ${publicBytes(bare)}`);
        const atCb = { ...bare, pad: 'a'.repeat(cbNeed) };
        assert.equal(publicBytes(atCb), C_MAX);
        const overCb = { ...bare, pad: 'a'.repeat(cbNeed + 1) };
        const atCbGot = await blockResult(store, [atCb], t0);
        const overCbGot = await blockResult(store, [overCb], t0);
        console.log(`coinbase bytes ${nanos} at ${atCbGot.got.reason} ${atCbGot.ms.toFixed(1)} ms over ${overCbGot.got.reason} ${overCbGot.ms.toFixed(1)} ms`);
        assert.notEqual(atCbGot.got.reason, 'coinbase_bytes', `C_MAX ${atCbGot.got.reason}`);
        assert.equal(overCbGot.got.reason, 'coinbase_bytes');
        assert.equal(overCbGot.parsed, 0);
        assert.ok(overCbGot.ms < 50, `coinbase bytes ${overCbGot.ms.toFixed(1)} ms`);
        const queuedCb = store.queueTx(overCb);
        const admittedCb = admitMempool(emptyMempool(), overCb, { baseFee: 1 });
        assert.equal(queuedCb.reason, 'coinbase_bytes');
        assert.equal(admittedCb.reason, 'coinbase_bytes');

        const host = bodyTx(1, 1, `bytes-${nanos}`, nanos);
        const used = publicBytes(bare) + publicBytes(host);
        const blockNeed = B_MAX - used;
        assert.ok(blockNeed > 0, `block already ${used}`);
        const atBody = { ...host, pad: 'a'.repeat(blockNeed) };
        const overBody = { ...host, pad: 'a'.repeat(blockNeed + 1) };
        assert.equal(publicBytes(bare) + publicBytes(atBody), B_MAX);
        const atBytes = await blockResult(store, [bare, atBody], t0);
        const overBytes = await blockResult(store, [bare, overBody], t0);
        console.log(`block bytes ${nanos} at ${atBytes.got.reason} ${atBytes.ms.toFixed(1)} ms over ${overBytes.got.reason} ${overBytes.ms.toFixed(1)} ms`);
        assert.notEqual(atBytes.got.reason, 'block_bytes', `B_MAX ${atBytes.got.reason}`);
        assert.notEqual(atBytes.got.reason, 'coinbase_bytes', `B_MAX coinbase ${atBytes.got.reason}`);
        assert.equal(overBytes.got.reason, 'block_bytes');
        assert.equal(overBytes.parsed, 0);
        assert.ok(overBytes.ms < 50, `block bytes ${overBytes.ms.toFixed(1)} ms`);
        const fatNeed = B_MAX - publicBytes(host) + 1;
        const fatBody = { ...host, pad: 'a'.repeat(fatNeed) };
        assert.ok(publicBytes(fatBody) > B_MAX);
        const queuedBody = store.queueTx(fatBody);
        const admittedBody = admitMempool(emptyMempool(), fatBody, { baseFee: 1 });
        assert.equal(queuedBody.reason, 'block_bytes');
        assert.equal(admittedBody.reason, 'block_bytes');
        fatBody.pad = '';
        atCb.pad = '';
        overCb.pad = '';
        atBody.pad = '';
        overBody.pad = '';
      }

      const queuedTimes = [];
      let queuedKept = 0;
      const sample = reserveTx(0, 'lock', AMOUNTS[0], portal);
      store.queueTx(sample);
      for (let i = 0; i < 1000; i += 1) {
        const tx = reserveTx(i, i % 2 === 0 ? 'lock' : 'withdraw', AMOUNTS[i % AMOUNTS.length], portal);
        const started = performance.now();
        const got = store.queueTx(tx);
        queuedTimes.push(performance.now() - started);
        if (got.ok) queuedKept += 1;
      }
      queuedTimes.sort((a, b) => a - b);
      const slowest = queuedTimes[queuedTimes.length - 1];
      console.log(`queue 1000 kept ${queuedKept} slowest ${slowest.toFixed(3)} ms p50 ${queuedTimes[500].toFixed(3)} ms`);
      assert.ok(slowest < 50, `queue arrival ${slowest.toFixed(3)} ms`);

      if (queuedKept < 1000) {
        store.mempool.length = 0;
        for (let i = 0; i < 1000; i += 1) {
          store.mempool.push(reserveTx(i, 'lock', AMOUNTS[i % AMOUNTS.length], portal));
        }
      }
      const picks = selectBodyIndexes(store.mempool);
      assert.equal(picks.length, MAX_BLOCK_RESERVE_TXS);
      const pickedFee = picks.map((i) => store.mempool[i].fee);
      const topFee = store.mempool.reduce((m, tx) => Math.max(m, tx.fee), 0);
      assert.ok(pickedFee.every((fee) => fee === topFee), `picked ${pickedFee.join(',')}`);
      const lateReserve = reserveTx(0, 'lock', AMOUNTS[0], portal);
      lateReserve.fee = 9;
      const lateSend = bodyTx(1, 1, 'send-late', AMOUNTS[0]);
      lateSend.fee = 1;
      let clock = 0;
      const late = selectBodyIndexes([lateReserve, lateSend], {
        nowMs: () => {
          const stamp = clock;
          clock = TEMPLATE_BUDGET_MS;
          return stamp;
        },
      });
      assert.deepEqual(late, [1]);
      const beforeHeight = Number(store.tip()?.height || 0);
      const beforeLen = store.mempool.length;
      const started = performance.now();
      const tpl = store.template({ miner: minerDest(), shareBits: 4, now: t0 });
      const tplMs = performance.now() - started;
      const reserved = (tpl.tpl.txs || []).filter((tx) => tx && !tx.coinbase && (tx.kind === 'lock' || tx.kind === 'withdraw' || tx.kind === 'vote'));
      console.log(`template 1000 ${tplMs.toFixed(1)} ms reserved ${reserved.length} mempool ${store.mempool.length} tip ${store.tip()?.height}`);
      assert.ok(tplMs <= TEMPLATE_BUDGET_MS, `template ${tplMs.toFixed(1)} ms`);
      assert.ok(reserved.length <= MAX_BLOCK_RESERVE_TXS, `template reserved ${reserved.length}`);
      assert.equal(Number(store.tip()?.height || 0), beforeHeight);
      assert.ok(store.mempool.length >= beforeLen);
      assert.equal(blockBudget([tpl.tpl.txs[0], ...reserved]).ok, true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
