import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  BLOCK_SUBSIDY_NANOS,
  POOL_FEE_BPS,
  SHARE_FLOOR_BITS,
  shareCreditMaxBits,
} from '../../crypto/asert.js';
import { hash20FromAddress, newIdentity } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { poolWithdrawTx } from '../../crypto/levy.js';
import { noteCommitOfDest20, openedCoinbaseNanos } from '../../crypto/note.js';
import { nonceWithShareTarget } from '../../crypto/share_batch.js';
import { signSpendTx } from '../../crypto/spend.js';
import { admitMempool, emptyMempool } from '../../crypto/mempool.js';
import { potSharesFromBatch } from '../../node/src/chain.js';
import { AUTO_PAYOUT_MIN_NANOS, buildAutoPayoutTx, buildPoolFeeSweepTx } from '../src/auto_payout.js';
import { configuredFeeIdentity, createPool, publicMinerTag } from '../src/pool.js';
import { spendBox } from '../../tests/spend_box.js';

const FEE = configuredFeeIdentity().feeDest;

function minerDest() {
  const id = newIdentity();
  return destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
}

let powTag = 8000;
function nextPow() {
  powTag += 1;
  const h = Buffer.alloc(32);
  h.writeUInt32LE(powTag >>> 0, 4);
  return h.toString('hex');
}

function credit(pool, dest, header, bits, low) {
  const nonce = nonceWithShareTarget(BigInt(low), bits);
  const got = pool.creditAcceptedShare({
    dest,
    nonce,
    lz: bits,
    shareBits: bits,
    creditedShareBits: bits,
    verifiedHeader: header,
    hash: '11',
  });
  assert.equal(got.ok, true, got.reason || 'credit');
  return String(nonce);
}

async function seal(pool) {
  const got = await pool.sealFoundShare({
    jobId: pool.lastJob.jobId,
    nonce: 0n,
    miner: FEE,
    powHash: nextPow(),
  });
  assert.equal(got.ok, true, got.reason || 'seal');
}

function ncHex(nc) {
  return Buffer.from(nc).toString('hex');
}

function openedByKind(vouts) {
  const by = new Map();
  for (const o of vouts || []) {
    const v = openedCoinbaseNanos(o);
    assert.equal(typeof v, 'number', `output opens (${o.kind})`);
    assert.ok(v >= 0, o.kind);
    const key = `${o.kind}:${ncHex(o.noteCommit)}`;
    by.set(key, (by.get(key) || 0) + v);
  }
  return by;
}

function destNc(dest) {
  return ncHex(noteCommitOfDest20(hash20FromAddress(dest)));
}

function bitsFor(i, n) {
  if (n === 1) return SHARE_FLOOR_BITS;
  if (i === 1) return Math.min(shareCreditMaxBits(), SHARE_FLOOR_BITS + 8);
  return SHARE_FLOOR_BITS + (i % 3);
}

describe('v12 custodial pull stays off while coinbase still pays', () => {
  it('builders and the sweep return before poolWithdrawTx, and queueTx refuses plaintext', () => {
    const auto = fs.readFileSync(new URL('../src/auto_payout.js', import.meta.url), 'utf8');
    for (const name of ['buildAutoPayoutTx', 'buildPoolFeeSweepTx']) {
      const at = auto.indexOf(`export function ${name}`);
      const next = auto.indexOf('\nexport function ', at + 10);
      const body = auto.slice(at, next > at ? next : auto.length);
      const gate = body.indexOf("if (!custodialPullAllowed()) return { ok: false, reason: 'custodial_pull' };");
      const call = body.indexOf('poolWithdrawTx(');
      assert.ok(gate >= 0 && call > gate, name);
    }
    const poolSrc = fs.readFileSync(new URL('../src/pool.js', import.meta.url), 'utf8');
    const sweepAt = poolSrc.indexOf('async function sweepAutoPayouts');
    const sweepEnd = poolSrc.indexOf('function queueSend', sweepAt);
    const sweep = poolSrc.slice(sweepAt, sweepEnd);
    const sweepGate = sweep.indexOf('if (!custodialPullAllowed()) return [];');
    const sweepBuild = sweep.indexOf('buildAutoPayoutTx');
    assert.ok(sweepGate >= 0 && sweepGate < sweepBuild);
    const sendAt = poolSrc.indexOf('function queueSend');
    const send = poolSrc.slice(sendAt, sendAt + 900);
    const sendGate = send.indexOf("reason: 'custodial_pull'");
    assert.ok(sendGate >= 0);
    assert.ok(sendGate < send.indexOf('store.queueTx'));
    assert.ok(sendGate < send.indexOf('mempool.push'));
    const storeSrc = fs.readFileSync(new URL('../../node/src/store.js', import.meta.url), 'utf8');
    const qAt = storeSrc.indexOf('function queueTx');
    const q = storeSrc.slice(qAt, qAt + 1600);
    const qGate = q.indexOf("reason: 'custodial_pull'");
    assert.ok(qGate >= 0 && qGate < q.indexOf('verifyPoolWithdrawBound'));
    const api = fs.readFileSync(new URL('../src/wallet_api.js', import.meta.url), 'utf8');
    const live = api.indexOf("if (path === '/api/pool/withdraw' && verb === 'POST')");
    const dead = api.indexOf("if (false && path === '/api/pool/withdraw'");
    assert.ok(live >= 0 && dead > live);
    const liveBody = api.slice(live, dead);
    assert.match(liveBody, /status: 410/);
    assert.doesNotMatch(liveBody, /poolWithdrawTx/);

    const box = spendBox(newIdentity());
    const to = minerDest();
    assert.equal(buildAutoPayoutTx({
      from: box.dest, to, nanos: AUTO_PAYOUT_MIN_NANOS, fee: 1, spendKey: box.key,
    }).reason, 'custodial_pull');
    assert.equal(buildPoolFeeSweepTx({
      from: box.dest, to, nanos: AUTO_PAYOUT_MIN_NANOS, fee: 1, spendKey: box.key,
    }).reason, 'custodial_pull');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-pull-qtx-'));
    const pool = createPool({ dataDir: dir, stratumPort: 0, httpPort: 0, miner: FEE });
    try {
      const signed = poolWithdrawTx({
        from: box.dest, to, nanos: 1, fee: 0, id: 'plain-any',
      });
      signSpendTx(signed, box.key);
      const queued = pool.store.queueTx(signed);
      assert.equal(queued.ok, false);
      assert.equal(queued.reason, 'custodial_pull');
      const bare = {
        id: 'no-range-any',
        kind: 'send',
        from: box.dest,
        to,
        vin: [{ address: box.dest }],
        vout: [{ address: to, nanos: 1, kind: 'send' }],
      };
      signSpendTx(bare, box.key);
      assert.equal(admitMempool(emptyMempool(), bare).reason, 'range_proof');
      assert.equal(pool.store.queueTx(bare).reason, 'admit_membership');
      const ids = (pool.store.template({ miner: FEE, now: 1_700_000_000_000 }).txs || []).map((t) => t.id);
      assert.equal(ids.includes('plain-any'), false);
      assert.equal(ids.includes('no-range-any'), false);
    } finally {
      pool.close();
    }
  });

  it('1, 3 and 17 miners keep pro-rata coinbase notes and an empty pull book', { timeout: 600_000 }, async () => {
    assert.equal(configuredFeeIdentity().ok, true);
    const amounts = [1, AUTO_PAYOUT_MIN_NANOS - 1, AUTO_PAYOUT_MIN_NANOS, AUTO_PAYOUT_MIN_NANOS * 4];
    for (const n of [1, 3, 17]) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), `shear-pull-n${n}-`));
      const pool = createPool({ dataDir: dir, stratumPort: 0, httpPort: 0, miner: FEE });
      try {
        const dests = [];
        for (let i = 0; i < n; i += 1) dests.push(minerDest());
        const rows = dests.map((dest) => ({ tag: publicMinerTag(dest), dest, count: 1 }));
        for (const nanos of amounts) {
          const credited = pool.pullBook.creditRound(rows, {
            height: 1,
            nanos,
            hashByDest: new Map(dests.map((dest, i) => [dest, i + 1])),
          });
          assert.equal(credited.ok, false, `n=${n} nanos=${nanos}`);
          assert.equal(credited.reason, 'custodial_pull');
        }
        for (const dest of dests) {
          const view = pool.pullBook.view(publicMinerTag(dest), { tipHeight: 80, need: 1 });
          assert.equal(view.pendingNanos, 0);
          assert.equal(view.confirmedNanos, 0);
          assert.equal(view.sentNanos, 0);
          assert.equal(pool.pullBook.ledger(publicMinerTag(dest)).length, 0);
        }
        assert.equal(pool.pullBook.dueAuto({ tipHeight: 80, need: 1 }).length, 0);

        let calls = 0;
        const orig = pool.store.queueTx.bind(pool.store);
        pool.store.queueTx = (tx, opts) => {
          calls += 1;
          return orig(tx, opts);
        };
        let low = 10;
        for (let round = 0; round < 2; round += 1) {
          const openJob = pool.issueJob(undefined, { force: true });
          assert.ok(openJob?.jobId, `n=${n} open job`);
          const parentHdr = Buffer.from(openJob.header, 'hex');
          for (let i = 0; i < dests.length; i += 1) {
            credit(pool, dests[i], parentHdr, bitsFor(i, n), low);
            low += 1;
            if (i === 0 && n > 1) {
              credit(pool, dests[0], parentHdr, SHARE_FLOOR_BITS, low);
              low += 1;
            }
          }
          await seal(pool);
          pool.rollOpenRound();
          const payJob = pool.issueJob(undefined, { force: true });
          assert.ok(payJob?.jobId, `n=${n} pay job`);
          const batch = pool.store.jobs.get(String(payJob.jobId))?.tpl?.shareBatch || [];
          assert.ok(batch.length > 0, `n=${n} round ${round} empty shareBatch`);
          const carry = Math.max(0, Math.floor(Number(pool.store.tip()?.txs?.[0]?.carryNanos) || 0));
          const expectPays = potSharesFromBatch(batch, FEE, BLOCK_SUBSIDY_NANOS, carry);
          const fee = Math.floor(BLOCK_SUBSIDY_NANOS * POOL_FEE_BPS / 10000);
          const feePays = expectPays.filter((p) => p.kind === 'pool-fee');
          const potPays = expectPays.filter((p) => p.kind === 'pot');
          assert.equal(feePays.length, 1);
          assert.equal(feePays[0].nanos, fee);
          const potSum = potPays.reduce((a, p) => a + p.nanos, 0);
          assert.equal(potSum, BLOCK_SUBSIDY_NANOS - fee + carry);
          assert.ok(potPays.length >= 1);
          if (n > 1) {
            const pots = potPays.map((p) => p.nanos);
            assert.ok(new Set(pots).size > 1, `n=${n} equal pot notes`);
            const heavy = destNc(dests[1]);
            const light = destNc(dests[0]);
            const heavyN = potPays.find((p) => ncHex(p.noteCommit) === heavy)?.nanos || 0;
            const lightN = potPays.find((p) => ncHex(p.noteCommit) === light)?.nanos || 0;
            assert.ok(heavyN > lightN, `n=${n} work ${heavyN} vs count ${lightN}`);
          }
          await seal(pool);
          const opened = openedByKind(pool.store.tip().txs[0].vout);
          for (const p of expectPays) {
            const key = `${p.kind}:${ncHex(p.noteCommit)}`;
            assert.equal(opened.get(key), p.nanos, `n=${n} ${key}`);
          }
          const openedPot = [...opened.entries()].filter(([k]) => k.startsWith('pot:'));
          assert.equal(openedPot.length, potPays.length);
          pool.rollOpenRound();
          calls = 0;
          const sent = await pool.sweepAutoPayouts();
          assert.equal(sent.length, 0);
          assert.equal(calls, 0);
          assert.equal(pool.pullBook.dueAuto({ tipHeight: pool.store.tip().height, need: 1 }).length, 0);
        }
        const file = path.join(dir, 'pull-book.json');
        if (fs.existsSync(file)) {
          const disk = fs.readFileSync(file, 'utf8');
          assert.doesNotMatch(disk, /ssa1/);
          const parsed = JSON.parse(disk);
          assert.equal((parsed.credits || []).length, 0);
        }
        for (const dest of dests) {
          assert.equal(pool.pullBook.view(publicMinerTag(dest), { tipHeight: 80, need: 1 }).pendingNanos, 0);
        }
      } finally {
        pool.close();
      }
    }
  });
});
