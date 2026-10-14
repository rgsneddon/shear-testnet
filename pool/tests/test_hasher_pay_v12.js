import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { newIdentity, hash20FromAddress, poolFeeDest } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { decodeHeader } from '../../crypto/header.js';
import { SHEARK_MINER_VERSION } from '../../crypto/asert.js';
import { FEE_SPLIT_FINDER_BPS, reserveFeeDest, splitLevy, unclaimedFinderDest } from '../../crypto/levy.js';
import { openedCoinbaseNanos } from '../../crypto/note.js';
import { createPool, templateHasherDest, configuredFeeIdentity } from '../src/pool.js';
import { buildTemplate, coinbaseLevyPays, templateForFinder } from '../../node/src/chain.js';

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

function byDest20(list) {
  return list.slice().sort((a, b) => Buffer.compare(hash20FromAddress(a), hash20FromAddress(b)));
}

function finderNotesOf(tpl) {
  return (tpl?.txs?.[0]?.vout || []).filter((o) => o.kind === 'finder-fee');
}

function same20(note, dest) {
  const want = hash20FromAddress(dest);
  return !!(note && want && Buffer.from(note.dest20).equals(want));
}

function assertNotFeeSink(note, feeTo, label) {
  assert.equal(same20(note, feeTo), false, label);
  assert.equal(same20(note, reserveFeeDest()), false, label);
  assert.equal(same20(note, poolFeeDest()), false, label);
}

function listen(pool) {
  return new Promise((resolve, reject) => {
    pool.stratum.listen(0, '127.0.0.1', () => {
      pool.httpServer.listen(0, '127.0.0.1', resolve);
    });
    pool.stratum.on('error', reject);
  });
}

function login(pool, dest) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(pool.stratum.address().port, '127.0.0.1');
    sock.setEncoding('utf8');
    let buf = '';
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error('login_timeout'));
    }, 8000);
    sock.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    let first = null;
    let grace = null;
    const take = (msg) => {
      const job = msg.method === 'job' ? msg.params : (msg.job || msg.result?.job || null);
      return { sock, job, error: msg.error || '' };
    };
    sock.on('data', (chunk) => {
      buf += chunk;
      while (true) {
        const nl = buf.indexOf('\n');
        if (nl < 0) break;
        const raw = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let msg;
        try { msg = JSON.parse(raw); } catch (err) {
          clearTimeout(timer);
          if (grace) clearTimeout(grace);
          sock.destroy();
          reject(err);
          return;
        }
        const got = take(msg);
        const id = String(got.job?.jobId || '');
        if (id.includes('.')) {
          clearTimeout(timer);
          if (grace) clearTimeout(grace);
          resolve(got);
          return;
        }
        if (!first && got.job) {
          first = got;
          grace = setTimeout(() => {
            clearTimeout(timer);
            resolve(first);
          }, 1500);
        }
      }
    });
    sock.write(`${JSON.stringify({
      id: 1,
      method: 'login',
      params: {
        login: `${dest}.finder`,
        client: 'ShearHash',
        version: SHEARK_MINER_VERSION,
        threads: 1,
      },
    })}\n`);
  });
}

describe('finder-fee pays the miner who found the block', () => {
  it('orders a proven header hasher by dest20 bytes for any row order', () => {
    const src = fs.readFileSync(new URL('../src/pool.js', import.meta.url), 'utf8');
    assert.equal(src.includes('[...miners.values()].find((m) => !isCminerFeeLogin'), false);
    assert.equal(src.includes('eligible.sort((a, b) => a.localeCompare(b))'), false);
    let disagreed = false;
    const bag = [];
    for (let i = 0; i < 48 && !disagreed; i += 1) bag.push(minerDest());
    for (let n = 2; n <= 8 && !disagreed; n += 1) {
      for (let i = 0; i + n <= bag.length; i += 3) {
        const group = bag.slice(i, i + n);
        const byteMin = byDest20(group)[0];
        const localeMin = group.slice().sort((a, b) => a.localeCompare(b))[0];
        if (byteMin !== localeMin) {
          disagreed = true;
          const rows = group.map((dest) => ({ login: dest, workerKey: dest, payoutDest: dest }));
          assert.equal(templateHasherDest(rows, group), byteMin);
          assert.notEqual(templateHasherDest(rows, group), localeMin);
          assert.equal(templateHasherDest(rows.slice().reverse(), group), byteMin);
        }
      }
    }
    assert.equal(disagreed, true, 'dest20 order differed from localeCompare');
    for (const n of [1, 3, 8]) {
      const dests = [];
      for (let i = 0; i < n; i += 1) dests.push(minerDest());
      const provenSets = [
        [],
        [dests[0]],
        [dests[dests.length - 1]],
        dests.slice(),
        dests.filter((_, i) => i % 2 === 0),
      ];
      for (const proven of provenSets) {
        const expect = byDest20(proven)[0] || '';
        for (const order of ordersOf(dests)) {
          const rows = order.map((dest) => ({ login: dest, workerKey: dest, payoutDest: dest }));
          assert.equal(templateHasherDest(rows, proven), expect, `n=${n} proven=${proven.length}`);
          assert.equal(templateHasherDest(rows.slice().reverse(), proven), expect);
        }
      }
    }
  });

  it('an aimed header pays that miner, and an empty round does not name a fee dest', async () => {
    const feeTo = configuredFeeIdentity().feeDest;
    const heldDest = unclaimedFinderDest();
    assert.notEqual(heldDest, feeTo);
    assert.notEqual(heldDest, reserveFeeDest());
    assert.notEqual(heldDest, poolFeeDest());
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-hasher-pay-'));
    const pool = createPool({ dataDir: dir, stratumPort: 0, httpPort: 0, miner: feeTo });
    const socks = [];
    try {
      const cases = [
        { proven: [[minerDest(), 1]], idle: [minerDest(), minerDest()] },
        { proven: [[minerDest(), 2], [minerDest(), 9], [minerDest(), 40]], idle: [minerDest()] },
        { proven: [[minerDest(), 3], [minerDest(), 3], [minerDest(), 11], [minerDest(), 80]], idle: [minerDest(), minerDest(), minerDest()] },
        { proven: [], idle: [minerDest(), minerDest(), minerDest(), minerDest()] },
      ];
      const fees = [0, 1, 2, 7, 1000, 1_048_576, (2 ** 40) + 9];
      for (const row of cases) {
        const base = [
          ...row.idle.map((dest) => [dest, 0]),
          ...row.proven,
        ];
        let paySnap = null;
        let minerSnap = null;
        const provenDests = row.proven.map(([dest]) => dest);
        const byteMin = byDest20(provenDests)[0] || '';
        for (const order of ordersOf(base)) {
          setMiners(pool, order);
          const job = pool.issueJob(undefined, { force: true });
          assert.ok(job?.jobId);
          const tpl = pool.store.jobs.get(String(job.jobId)).tpl;
          const expectMiner = byteMin || heldDest;
          assert.equal(tpl.miner, expectMiner);
          assert.notEqual(tpl.miner, feeTo);
          assert.notEqual(tpl.miner, poolFeeDest());
          assert.notEqual(tpl.miner, reserveFeeDest());
          for (const dest of row.idle) {
            assert.notEqual(tpl.miner, dest);
            assert.equal(nanosByDest(tpl.txs[0].vout).get(hexOf(dest)) || 0, 0);
          }
          const pot = nanosByDest(tpl.txs[0].vout, 'pot');
          const fee = nanosByDest(tpl.txs[0].vout, 'pool-fee');
          for (const [dest, work] of row.proven) {
            assert.ok((pot.get(hexOf(dest)) || 0) > 0, `proven work ${work} is paid`);
          }
          if (feeTo) assert.equal((fee.get(hexOf(feeTo)) || 0) > 0, pot.size + fee.size > 0);
          const issuedFinder = finderNotesOf(tpl);
          for (const note of issuedFinder) assertNotFeeSink(note, feeTo, 'issued job');
          const snap = JSON.stringify([...pot.entries()].sort());
          if (paySnap == null) {
            paySnap = snap;
            minerSnap = tpl.miner;
          } else {
            assert.equal(snap, paySnap);
            assert.equal(tpl.miner, minerSnap);
          }
          const decoded = decodeHeader(Buffer.from(tpl.header));
          const aimers = row.proven.length
            ? [...provenDests, row.idle[0]]
            : row.idle.slice(0, 2);
          for (const feeNanos of fees) {
            const shuffled = aimers.slice().reverse();
            const shared = buildTemplate({
              prev: decoded.prevBlockHash,
              height: tpl.height,
              miner: tpl.miner,
              finderDest: '',
              potShares: row.proven.length
                ? [{ address: provenDests[0], nanos: 1, kind: 'pot' }]
                : [{ address: feeTo, nanos: 1, kind: 'pool-fee' }],
              txs: [{ fee: feeNanos }],
              bits: decoded.bits,
              now: Number(decoded.timestamp),
              poolDest: feeTo,
              feeDest: feeTo,
            });
            const want = splitLevy(feeNanos).finder;
            assert.equal(want, Math.floor(feeNanos * FEE_SPLIT_FINDER_BPS / 10000));
            const heldNotes = finderNotesOf(shared);
            if (want <= 0) {
              assert.equal(heldNotes.length, 0, `fee ${feeNanos}`);
              assert.equal(templateForFinder(shared, shuffled[0]), shared);
              continue;
            }
            assert.equal(heldNotes.length, 1, `fee ${feeNanos}`);
            assert.equal(openedCoinbaseNanos(heldNotes[0]), want);
            assert.equal(same20(heldNotes[0], heldDest), true, `fee ${feeNanos} holds`);
            assertNotFeeSink(heldNotes[0], feeTo, `shared ${feeNanos}`);
            if (byteMin) assert.equal(same20(heldNotes[0], byteMin), false, `shared ${feeNanos}`);
            assert.equal(templateForFinder(shared, feeTo), null, `fee dest ${feeNanos}`);
            assert.equal(templateForFinder(shared, reserveFeeDest()), null, `reserve ${feeNanos}`);
            assert.equal(templateForFinder(shared, heldDest), null, `hold ${feeNanos}`);
            for (const finder of shuffled) {
              const aimed = templateForFinder(shared, finder);
              assert.ok(aimed, `aim ${feeNanos}`);
              const notes = finderNotesOf(aimed);
              assert.equal(notes.length, 1);
              assert.equal(openedCoinbaseNanos(notes[0]), want);
              assert.equal(same20(notes[0], finder), true, `finder ${feeNanos}`);
              assert.equal(aimed.miner, finder);
              assertNotFeeSink(notes[0], feeTo, `aimed ${feeNanos}`);
              if (finder !== byteMin && byteMin) {
                assert.equal(same20(notes[0], byteMin), false, `not byte-min ${feeNanos}`);
              }
              for (const dest of row.idle) {
                if (dest !== finder) assert.equal(same20(notes[0], dest), false);
              }
              for (const dest of provenDests) {
                if (dest !== finder) assert.equal(same20(notes[0], dest), false);
              }
              const bound = coinbaseLevyPays(aimed.txs[0], feeNanos);
              assert.equal(bound.ok, true, bound.reason || `levy ${feeNanos}`);
            }
            const still = finderNotesOf(shared);
            assert.equal(same20(still[0], heldDest), true, 'shared note stays held');
          }
        }
        if (!row.proven.length) {
          assert.equal(minerSnap, heldDest);
          assert.notEqual(minerSnap, feeTo);
        } else {
          assert.equal(minerSnap, byteMin);
          assert.notEqual(minerSnap, feeTo);
        }
      }

      const liveA = minerDest();
      const liveB = minerDest();
      const liveC = minerDest();
      const live = [[liveA, 4], [liveB, 15], [liveC, 1]];
      setMiners(pool, [...live].reverse());
      const issued = pool.issueJob(undefined, { force: true });
      assert.ok(issued?.jobId);
      const rec = pool.store.jobs.get(String(issued.jobId));
      const decoded = decodeHeader(Buffer.from(rec.tpl.header));
      const liveMin = byDest20(live.map(([dest]) => dest))[0];
      assert.equal(rec.tpl.miner, liveMin);
      const aimFee = 1000;
      const shared = buildTemplate({
        prev: decoded.prevBlockHash,
        height: rec.tpl.height,
        miner: rec.tpl.miner,
        finderDest: '',
        potShares: [{ address: liveA, nanos: 1, kind: 'pot' }],
        txs: [{ fee: aimFee }],
        bits: decoded.bits,
        now: Number(decoded.timestamp),
        poolDest: feeTo,
        feeDest: feeTo,
      });
      assert.equal(same20(finderNotesOf(shared)[0], heldDest), true);
      rec.tpl = shared;
      await listen(pool);
      const other = live.find(([dest]) => dest !== liveMin)[0];
      const sessions = [];
      for (const dest of [other, liveMin, feeTo]) {
        const got = await login(pool, dest);
        socks.push(got.sock);
        sessions.push({ dest, got });
        assert.equal(got.error, '', got.error);
        assert.ok(got.job?.jobId);
      }
      for (const { dest, got } of sessions) {
        if (dest === feeTo) {
          assert.equal(String(got.job.jobId).includes('.'), false);
          const baseNotes = finderNotesOf(pool.store.jobs.get(String(issued.jobId)).tpl);
          assert.equal(same20(baseNotes[0], heldDest), true);
          assertNotFeeSink(baseNotes[0], feeTo, 'fee login');
          continue;
        }
        assert.equal(String(got.job.jobId).startsWith(`${issued.jobId}.`), true, got.job.jobId);
        const aimed = pool.store.jobs.get(String(got.job.jobId))?.tpl;
        assert.ok(aimed, got.job.jobId);
        const notes = finderNotesOf(aimed);
        assert.equal(notes.length, 1);
        assert.equal(openedCoinbaseNanos(notes[0]), splitLevy(aimFee).finder);
        assert.equal(same20(notes[0], dest), true, dest === liveMin ? 'byte-min aimed' : 'other aimed');
        assert.equal(aimed.miner, dest);
        assertNotFeeSink(notes[0], feeTo, 'login aim');
        if (dest !== liveMin) assert.equal(same20(notes[0], liveMin), false);
      }
    } finally {
      for (const sock of socks) {
        try { sock.destroy(); } catch { /* closed */ }
      }
      pool.close();
    }
  });
});
