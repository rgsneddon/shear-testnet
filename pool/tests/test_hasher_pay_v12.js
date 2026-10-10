import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newIdentity, hash20FromAddress } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { decodeHeader } from '../../crypto/header.js';
import { FEE_SPLIT_FINDER_BPS, reserveFeeDest, splitLevy } from '../../crypto/levy.js';
import { openedCoinbaseNanos } from '../../crypto/note.js';
import { GENESIS_BITS_PACKED } from '../../crypto/asert.js';
import { createPool, templateHasherDest, configuredFeeIdentity } from '../src/pool.js';
import { GENESIS_PREV, buildTemplate } from '../../node/src/chain.js';

function minerDest() {
  const id = newIdentity();
  return destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
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

function ordersOf(rows) {
  const rev = rows.slice().reverse();
  const rot = rows.length ? rows.slice(1).concat(rows.slice(0, 1)) : rows.slice();
  return [rows, rev, rot];
}

function nanosByDest(vouts, kind) {
  const by = new Map();
  for (const o of vouts || []) {
    if (kind && o.kind !== kind) continue;
    const v = openedCoinbaseNanos(o);
    assert.equal(typeof v, 'number', `output opens (${o.kind})`);
    const key = o.dest20 ? Buffer.from(o.dest20).toString('hex') : '';
    if (!key) continue;
    by.set(key, (by.get(key) || 0) + v);
  }
  return by;
}

function hexOf(dest) {
  return hash20FromAddress(dest).toString('hex');
}

describe('template miner follows proven work', () => {
  it('chooses the address-sorted proven dest for any row order', () => {
    const src = fs.readFileSync(new URL('../src/pool.js', import.meta.url), 'utf8');
    assert.equal(src.includes('[...miners.values()].find((m) => !isCminerFeeLogin'), false);
    for (const n of [1, 3, 8]) {
      const dests = [];
      for (let i = 0; i < n; i += 1) dests.push(minerDest());
      const sorted = dests.slice().sort((a, b) => a.localeCompare(b));
      const provenSets = [
        [],
        [sorted[0]],
        [sorted[sorted.length - 1]],
        sorted.slice(),
        sorted.filter((_, i) => i % 2 === 0),
      ];
      for (const proven of provenSets) {
        const expect = proven.slice().sort((a, b) => a.localeCompare(b))[0] || '';
        for (const order of ordersOf(dests)) {
          const rows = order.map((dest) => ({ login: dest, workerKey: dest, payoutDest: dest }));
          assert.equal(templateHasherDest(rows, proven), expect, `n=${n} proven=${proven.length}`);
          assert.equal(templateHasherDest(rows.slice().reverse(), proven), expect);
        }
      }
    }
  });

  it('a miner with no proven shares is not paid, in either map order', () => {
    const feeTo = configuredFeeIdentity().feeDest;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-hasher-pay-'));
    const pool = createPool({ dataDir: dir, stratumPort: 0, httpPort: 0, miner: feeTo });
    try {
      const cases = [
        { proven: [[minerDest(), 1]], idle: [minerDest(), minerDest()] },
        { proven: [[minerDest(), 2], [minerDest(), 9], [minerDest(), 40]], idle: [minerDest()] },
        { proven: [[minerDest(), 3], [minerDest(), 3], [minerDest(), 11], [minerDest(), 80]], idle: [minerDest(), minerDest(), minerDest()] },
        { proven: [], idle: [minerDest(), minerDest(), minerDest(), minerDest()] },
      ];
      for (const row of cases) {
        const base = [
          ...row.idle.map((dest) => [dest, 0]),
          ...row.proven,
        ];
        let paySnap = null;
        let minerSnap = null;
        for (const order of ordersOf(base)) {
          setMiners(pool, order);
          const job = pool.issueJob(undefined, { force: true });
          assert.ok(job?.jobId);
          const tpl = pool.store.jobs.get(String(job.jobId)).tpl;
          const provenDests = row.proven.map(([dest]) => dest);
          const expectMiner = templateHasherDest(
            order.map(([dest]) => ({ login: dest, payoutDest: dest })),
            provenDests,
          ) || feeTo;
          assert.equal(tpl.miner, expectMiner);
          for (const dest of row.idle) {
            assert.notEqual(tpl.miner, dest);
            assert.equal(nanosByDest(tpl.txs[0].vout).get(hexOf(dest)) || 0, 0);
          }
          const pot = nanosByDest(tpl.txs[0].vout, 'pot');
          const fee = nanosByDest(tpl.txs[0].vout, 'pool-fee');
          for (const [dest, work] of row.proven) {
            assert.ok((pot.get(hexOf(dest)) || 0) > 0, `proven work ${work} is paid`);
          }
          const snap = JSON.stringify([...pot.entries()].sort());
          if (paySnap == null) {
            paySnap = snap;
            minerSnap = tpl.miner;
          } else {
            assert.equal(snap, paySnap);
            assert.equal(tpl.miner, minerSnap);
          }
          if (row.proven.length) {
            const decoded = decodeHeader(Buffer.from(tpl.header));
            const finders = row.proven.map(([dest]) => dest);
            for (const feeNanos of [2, 7, 1000, 1_048_576]) {
              for (const finder of finders) {
                const rebuilt = buildTemplate({
                  prev: decoded.prevBlockHash,
                  height: tpl.height,
                  miner: tpl.miner,
                  finderDest: finder,
                  potShares: [{ address: row.proven[0][0], nanos: 1, kind: 'pot' }],
                  txs: [{ fee: feeNanos }],
                  bits: decoded.bits,
                  now: Number(decoded.timestamp),
                  poolDest: feeTo,
                  feeDest: feeTo,
                });
                const finderNotes = rebuilt.txs[0].vout.filter((o) => o.kind === 'finder-fee');
                const want = splitLevy(feeNanos).finder;
                assert.equal(want, Math.floor(feeNanos * FEE_SPLIT_FINDER_BPS / 10000));
                if (want <= 0) {
                  assert.equal(finderNotes.length, 0);
                  continue;
                }
                assert.equal(finderNotes.length, 1);
                assert.equal(openedCoinbaseNanos(finderNotes[0]), want);
                assert.ok(Buffer.from(finderNotes[0].dest20).equals(hash20FromAddress(finder)));
                assert.equal(Buffer.from(finderNotes[0].dest20).equals(hash20FromAddress(feeTo)), false);
                assert.equal(Buffer.from(finderNotes[0].dest20).equals(hash20FromAddress(reserveFeeDest())), false);
                if (finder !== tpl.miner) {
                  assert.equal(Buffer.from(finderNotes[0].dest20).equals(hash20FromAddress(tpl.miner)), false);
                }
                for (const dest of row.idle) {
                  assert.equal(Buffer.from(finderNotes[0].dest20).equals(hash20FromAddress(dest)), false);
                }
              }
            }
          }
        }
        if (!row.proven.length) {
          assert.equal(minerSnap, feeTo);
          const bare = buildTemplate({
            prev: GENESIS_PREV,
            height: 1,
            miner: feeTo,
            finderDest: '',
            poolDest: feeTo,
            feeDest: feeTo,
            txs: [{ fee: 1000 }],
            bits: GENESIS_BITS_PACKED,
            now: 1_700_000_000_000,
          });
          assert.equal(bare.txs[0].vout.some((o) => o.kind === 'finder-fee'), false);
          const reserveNote = bare.txs[0].vout.find((o) => o.kind === 'reserve-fee');
          assert.equal(openedCoinbaseNanos(reserveNote), splitLevy(1000).reserve);
          assert.ok(Buffer.from(reserveNote.dest20).equals(hash20FromAddress(reserveFeeDest())));
        }
      }
    } finally {
      pool.close();
    }
  });
});
