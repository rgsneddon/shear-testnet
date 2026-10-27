import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { G, commit, pointBytes } from './note.js';
import { admitBaseScalar, admitBasePub } from './admit.js';
import {
  BLUNOTE_WINNERS,
  bindNonce,
  bindingOk,
  batchSumRoot,
  blunoteNote,
  blunoteRho,
  decodeRecord,
  drawPieces,
  drawWinners,
  encodeRecord,
  jobBytes,
  notesFromRecord,
  oneTimeKey,
  oneTimeSpendScalar,
  recogniseOneTime,
  recordRoot,
  scanPub,
  scanScalar,
  workId,
} from './blunote.js';

function wallet() {
  const seed = randomBytes(32);
  return {
    seed,
    xBase: admitBaseScalar(seed),
    B: pointBytes(admitBasePub(seed)),
    y: scanScalar(seed),
    Y: scanPub(seed),
  };
}

function header() {
  return randomBytes(128);
}

describe('BluNotes one-time keys', () => {
  it('only the owner recognises and can spend a share key', () => {
    const me = wallet();
    const other = wallet();
    for (let i = 0; i < 8; i += 1) {
      const k = oneTimeKey({ B: me.B, Y: me.Y });
      const delta = recogniseOneTime({ y: me.y, B: me.B }, k.R, k.P, k.tag);
      assert.ok(delta != null);
      const x = oneTimeSpendScalar(me.xBase, delta);
      assert.deepEqual(pointBytes(G.multiply(x)), k.P);
      assert.equal(recogniseOneTime({ y: other.y, B: other.B }, k.R, k.P), null);
    }
  });

  it('two keys for one address share no bytes a chain observer can match', () => {
    const me = wallet();
    const seen = new Set();
    for (let i = 0; i < 64; i += 1) {
      const k = oneTimeKey({ B: me.B, Y: me.Y });
      for (const part of [k.R, k.P]) {
        const hex = part.toString('hex');
        assert.equal(seen.has(hex), false);
        seen.add(hex);
      }
      assert.notDeepEqual(k.P, me.B);
    }
  });

  it('the view tag skips strangers before the second point operation', () => {
    const me = wallet();
    const k = oneTimeKey({ B: me.B, Y: me.Y });
    assert.equal(recogniseOneTime({ y: me.y, B: me.B }, k.R, k.P, (k.tag + 1) & 0xff), null);
  });

  it('a garbage R or P is not recognised and does not throw', () => {
    const me = wallet();
    assert.equal(recogniseOneTime({ y: me.y, B: me.B }, Buffer.alloc(32, 0xff), Buffer.alloc(32, 1)), null);
  });
});

describe('BluNotes nonce binding (H1)', () => {
  it('binds the payee into the nonce for this job only', () => {
    const me = wallet();
    const k = oneTimeKey({ B: me.B, Y: me.Y });
    const h = header();
    for (const [counter, bits] of [[0, 8], [255, 8], [7, 20]]) {
      const n = bindNonce(h, k.R, k.P, counter, bits);
      assert.equal(bindingOk(h, n, k.R, k.P), true);
      assert.equal(Number(n & 0xffn), counter);
      assert.equal(Number(n >> 56n), bits);
    }
    const n = bindNonce(h, k.R, k.P, 1, 8);
    // Another payee on the same nonce is refused.
    const k2 = oneTimeKey({ B: me.B, Y: me.Y });
    assert.equal(bindingOk(h, n, k2.R, k2.P), false);
    // The same payee on another job is refused.
    const h2 = Buffer.from(h);
    h2[40] ^= 1;
    assert.equal(bindingOk(h2, n, k.R, k.P), false);
    // The nonce field of the header itself does not change the job.
    const h3 = Buffer.from(h);
    h3.fill(9, 112, 120);
    assert.deepEqual(jobBytes(h3), jobBytes(h));
    assert.equal(bindingOk(h3, n, k.R, k.P), true);
  });

  it('re-aiming one nonce at 65,536 other payees never binds', () => {
    const me = wallet();
    const k = oneTimeKey({ B: me.B, Y: me.Y });
    const h = header();
    const n = bindNonce(h, k.R, k.P, 3, 8);
    let hits = 0;
    for (let i = 0; i < 1 << 16; i += 1) {
      if (bindingOk(h, n, randomBytes(32), randomBytes(32))) hits += 1;
    }
    assert.equal(hits, 0);
  });

  it('refuses a nonce outside u64', () => {
    const h = header();
    assert.equal(bindingOk(h, -1n, randomBytes(32), randomBytes(32)), false);
    assert.equal(bindingOk(h, 1n << 64n, randomBytes(32), randomBytes(32)), false);
    assert.equal(bindingOk(h, 'x', randomBytes(32), randomBytes(32)), false);
  });
});

describe('BluNotes work id', () => {
  it('names one hashed header: nonce and header bytes both count', () => {
    const h = header();
    const a = workId(h);
    const b = Buffer.from(h);
    b[112] ^= 1;
    const c = Buffer.from(h);
    c[5] ^= 1;
    assert.notEqual(workId(b), a);
    assert.notEqual(workId(c), a);
    assert.equal(workId(Buffer.from(h)), a);
  });
});

describe('BluNotes draw', () => {
  it('is deterministic, takes k draws, and is empty for an empty batch', () => {
    const seed = randomBytes(32);
    const w = [256n, 512n, 4096n, 256n];
    const a = drawWinners(seed, w);
    assert.deepEqual(drawWinners(seed, w), a);
    assert.equal(a.reduce((n, r) => n + r.m, 0), BLUNOTE_WINNERS);
    for (let i = 1; i < a.length; i += 1) assert.ok(a[i].index > a[i - 1].index);
    assert.deepEqual(drawWinners(seed, []), []);
    assert.throws(() => drawWinners(seed, [0n]));
  });

  it('hits each share in proportion to its weight', () => {
    // weights 1:3; over 2,000 seeds x 16 draws, share 1 should take ~75%.
    let hit1 = 0;
    let all = 0;
    for (let i = 0; i < 2000; i += 1) {
      for (const r of drawWinners(randomBytes(32), [256n, 768n])) {
        if (r.index === 1) hit1 += r.m;
        all += r.m;
      }
    }
    const p = hit1 / all;
    assert.ok(p > 0.74 && p < 0.76, `share of the heavier ticket ${p}`);
  });

  it('splits a total into k equal pieces plus a carry', () => {
    assert.deepEqual(drawPieces(1000n, 16), { piece: 62n, carry: 8n });
    assert.deepEqual(drawPieces(0n, 16), { piece: 0n, carry: 0n });
  });
});

describe('BluNotes implicit note', () => {
  it('derives the same note and FS-1 leaf on every node', () => {
    const me = wallet();
    const k = oneTimeKey({ B: me.B, Y: me.Y });
    const a = blunoteNote(k.P, 12345n);
    const b = blunoteNote(Buffer.from(k.P), 12345n);
    assert.ok(a && a.leaf && a.leaf.length === 96);
    assert.deepEqual(a, b);
    assert.deepEqual(a.commit, pointBytes(commit(12345n, blunoteRho(k.P))));
    // The owner can open it: x for P, and rho for C.
    const delta = recogniseOneTime({ y: me.y, B: me.B }, k.R, k.P, k.tag);
    assert.deepEqual(pointBytes(G.multiply(oneTimeSpendScalar(me.xBase, delta))), a.admitPub);
  });

  it('is null for a P that is not a point', () => {
    assert.equal(blunoteNote(Buffer.alloc(32, 0xff), 1n), null);
  });
});

describe('BluNotes compact record', () => {
  it('round-trips and its root moves with any byte', () => {
    const me = wallet();
    const frames = [randomBytes(88), randomBytes(88), randomBytes(88)];
    const weights = [256n, 512n, 256n];
    const sum = batchSumRoot(frames, weights);
    assert.equal(sum.total, 1024n);
    const fee = oneTimeKey({ B: me.B, Y: me.Y });
    const winners = [0, 1].map((i) => ({ ...oneTimeKey({ B: me.B, Y: me.Y }), m: i + 1 }));
    const rec = { batchRoot: sum.root, n: 3, W: sum.total, T: 1_000_000n, feeV: 5_000n, feeR: fee.R, feeP: fee.P, winners };
    const bytes = encodeRecord(rec);
    assert.equal(bytes.length, 125 + 2 * 65);
    const back = decodeRecord(bytes);
    assert.deepEqual(back.batchRoot, Buffer.from(sum.root));
    assert.equal(back.n, 3);
    assert.equal(back.W, 1024n);
    assert.equal(back.T, 1_000_000n);
    assert.equal(back.feeV, 5_000n);
    // The paid notes come back from the record alone: the fee, then each winner.
    const notes = notesFromRecord(bytes);
    assert.deepEqual(notes.map((x) => x.v), [5_000n, 62_500n, 125_000n]);
    assert.deepEqual(notes[0].admitPub, Buffer.from(fee.P));
    assert.deepEqual(back.winners.map((w) => w.m), [1, 2]);
    const flipped = Buffer.from(bytes);
    flipped[100] ^= 1;
    assert.notDeepEqual(recordRoot(flipped), recordRoot(bytes));
    assert.equal(decodeRecord(bytes.subarray(0, bytes.length - 1)), null);
    // 16 winners: 125 + 16 x 65 = 1,165 bytes (the design note's 1,156 B plus the fee value).
    const full = encodeRecord({ ...rec, winners: Array.from({ length: 16 }, () => ({ ...winners[0], m: 1 })) });
    assert.equal(full.length, 125 + 16 * 65);
  });

  it('the Merkle-sum root commits to weights as well as frames', () => {
    const frames = [randomBytes(88), randomBytes(88)];
    assert.notDeepEqual(batchSumRoot(frames, [256n, 256n]).root, batchSumRoot(frames, [256n, 512n]).root);
    assert.deepEqual(batchSumRoot([], []).root, Buffer.alloc(32));
  });
});

