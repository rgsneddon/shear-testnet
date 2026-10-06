import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newIdentity, hash20FromAddress } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { POOL_FEE_BPS } from '../../crypto/asert.js';
import { decodeHeader, encodeHeader } from '../../crypto/header.js';
import { merkleRoot } from '../../crypto/merkle.js';
import { openedCoinbaseNanos, sealCoinbaseNote, addExcess } from '../../crypto/note.js';
import { createPool, potRoundShares, configuredFeeIdentity, THIS_POOL_DIRECT_FEE_DEST } from '../src/pool.js';
import { verifyBlock, digestTx } from '../../node/src/chain.js';

function minerDest() {
  const id = newIdentity();
  return destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
}

function destsOf(vouts) {
  return (vouts || []).filter((o) => o?.dest20).map((o) => Buffer.from(o.dest20));
}

function hasDest(vouts, dest) {
  const want = hash20FromAddress(dest);
  return destsOf(vouts).some((d) => d.equals(want));
}

function potOpened(vouts) {
  let sum = 0;
  const byDest = new Map();
  for (const o of vouts || []) {
    if (o.kind === 'hash' || o.kind === 'finder-fee' || o.kind === 'reserve-fee') continue;
    const v = openedCoinbaseNanos(o);
    assert.equal(typeof v, 'number', 'pot output opens');
    sum += v;
    const key = o.dest20 ? Buffer.from(o.dest20).toString('hex') : '';
    if (key) byDest.set(key, (byDest.get(key) || 0) + v);
  }
  return { sum, byDest };
}

let powTag = 1;
function easyPowHash() {
  const h = Buffer.alloc(32);
  h[4] = 3;
  h[5] = powTag & 0xff;
  h[6] = (powTag >> 8) & 0xff;
  h[7] = (powTag >> 16) & 0xff;
  powTag += 1;
  return h;
}

function blockFrom(tpl, txs) {
  const decoded = decodeHeader(Buffer.from(tpl.header));
  return {
    header: encodeHeader({
      version: decoded.version,
      prevBlockHash: decoded.prevBlockHash,
      merkleRoot: merkleRoot(txs.map(digestTx)),
      continuityRoot: decoded.continuityRoot,
      timestamp: decoded.timestamp,
      bits: decoded.bits,
      nonce: decoded.nonce,
      baseFee: decoded.baseFee,
    }),
    txs,
    samples: tpl.samples,
    shareBatch: tpl.shareBatch || [],
    miner: tpl.miner,
    poolDest: tpl.poolDest,
    aLeaves: tpl.aLeaves,
    bLeaves: tpl.bLeaves,
    rootA: tpl.rootA,
    rootB: tpl.rootB,
    weight: tpl.weight,
    height: tpl.height,
  };
}

function setMiners(pool, rows) {
  pool.miners.clear();
  rows.forEach(([dest, hashes], i) => {
    pool.miners.set(`m-${i}-${hashes}`, {
      login: dest,
      workerKey: dest,
      payoutDest: dest,
      roundHashes: hashes,
      hashes,
      accepted: hashes,
      connections: [],
    });
  });
}

describe('v12 empty round carries the pot to the next proven round', () => {
  it('splitter pays no empty-round row; a proven round fees the amount it is given', () => {
    const src = fs.readFileSync(new URL('../src/pool.js', import.meta.url), 'utf8');
    assert.doesNotMatch(src, /\[\s*\{\s*miner:\s*hasherPay,\s*count:\s*1\s*\}\s*\]/);
    const feeTo = configuredFeeIdentity().feeDest;
    assert.equal(configuredFeeIdentity().ok, true);
    const a = minerDest();
    const b = minerDest();
    const idle = minerDest();
    for (const want of [0, 1, 17, 10_000, 100_000_000_003, (2 ** 40) + 9]) {
      assert.deepEqual(
        potRoundShares({ lag1Shares: [], potRows: [], feeTo, wantPot: want }),
        [],
        `empty carry at ${want}`,
      );
      if (!(want > 0)) continue;
      const feeNanos = Math.floor(want * POOL_FEE_BPS / 10000);
      if (!(feeNanos > 0 && feeNanos < want)) continue;
      const split = potRoundShares({
        lag1Shares: [],
        potRows: [
          { miner: a, count: 1 },
          { miner: b, count: 4 },
          { miner: idle, count: 0 },
        ],
        feeTo,
        wantPot: want,
      });
      const fee = split.find((s) => s.address === feeTo);
      const rest = split.filter((s) => s.address !== feeTo).reduce((n, s) => n + s.nanos, 0);
      assert.ok(fee, `fee slice at ${want}`);
      assert.equal(fee.nanos, feeNanos);
      assert.equal(rest + fee.nanos, want);
      assert.equal(split.some((s) => s.address === idle), false);
      assert.notEqual(fee.nanos, want);
    }
  });

  it('stacks empty rounds of several sizes, then pays the next proven miners', async () => {
    const feeTo = configuredFeeIdentity().feeDest;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-empty-pot-'));
    const pool = createPool({ dataDir: dir, stratumPort: 0, httpPort: 0, miner: feeTo });
    try {
      const genesisNow = Date.now();
      const seeded = pool.store.template({ miner: feeTo, now: genesisNow });
      const sealedGen = await pool.store.submitHeader({
        jobId: seeded.job.jobId,
        nonce: 0n,
        miner: feeTo,
        powHash: easyPowHash().toString('hex'),
      }, { trusted: true });
      assert.equal(sealedGen.ok, true, sealedGen.reason || 'genesis');
      const genesisMs = Number(decodeHeader(Buffer.from(pool.store.tip().header)).timestamp);
      let carry = Math.floor(Number(pool.store.tip().txs[0].carryNanos) || 0);
      assert.equal(carry, 0, 'genesis pays its pot');
      let minted = potOpened(pool.store.tip().txs[0].vout).sum;
      let scheduled = minted;

      async function sealJob(job) {
        const got = await pool.store.submitHeader({
          jobId: job.jobId,
          nonce: 0n,
          miner: feeTo,
          powHash: easyPowHash().toString('hex'),
        }, { trusted: true });
        assert.equal(got.ok, true, got.reason || 'seal');
        const cb = pool.store.tip().txs[0];
        const opened = potOpened(cb.vout).sum;
        const nextCarry = Math.floor(Number(cb.carryNanos) || 0);
        const subsidy = opened + nextCarry - carry;
        assert.ok(subsidy > 0, 'subsidy');
        scheduled += subsidy;
        minted += opened;
        carry = nextCarry;
        assert.equal(minted + carry, scheduled, 'minted pot plus outstanding carry');
        return cb;
      }

      function jobTpl(job) {
        return pool.store.jobs.get(String(job.jobId)).tpl;
      }

      const verifyOpts = {
        skipSharePow: true,
        nowMs: Date.now() + 30_000,
        genesisMs,
      };

      for (const n of [0, 1, 4, 17]) {
        const connected = [];
        for (let i = 0; i < n; i += 1) connected.push(minerDest());
        setMiners(pool, connected.map((dest) => [dest, 0]));
        const before = carry;
        const job = pool.issueJob(undefined, { force: true });
        assert.ok(job?.jobId, `empty job ${n}`);
        const tpl = jobTpl(job);
        const cb = tpl.txs[0];
        const opened = potOpened(cb.vout);
        const growth = cb.carryNanos - before;
        const subsidy = growth + opened.sum;
        const feeNanos = Math.floor(subsidy * POOL_FEE_BPS / 10000);
        assert.equal(opened.sum, feeNanos, `empty round mints only this subsidy's fee at count ${n}`);
        assert.ok(growth > 0, `miner pot carries at count ${n}`);
        assert.notEqual(opened.sum, subsidy, `fee is not the pot at count ${n}`);
        assert.equal(hasDest(cb.vout, feeTo), feeNanos > 0, `fee dest at count ${n}`);
        if (feeNanos > 0) {
          const feeHex = hash20FromAddress(feeTo).toString('hex');
          assert.equal(opened.byDest.get(feeHex), feeNanos);
          assert.equal(cb.vout.some((o) => o.kind === 'pot'), false, `no pot skim at count ${n}`);
          assert.ok(cb.vout.some((o) => o.kind === 'pool-fee' && Buffer.from(o.dest20).equals(hash20FromAddress(feeTo))));
        }
        for (const dest of connected) {
          assert.equal(hasDest(cb.vout, dest), false, `idle miner unpaid at count ${n}`);
        }
        assert.equal((tpl.shareBatch || []).length, 0);
        if (n === 0) {
          assert.equal(feeTo, THIS_POOL_DIRECT_FEE_DEST);
          const dropped = blockFrom(tpl, [{ ...cb, carryNanos: 0 }, ...tpl.txs.slice(1)]);
          const bad = verifyBlock(dropped, pool.store.tip(), {
            ...verifyOpts,
            trustedPowHash: easyPowHash(),
          });
          assert.equal(bad.ok, false);
          assert.equal(bad.reason, 'pot');
          const skim = Math.max(1, Math.floor(Number(cb.carryNanos) / 7));
          const note = sealCoinbaseNote(skim, { dest20: hash20FromAddress(feeTo), kind: 'pot' });
          const skimTxs = [{
            ...cb,
            vout: cb.vout.concat([note]),
            excess: addExcess(cb.excess, note.r),
            carryNanos: cb.carryNanos - skim,
          }, ...tpl.txs.slice(1)];
          const skimmed = verifyBlock(blockFrom(tpl, skimTxs), pool.store.tip(), {
            ...verifyOpts,
            trustedPowHash: easyPowHash(),
          });
          assert.equal(skimmed.ok, false);
          assert.equal(skimmed.reason, 'pot_carry');
        }
        await sealJob(job);
      }
      assert.ok(carry > 0, 'stacked carry is outstanding');

      async function prove(rows) {
        const before = carry;
        setMiners(pool, rows);
        const workers = rows.filter(([, n]) => n > 0).map(([dest]) => dest);
        const idles = rows.filter(([, n]) => n <= 0).map(([dest]) => dest);
        const job = pool.issueJob(undefined, { force: true });
        assert.ok(job?.jobId, `proven ${workers.length}`);
        const tpl = jobTpl(job);
        const cb = tpl.txs[0];
        assert.equal(Math.floor(Number(cb.carryNanos) || 0), 0, 'proven round does not carry');
        const paid = potOpened(cb.vout);
        assert.ok(paid.sum > before, 'pays the stacked carry plus this subsidy');
        const subsidy = paid.sum - before;
        const feeNanos = Math.floor(subsidy * POOL_FEE_BPS / 10000);
        assert.ok(feeNanos > 0 && feeNanos < subsidy, 'fee is the bps slice of this subsidy, not the carried pot');
        const feeHex = hash20FromAddress(feeTo).toString('hex');
        assert.equal(paid.byDest.get(feeHex) || 0, feeNanos);
        let workerSum = 0;
        for (const dest of workers) {
          const n = paid.byDest.get(hash20FromAddress(dest).toString('hex')) || 0;
          assert.ok(n > 0, 'proven miner is paid');
          workerSum += n;
        }
        for (const dest of idles) {
          assert.equal(paid.byDest.get(hash20FromAddress(dest).toString('hex')) || 0, 0);
        }
        assert.equal(workerSum + feeNanos, paid.sum);
        await sealJob(job);
        assert.equal(carry, 0);
      }

      const one = minerDest();
      await prove([[one, 5]]);

      const idle3 = [minerDest(), minerDest(), minerDest()];
      setMiners(pool, idle3.map((dest) => [dest, 0]));
      const emptyAgain = pool.issueJob(undefined, { force: true });
      const again = jobTpl(emptyAgain).txs[0];
      const againOpened = potOpened(again.vout).sum;
      assert.ok(againOpened > 0 && againOpened < Number(again.carryNanos));
      assert.equal(hasDest(again.vout, feeTo), true);
      await sealJob(emptyAgain);
      assert.ok(carry > 0);

      await prove([
        [minerDest(), 1],
        [minerDest(), 4],
        [minerDest(), 9],
      ]);

      const mixed = [
        [minerDest(), 0],
        [minerDest(), 2],
        [minerDest(), 0],
        [minerDest(), 8],
        [minerDest(), 3],
        [minerDest(), 0],
      ];
      setMiners(pool, mixed.map(([dest]) => [dest, 0]));
      const emptyMixed = pool.issueJob(undefined, { force: true });
      const mixedCb = jobTpl(emptyMixed).txs[0];
      const mixedOpened = potOpened(mixedCb.vout).sum;
      assert.ok(mixedOpened > 0 && mixedOpened < Number(mixedCb.carryNanos));
      await sealJob(emptyMixed);
      await prove(mixed);
      assert.equal(minted + carry, scheduled);
    } finally {
      pool.close();
    }
  });
});
