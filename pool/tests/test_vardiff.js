import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { newIdentity, freshStealthDest } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { createPool, scoreShare, judgeShare } from '../src/pool.js';
import { destBoundShareHash, noteCommitOfShare } from '../../crypto/share_batch.js';
import { setNonce } from '../../crypto/header.js';
import { shearHash, meetsTarget } from '../../crypto/shear_hash.js';
import { SHARE_FLOOR_BITS, SHEARK_MINER_VERSION, GENESIS_BITS_PACKED, GENESIS_BITS, unpackBits } from '../../crypto/asert.js';
import {
  clampShareBits,
  expectedOneThreadHs,
  hashesProvenByShare,
  destVardiffOnShare,
  hashesCreditedForShare,
  nextShareBits,
  shouldRetargetShare,
  SHARE_VARDIFF_TARGET_MS,
  SHARE_VARDIFF_RETARGET_MS,
  SHARE_VARDIFF_RETARGET_SHARES,
  SHARE_BITS_V2_START,
  mintShareMinBits,
} from '../src/share_vardiff.js';

function send(sock, obj) {
  sock.write(`${JSON.stringify(obj)}\n`);
}

function attachLines(sock) {
  let buf = '';
  const q = [];
  const waiters = [];
  sock.setEncoding('utf8');
  sock.on('data', (chunk) => {
    buf += chunk;
    let n;
    while ((n = buf.indexOf('\n')) >= 0) {
      const raw = buf.slice(0, n);
      buf = buf.slice(n + 1);
      if (!raw.trim()) continue;
      const msg = JSON.parse(raw);
      if (waiters.length) waiters.shift()(msg);
      else q.push(msg);
    }
  });
  return function readLine(timeoutMs = 8000) {
    if (q.length) return Promise.resolve(q.shift());
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('line timeout')), timeoutMs);
      waiters.push((msg) => {
        clearTimeout(t);
        resolve(msg);
      });
    });
  };
}

function findNonces(job, n) {
  const out = [];
  for (let nonce = 0n; nonce < 2_000_000n && out.length < n; nonce += 1n) {
    const s = scoreShare({ job, nonce });
    if (!s.ok) continue;
    if (s.block) continue;
    out.push({ nonce, hash: s.hash });
  }
  return out;
}

describe('share vardiff', () => {
  it('expected 1-thread H/s is hashes-per-share over the target interval', () => {
    const one = expectedOneThreadHs(12);
    assert.ok(one > 0);
    assert.equal(one, hashesProvenByShare(12) / (SHARE_VARDIFF_TARGET_MS / 1000));
  });

  it('v2 opening share bits is livable at RandomX-lite H/s, not SHA-256 farm scale', () => {
    assert.equal(SHARE_BITS_V2_START, 8);
    const one = expectedOneThreadHs(SHARE_BITS_V2_START);
    assert.ok(one < 10_000, `opening 1-thread H/s ${one} is SHA-256 scale`);
    assert.ok(one > 10);
    assert.ok(expectedOneThreadHs(18) > one);
  });

  it('v2 share interval is slow enough that RandomX verify cannot flood the event loop', () => {
    assert.ok(SHARE_VARDIFF_TARGET_MS >= 2000, SHARE_VARDIFF_TARGET_MS);
  });

  it('never exceeds block bits and never goes below min', () => {
    assert.equal(clampShareBits(24, { blockBits: 21 }), 21);
    assert.equal(clampShareBits(16, { blockBits: 29 }), 16);
    assert.equal(clampShareBits(1, { minBits: 4, blockBits: 8 }), 4);
    assert.equal(clampShareBits(40, { blockBits: 48 }), 40);
    assert.equal(clampShareBits(25, { blockBits: 25 }), 25);
    assert.equal(clampShareBits(300), 256);
  });

  it('raises share bits by one when shares arrive faster than the target', () => {
    const next = nextShareBits({
      current: 8,
      actualIntervalMs: 1,
      targetMs: SHARE_VARDIFF_TARGET_MS,
      blockBits: 21,
    });
    assert.equal(next, 9, `climb is +1 from 8, got ${next}`);
    assert.ok(next <= 21);
  });

  it('eases by one and does not pass the mint floor', () => {
    assert.equal(nextShareBits({
      current: 12,
      actualIntervalMs: 100_000,
      targetMs: SHARE_VARDIFF_TARGET_MS,
      blockBits: 21,
      minBits: 8,
    }), 11);
    assert.equal(nextShareBits({
      current: 8,
      actualIntervalMs: 100_000,
      targetMs: SHARE_VARDIFF_TARGET_MS,
      blockBits: 21,
      minBits: 8,
    }), 8);
  });

  it('does not let share bits fight header bits', () => {
    const next = nextShareBits({
      current: 16,
      actualIntervalMs: 1,
      blockBits: 16,
    });
    assert.equal(next, 16);
  });

  it('retargets only after a full share sample and the minimum window', () => {
    assert.equal(shouldRetargetShare({
      shares: SHARE_VARDIFF_RETARGET_SHARES,
      elapsedMs: SHARE_VARDIFF_RETARGET_MS,
    }), true);
    assert.equal(shouldRetargetShare({
      shares: SHARE_VARDIFF_RETARGET_SHARES,
      elapsedMs: 100,
    }), false);
    assert.equal(shouldRetargetShare({ shares: 1, elapsedMs: 20_000 }), false);
    assert.equal(shouldRetargetShare({ shares: 1, elapsedMs: 100 }), false);
  });

  it('a fast full sample climbs one bit off the floor', () => {
    let state = { shares: 0, windowAt: 1_000, bits: 8, lastStepAt: 0 };
    let stepped = null;
    for (let t = 1_000; t <= 1_000 + SHARE_VARDIFF_RETARGET_MS; t += 100) {
      state = destVardiffOnShare({
        state,
        now: t,
        minBits: 8,
        blockBits: 30,
      });
      if (state.stepped) {
        stepped = state;
        break;
      }
    }
    assert.ok(stepped, 'sustained fast shares must leave the floor');
    assert.equal(stepped.from, 8);
    assert.equal(stepped.bits, 9);
    assert.ok(stepped.sampleShares >= SHARE_VARDIFF_RETARGET_SHARES);
  });

  it('one slow share does not ease, and a matched window holds', () => {
    const thin = destVardiffOnShare({
      state: { shares: 0, windowAt: 1_000, bits: 12, lastStepAt: 0 },
      now: 31_000,
      minBits: 8,
      blockBits: 30,
    });
    assert.equal(thin.stepped, false);
    assert.equal(thin.bits, 12);
    assert.equal(thin.shares, 1);
    let state = { shares: 0, windowAt: 1_000, bits: 10, lastStepAt: 0 };
    for (const t of [1_000, 3_667, 6_334, 9_000]) {
      state = destVardiffOnShare({
        state,
        now: t,
        minBits: 8,
        blockBits: 30,
      });
    }
    assert.equal(state.stepped, false);
    assert.equal(state.bits, 10);
    assert.equal(state.shares, 0);
    const again = destVardiffOnShare({
      state,
      now: 9_100,
      minBits: 8,
      blockBits: 30,
    });
    assert.equal(again.stepped, false);
    assert.equal(again.shares, 1);
  });

  it('same dest follows the combined share rate, not the slow worker', () => {
    const slowOnly = nextShareBits({
      current: 10,
      actualIntervalMs: 8_000,
      targetMs: SHARE_VARDIFF_TARGET_MS,
      minBits: 8,
      blockBits: 21,
    });
    assert.equal(slowOnly, 9);
    let state = { shares: 0, windowAt: 1_000, bits: 10, lastStepAt: 0 };
    for (const t of [1_000, 3_000, 5_000, 9_000]) {
      state = destVardiffOnShare({
        state,
        now: t,
        minBits: 8,
        blockBits: 21,
      });
    }
    assert.equal(state.stepped, false);
    assert.equal(state.bits, 10);
  });

  it('a vardiff target does not pay by itself', () => {
    const credited = hashesCreditedForShare({ shareBits: 12, creditedShareBits: 8 });
    assert.equal(credited, hashesProvenByShare(8));
    assert.notEqual(credited, hashesProvenByShare(12));
  });

  it('createPool login job uses v2 opening share bits; accept path retargets from actual interval', async () => {
    const src = fs.readFileSync(new URL('../src/pool.js', import.meta.url), 'utf8');
    const vd = fs.readFileSync(new URL('../src/share_vardiff.js', import.meta.url), 'utf8');
    assert.match(vd, /shouldRetargetShare/);
    assert.match(vd, /nextShareBits/);
    assert.match(vd, /destVardiffOnShare/);
    assert.equal(vd.includes('lastFoundAt'), false);
    assert.equal(vd.includes('findAt'), false);
    assert.match(src, /destVardiffOnShare/);
    assert.match(src, /event: 'vardiff_step'/);
    assert.match(src, /c\.shareBits = next/);
    assert.equal(src.includes('shouldRetargetShare({ shares: conn.varShares'), false);
    assert.equal(src.includes('const retargeted = issueJob(next)'), false);
    assert.match(src, /wireJob\(live, next\)/);
    assert.match(src, /shareBits: conn\?\.shareBits/);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-var-'));
    const id = newIdentity();
    const dest = freshStealthDest(id).dest;
    const openBits = 4;
    const pool = createPool({
      dataDir: dir,
      stratumPort: 0,
      httpPort: 0,
      miner: dest,
      shareBits: openBits,
      bits: 12,
    });
    await new Promise((resolve, reject) => {
      pool.stratum.listen(0, '127.0.0.1', () => {
        pool.httpServer.listen(0, '127.0.0.1', resolve);
      });
      pool.stratum.on('error', reject);
    });
    const sock = net.connect(pool.stratum.address().port, '127.0.0.1');
    const readLine = attachLines(sock);
    try {
      send(sock, {
        id: 1,
        method: 'login',
        params: {
          login: dest + '.var',
          client: 'ShearHash',
          version: SHEARK_MINER_VERSION,
          threads: 1,
        },
      });
      const hello = await readLine();
      assert.equal(hello.error, undefined, JSON.stringify(hello));
      const job = hello.job || hello.result?.job;
      assert.ok(job, `login must return a job, got ${JSON.stringify(hello)}`);
      assert.equal(Number(job.shareBits), mintShareMinBits());
      assert.ok(Number(job.shareBits) > openBits);
      assert.equal(Number(job.blockBits), GENESIS_BITS_PACKED);
      assert.ok(unpackBits(job.blockBits) >= GENESIS_BITS);
      assert.ok(Number(job.shareBits) <= unpackBits(job.blockBits));
      const climbed = nextShareBits({
        current: mintShareMinBits(),
        actualIntervalMs: 1,
        blockBits: job.blockBits,
        minBits: mintShareMinBits(),
      });
      assert.ok(climbed >= mintShareMinBits(), 'session bits never sit below mint floor');
      assert.ok(climbed <= Number(job.blockBits));
    } finally {
      sock.end();
      pool.close();
    }
  });

  it('1-thread dest-bound 8 still scores when a farm has climbed lastJob.shareBits', () => {
    const dest = 'ssa1qsj3qt0mcuznqv6r5370d58tw32gz3yhjychuu0sljyw5zmw9pmwc47d9vnwagjafs3ywjz7udh7suc7e3qsshw25ze';
    const header = Buffer.alloc(128, 0);
    header[0] = 1;
    // A zero bits field is an always-true block target, so every hash would
    // be accepted as a block. Pin a real target above the share rung.
    header.writeUInt32LE(32, 108);
    let hit = null;
    for (let n = 1; n < 400_000; n += 1) {
      const h = setNonce(header, n);
      const rx = shearHash(h);
      if (meetsTarget(rx, 32)) continue;
      const bound = destBoundShareHash(rx, noteCommitOfShare({ dest }));
      if (!meetsTarget(bound, SHARE_FLOOR_BITS)) continue;
      if (meetsTarget(bound, 12)) continue;
      hit = { header: h, hash: rx };
      break;
    }
    assert.ok(hit, 'need dest-bound 8 that misses 12');
    const farmJob = { shareBits: 12, blockBits: 16, bits: 16 };
    const asFarm = judgeShare({ job: farmJob, header: hit.header, hash: hit.hash, dest });
    assert.equal(asFarm.ok, false, 'farm 12-bit job must not accept 8-bit dest-bound');
    assert.equal(asFarm.reason, 'low_diff');
    const asAfk = judgeShare({ job: farmJob, header: hit.header, hash: hit.hash, dest, shareBits: 8 });
    assert.equal(asAfk.ok, true, asAfk.reason);
    assert.equal(asAfk.creditedShareBits, 8);
  });
});
