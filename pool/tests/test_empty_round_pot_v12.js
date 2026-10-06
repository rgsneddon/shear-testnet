import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newIdentity, hash20FromAddress } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { GENESIS_BITS_PACKED, MAGIC_TESTNET, POOL_FEE_BPS, POOL_FEE_MAX_BPS, SHARE_FLOOR_BITS, TARGET_BLOCK_INTERVAL_MS, asertNextBits } from '../../crypto/asert.js';
import { decodeHeader, encodeHeader } from '../../crypto/header.js';
import { merkleRoot } from '../../crypto/merkle.js';
import { openedCoinbaseNanos, sealCoinbaseNote, addExcess, noteCommitOfDest20 } from '../../crypto/note.js';
import { aLeavesFromShares, clearLiveSharePow, destOfShare, noteCommitOfShare, rememberLiveSharePow, shareWorkBits, unitsForShare } from '../../crypto/share_batch.js';
import { epochMs, potSubsidyAt, potSubsidyNanos } from '../../crypto/pot_sched.js';
import { createPool, potRoundShares, configuredFeeIdentity, THIS_POOL_DIRECT_FEE_DEST } from '../src/pool.js';
import { GENESIS_PREV, buildTemplate, canonicalCarry, custodyPotShares, digestTx, potPaysFromLeaves, potSharesFromBatch, verifyBlock } from '../../node/src/chain.js';

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

  it('splits carried pot across proven work, not onto one row', () => {
    const src = fs.readFileSync(new URL('../src/pool.js', import.meta.url), 'utf8');
    assert.equal(src.includes('pots[pots.length - 1].nanos += carryIn'), false);
    const feeTo = configuredFeeIdentity().feeDest;
    const unit = unitsForShare();
    const subsidies = [1, 17, 10_000, 100_000_000_003, (2 ** 40) + 9];
    const streaks = [0, 1, 3, 6];
    const mixes = [
      [[1]],
      [[8]],
      [[1], [1], [1]],
      [[1], [4], [9]],
      [[1], [100], [7]],
      [[1], [1]],
    ];
    function pileOf(subsidy, carry) {
      const fee = Math.floor(subsidy * POOL_FEE_BPS / 10000);
      return { fee, pile: subsidy - fee + carry };
    }
    function expectLive(dests, weights, subsidy, carry) {
      const { fee, pile } = pileOf(subsidy, carry);
      const ordered = dests.map((dest, i) => [dest, weights[i]]).sort((a, b) => a[0].localeCompare(b[0]));
      const total = ordered.reduce((sum, [, n]) => sum + n, 0);
      const out = new Map();
      let paid = 0;
      for (let i = 0; i < ordered.length; i += 1) {
        const nanos = i === ordered.length - 1 ? pile - paid : Math.floor(pile * ordered[i][1] / total);
        paid += nanos;
        out.set(ordered[i][0], nanos);
      }
      out.set(feeTo, (out.get(feeTo) || 0) + fee);
      return out;
    }
    for (const subsidy of subsidies) {
      const fee = Math.floor(subsidy * POOL_FEE_BPS / 10000);
      if (!(fee > 0 && fee < subsidy)) continue;
      for (const streak of streaks) {
        const carry = streak * (subsidy - fee);
        for (const shape of mixes) {
          const dests = shape.map(() => minerDest());
          const weights = shape.map((row) => row[0]);
          const orders = [
            dests.map((dest, i) => ({ miner: dest, count: weights[i] })),
            [...dests].reverse().map((dest) => ({ miner: dest, count: weights[dests.indexOf(dest)] })),
            [...dests].slice(1).concat(dests[0]).map((dest) => ({ miner: dest, count: weights[dests.indexOf(dest)] })),
          ];
          const want = expectLive(dests, weights, subsidy, carry);
          for (const potRows of orders) {
            const split = potRoundShares({ lag1Shares: [], potRows, feeTo, wantPot: subsidy, carryNanos: carry });
            const got = new Map();
            for (const row of split) got.set(row.address, (got.get(row.address) || 0) + row.nanos);
            assert.equal(got.size, want.size);
            for (const [dest, nanos] of want) assert.equal(got.get(dest), nanos, `${dest} ${subsidy} ${carry}`);
            assert.equal([...got.values()].reduce((a, n) => a + n, 0), subsidy + carry);
          }
          if (dests.length > 1 && carry >= weights.reduce((a, n) => a + n, 0)) {
            const onlySubsidy = expectLive(dests, weights, subsidy, 0);
            for (const dest of dests) {
              assert.notEqual(want.get(dest), (onlySubsidy.get(dest) || 0) + carry);
            }
          }
          const shares = [];
          let nonce = 1n;
          dests.forEach((dest, i) => {
            for (let n = 0; n < weights[i]; n += 1) {
              shares.push({ dest, dest20: hash20FromAddress(dest), nonce, lz: 8 });
              nonce += 1n;
            }
          });
          const ncWeights = dests.map((dest, i) => [noteCommitOfDest20(hash20FromAddress(dest)).toString('hex'), dest, weights[i] * unit]);
          ncWeights.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
          const { fee: batchFee, pile } = pileOf(subsidy, carry);
          const total = ncWeights.reduce((sum, row) => sum + row[2], 0);
          const batchWant = new Map();
          let paid = 0;
          for (let i = 0; i < ncWeights.length; i += 1) {
            const nanos = i === ncWeights.length - 1 ? pile - paid : Math.floor(pile * ncWeights[i][2] / total);
            paid += nanos;
            batchWant.set(ncWeights[i][1], nanos);
          }
          batchWant.set(feeTo, (batchWant.get(feeTo) || 0) + batchFee);
          const shuffled = [shares, [...shares].reverse(), [...shares.slice(1), shares[0]]];
          for (const lag1Shares of shuffled) {
            const split = potRoundShares({
              lag1Shares,
              potRows: [],
              feeTo,
              wantPot: subsidy,
              carryNanos: carry,
            });
            const got = new Map();
            for (const row of split) got.set(row.address, (got.get(row.address) || 0) + row.nanos);
            for (const [dest, nanos] of batchWant) assert.equal(got.get(dest), nanos);
            assert.equal([...got.values()].reduce((a, n) => a + n, 0), subsidy + carry);
          }
        }
      }
    }
  });

  it('a pool fee is a bps of this subsidy only, across carries, epochs, and miner mixes', { timeout: 600_000 }, () => {
    assert.equal(POOL_FEE_MAX_BPS, 200);
    const feeTo = configuredFeeIdentity().feeDest;
    const genesisMs = 1_700_000_000_000;
    const floor = SHARE_FLOOR_BITS;
    const mixes = [
      [{ bits: floor, n: 1 }],
      [{ bits: floor, n: 1 }, { bits: floor + 3, n: 2 }, { bits: floor + 1, n: 1 }],
      [{ bits: floor, n: 4 }, { bits: floor + 2, n: 1 }, { bits: floor + 5, n: 1 }, { bits: floor, n: 2 }, { bits: floor + 1, n: 3 }],
    ];
    const feeKey = hash20FromAddress(feeTo).toString('hex');

    function batchOf(spec) {
      const miners = spec.map(() => minerDest());
      const batch = [];
      let nonce = 1n;
      spec.forEach((row, i) => {
        for (let n = 0; n < row.n; n += 1) {
          batch.push({
            dest: miners[i],
            dest20: hash20FromAddress(miners[i]),
            nonce,
            lz: floor,
            shareBits: row.bits,
          });
          nonce += 1n;
        }
      });
      return { miners, batch };
    }

    function mapRows(batch, pays) {
      const destByNc = new Map();
      for (const s of batch) {
        const nc = noteCommitOfShare(s);
        const dest = destOfShare(s);
        if (nc && dest) destByNc.set(Buffer.from(nc).toString('hex'), dest);
      }
      destByNc.set(noteCommitOfDest20(hash20FromAddress(feeTo)).toString('hex'), feeTo);
      return pays.map((p) => ({
        address: destByNc.get(Buffer.from(p.noteCommit).toString('hex')) || '',
        nanos: p.nanos,
        kind: p.kind || 'pot',
      }));
    }

    function rowsFor(batch, subsidy, carry, bps, foldDest = null) {
      const fee = Math.floor(subsidy * bps / 10000);
      const pool = foldDest || (fee > 0 ? feeTo : null);
      return mapRows(batch, potPaysFromLeaves(aLeavesFromShares(batch), pool, fee, subsidy, carry));
    }

    function onSubsidyScale(subsidy, amount) {
      if (!(amount > 0)) return true;
      for (let bps = 1; bps <= POOL_FEE_MAX_BPS; bps += 1) {
        if (Math.floor(subsidy * bps / 10000) === amount) return true;
      }
      return false;
    }

    function attackRows(batch, subsidy, carry, bps, foldDest = null) {
      const minted = subsidy + carry;
      const bad = Math.floor(minted * bps / 10000);
      const pool = foldDest || feeTo;
      return {
        bad,
        rows: mapRows(batch, potPaysFromLeaves(aLeavesFromShares(batch), pool, bad, minted, 0)),
      };
    }

    function byAddress(rows) {
      const got = new Map();
      for (const row of rows) got.set(row.address, (got.get(row.address) || 0) + row.nanos);
      return got;
    }

    function samePay(a, b) {
      assert.equal(a.size, b.size);
      for (const [dest, nanos] of a) assert.equal(b.get(dest), nanos);
    }

    function sealTpl(tpl, prev, now) {
      const block = {
        header: tpl.header,
        txs: tpl.txs,
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
      clearLiveSharePow();
      if (prev?.header) {
        for (const row of block.shareBatch || []) {
          const bits = shareWorkBits(row);
          if (bits <= SHARE_FLOOR_BITS) continue;
          rememberLiveSharePow(prev.header, row.nonce, {
            noteCommit: noteCommitOfShare(row),
            shareBits: bits,
            lz: row.lz,
          });
        }
      }
      const res = verifyBlock(block, prev, {
        trustedPowHash: easyPowHash(),
        skipSharePow: true,
        nowMs: now + 1_000,
        genesisMs,
        poolDest: feeTo,
        mtpTimestamps: [now - 1_000],
      });
      return { block, res };
    }

    function bitsAfter(parent, childNow, childHeight) {
      const ph = decodeHeader(parent.block.header);
      const quote = asertNextBits({
        anchorBits: GENESIS_BITS_PACKED,
        anchorTimeMs: genesisMs,
        anchorHeight: 1,
        blockTimeMs: childNow,
        blockHeight: childHeight,
        parentTimeMs: Number(ph.timestamp),
      });
      assert.equal(quote.ok, true, `asert h=${childHeight}`);
      return quote.packed;
    }

    function emptyBlock(prev, height, now, bits) {
      const subsidy = potSubsidyAt({ nowMs: now, genesisMs, magic: MAGIC_TESTNET });
      const fee = Math.floor(subsidy * POOL_FEE_BPS / 10000);
      const tpl = buildTemplate({
        prev: height === 1 ? GENESIS_PREV : prev.res.hash,
        prevHeader: prev?.block.header,
        prevBlock: prev?.block,
        height,
        miner: feeTo,
        bits,
        now,
        potShares: [{ address: feeTo, nanos: fee, kind: 'pool-fee' }],
        poolDest: feeTo,
      });
      const got = sealTpl(tpl, prev ? { ...prev.block, hash: prev.res.hash } : null, now);
      assert.equal(got.res.ok, true, `empty h=${height} ${got.res.reason}`);
      return got;
    }

    const paidTpl = buildTemplate({
      prev: GENESIS_PREV,
      height: 1,
      miner: feeTo,
      bits: GENESIS_BITS_PACKED,
      now: genesisMs,
      potShares: custodyPotShares(feeTo, potSubsidyNanos(0)),
      poolDest: feeTo,
    });
    const paid = sealTpl(paidTpl, null, genesisMs);
    assert.equal(paid.res.ok, true, paid.res.reason);
    assert.equal(canonicalCarry(paid.block.txs[0]), 0);

    const empties = [];
    {
      let prev = null;
      let now = genesisMs;
      let bits = GENESIS_BITS_PACKED;
      for (let i = 0; i < 4; i += 1) {
        const got = emptyBlock(prev, i + 1, now, bits);
        empties.push(got);
        const nextNow = now + TARGET_BLOCK_INTERVAL_MS;
        bits = bitsAfter(got, nextNow, i + 2);
        prev = got;
        now = nextNow;
      }
    }

    function prove(parent, batch, rows, now, miner) {
      const height = parent.block.height + 1;
      const tpl = buildTemplate({
        prev: parent.res.hash,
        prevHeader: parent.block.header,
        prevBlock: parent.block,
        height,
        miner,
        bits: bitsAfter(parent, now, height),
        now,
        potShares: rows,
        shareBatch: batch,
        poolDest: feeTo,
      });
      return sealTpl(tpl, { ...parent.block, hash: parent.res.hash }, now);
    }

    function assertSeparate(got, subsidy, carry, bps) {
      assert.equal(got.res.ok, true, got.res.reason);
      const opened = potOpened(got.block.txs[0].vout);
      const fee = Math.floor(subsidy * bps / 10000);
      const cap = Math.floor(subsidy * POOL_FEE_MAX_BPS / 10000);
      assert.ok(fee <= cap);
      assert.equal(opened.sum, subsidy + carry);
      assert.equal(opened.byDest.get(feeKey) || 0, fee);
      assert.equal(opened.sum - fee, subsidy - fee + carry);
      assert.equal(canonicalCarry(got.block.txs[0]), 0);
    }

    function rejectCarryFee(parent, batch, subsidy, carry, now, miner, bps, foldDest = null) {
      const { bad, rows } = attackRows(batch, subsidy, carry, bps, foldDest);
      if (onSubsidyScale(subsidy, bad)) return false;
      const got = prove(parent, batch, rows, now, miner);
      assert.equal(got.res.ok, false);
      assert.equal(got.res.reason, 'pot_prop');
      return true;
    }

    const streaks = [
      { name: 'none', parent: paid, now: genesisMs + TARGET_BLOCK_INTERVAL_MS },
      { name: 'one', parent: empties[0], now: genesisMs + TARGET_BLOCK_INTERVAL_MS },
      { name: 'several', parent: empties[3], now: genesisMs + 4 * TARGET_BLOCK_INTERVAL_MS },
    ];
    const built = mixes.map((spec) => batchOf(spec));
    const dense = built[1];
    const oneParent = streaks[1];
    const oneSubsidy = potSubsidyAt({ nowMs: oneParent.now, genesisMs, magic: MAGIC_TESTNET });
    const oneCarry = canonicalCarry(oneParent.parent.block.txs[0]);
    assert.ok(oneCarry > 0);
    let sawCarryReject = false;
    for (let bps = 0; bps <= POOL_FEE_MAX_BPS; bps += 1) {
      const rows = rowsFor(dense.batch, oneSubsidy, oneCarry, bps);
      const flipped = [...dense.batch].reverse();
      const rotated = [...dense.batch.slice(1), dense.batch[0]];
      samePay(byAddress(rows), byAddress(rowsFor(flipped, oneSubsidy, oneCarry, bps)));
      samePay(byAddress(rows), byAddress(rowsFor(rotated, oneSubsidy, oneCarry, bps)));
      assert.equal([...byAddress(rows).values()].reduce((a, n) => a + n, 0), oneSubsidy + oneCarry);
      const got = prove(oneParent.parent, dense.batch, rows, oneParent.now, dense.miners[0]);
      assertSeparate(got, oneSubsidy, oneCarry, bps);
    }
    for (const bps of [POOL_FEE_MAX_BPS + 1, 250, 300, 10_000]) {
      if (rejectCarryFee(oneParent.parent, dense.batch, oneSubsidy, oneCarry, oneParent.now, dense.miners[0], bps)) {
        sawCarryReject = true;
      }
      if (rejectCarryFee(oneParent.parent, dense.batch, oneSubsidy, oneCarry, oneParent.now, dense.miners[0], bps, dense.miners[0])) {
        sawCarryReject = true;
      }
    }
    const folded = rowsFor(dense.batch, oneSubsidy, oneCarry, 1, dense.miners[0]);
    const foldedGot = prove(oneParent.parent, dense.batch, folded, oneParent.now, dense.miners[0]);
    assert.equal(foldedGot.res.ok, true, foldedGot.res.reason);
    assert.equal(potOpened(foldedGot.block.txs[0].vout).sum, oneSubsidy + oneCarry);
    const dumped = rowsFor(dense.batch, oneSubsidy, 0, POOL_FEE_BPS);
    const dumpPots = dumped.filter((s) => s.kind !== 'pool-fee');
    assert.ok(dumpPots.length > 1);
    dumpPots[dumpPots.length - 1].nanos += oneCarry;
    const fairDump = byAddress(rowsFor(dense.batch, oneSubsidy, oneCarry, POOL_FEE_BPS));
    const dumpedPay = byAddress(dumped);
    let dumpDiffers = dumpedPay.size !== fairDump.size;
    for (const [dest, nanos] of dumpedPay) {
      if (fairDump.get(dest) !== nanos) dumpDiffers = true;
    }
    assert.equal(dumpDiffers, true);
    const dumpGot = prove(oneParent.parent, dense.batch, dumped, oneParent.now, dense.miners[0]);
    assert.equal(dumpGot.res.ok, false);
    assert.equal(dumpGot.res.reason, 'pot_prop');

    for (const streak of streaks) {
      const subsidy = potSubsidyAt({ nowMs: streak.now, genesisMs, magic: MAGIC_TESTNET });
      const carry = canonicalCarry(streak.parent.block.txs[0]);
      for (let i = 0; i < built.length; i += 1) {
        if (streak.name === 'one' && i === 1) continue;
        const { miners, batch } = built[i];
        for (const bps of [0, 1, 100, POOL_FEE_MAX_BPS]) {
          const rows = rowsFor(batch, subsidy, carry, bps);
          samePay(byAddress(rows), byAddress(rowsFor([...batch].reverse(), subsidy, carry, bps)));
          const got = prove(streak.parent, batch, rows, streak.now, miners[0]);
          assertSeparate(got, subsidy, carry, bps);
        }
        if (carry > 0 && miners.length > 1) {
          if (rejectCarryFee(streak.parent, batch, subsidy, carry, streak.now, miners[0], 100)) sawCarryReject = true;
          const zero = rowsFor(batch, subsidy, 0, 100);
          const pots = zero.filter((s) => s.kind !== 'pool-fee');
          if (pots.length > 1) {
            pots[pots.length - 1].nanos += carry;
            const got = prove(streak.parent, batch, zero, streak.now, miners[0]);
            assert.equal(got.res.reason, 'pot_prop');
          }
        }
      }
    }

    const span = epochMs(MAGIC_TESTNET);
    for (const epoch of [1, 7, 80]) {
      const childNow = genesisMs + epoch * span + TARGET_BLOCK_INTERVAL_MS;
      const subsidy = potSubsidyNanos(epoch);
      const carry = canonicalCarry(empties[0].block.txs[0]);
      assert.notEqual(subsidy, oneSubsidy);
      for (const bps of [0, 1, 100, POOL_FEE_MAX_BPS]) {
        const rows = rowsFor(dense.batch, subsidy, carry, bps);
        const got = prove(empties[0], dense.batch, rows, childNow, dense.miners[0]);
        assertSeparate(got, subsidy, carry, bps);
      }
      if (rejectCarryFee(empties[0], dense.batch, subsidy, carry, childNow, dense.miners[0], 100)) {
        sawCarryReject = true;
      }
    }
    assert.equal(sawCarryReject, true);
    const reversed = prove(
      streaks[2].parent,
      [...dense.batch].reverse(),
      rowsFor(dense.batch, potSubsidyAt({ nowMs: streaks[2].now, genesisMs, magic: MAGIC_TESTNET }), canonicalCarry(streaks[2].parent.block.txs[0]), 100),
      streaks[2].now,
      dense.miners[0],
    );
    assertSeparate(
      reversed,
      potSubsidyAt({ nowMs: streaks[2].now, genesisMs, magic: MAGIC_TESTNET }),
      canonicalCarry(streaks[2].parent.block.txs[0]),
      100,
    );
  });
});
