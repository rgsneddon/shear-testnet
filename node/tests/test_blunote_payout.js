// BluNotes payout rules (R28, D2): the draw, equal pieces, carry and
// conservation. Inputs are proven share rows as verifyBluShareBatch returns
// them; the share PoW itself is covered by test_r28_share_holes.js.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { pointBytes } from '../../crypto/note.js';
import { admitBasePub } from '../../crypto/admit.js';
import { BLUNOTE_WINNERS, oneTimeKey, recogniseOneTime, scanPub, scanScalar } from '../../crypto/blunote.js';
import { blunoteSettle } from '../src/blunote_payout.js';

function wallet() {
  const seed = randomBytes(32);
  return { seed, B: pointBytes(admitBasePub(seed)), Y: scanPub(seed), y: scanScalar(seed) };
}

function rows(n, owner = wallet(), bits = (i) => 8 + (i % 4)) {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const k = oneTimeKey({ B: owner.B, Y: owner.Y });
    const b = bits(i);
    out.push({ shareR: k.R, shareP: k.P, viewTag: k.tag, shareBits: b, units: 2 ** b, weight: 1n << BigInt(b) });
  }
  return out;
}

const UNIT = 1n;

describe('BluNotes payout', () => {
  it('conserves value: minted plus carry is the pot plus the hash bonus', () => {
    for (let t = 0; t < 40; t += 1) {
      const n = 1 + (t * 7) % 300;
      const pot = BigInt(1_000_000 + t * 12_345);
      const got = blunoteSettle({
        shares: rows(n),
        powHash: randomBytes(32),
        potPayable: pot,
        unitNanos: UNIT,
        budgetNanos: t % 3 === 0 ? 1000n : null,
      });
      assert.equal(got.minted + got.carryOut, pot + got.hashNanos);
      assert.equal(got.winners.reduce((a, w) => a + w.m, 0), BLUNOTE_WINNERS);
      for (const w of got.winners) assert.equal(w.v, got.piece * BigInt(w.m));
      assert.ok(got.carryOut < BigInt(BLUNOTE_WINNERS));
    }
  });

  it('gives every winner the same piece, and one note per drawn share', () => {
    const got = blunoteSettle({ shares: rows(3), powHash: randomBytes(32), potPayable: 1_600_000n, unitNanos: UNIT });
    const ps = new Set(got.winners.map((w) => w.admitPub.toString('hex')));
    assert.equal(ps.size, got.winners.length);
    for (const w of got.winners) assert.equal(w.leaf.length, 96);
  });

  it('is the same on every node and moves with the block hash', () => {
    const r = rows(50);
    const h = randomBytes(32);
    const a = blunoteSettle({ shares: r, powHash: h, potPayable: 5_000_000n, unitNanos: UNIT });
    const b = blunoteSettle({ shares: r, powHash: Buffer.from(h), potPayable: 5_000_000n, unitNanos: UNIT });
    assert.deepEqual(a.winners.map((w) => [w.index, w.m]), b.winners.map((w) => [w.index, w.m]));
    let moved = false;
    for (let i = 0; i < 8 && !moved; i += 1) {
      const c = blunoteSettle({ shares: r, powHash: randomBytes(32), potPayable: 5_000_000n, unitNanos: UNIT });
      moved = JSON.stringify(c.winners.map((w) => w.index)) !== JSON.stringify(a.winners.map((w) => w.index));
    }
    assert.ok(moved);
  });

  it('an empty batch draws nothing, mints no floor note, and carries the pot (R34)', () => {
    const got = blunoteSettle({ shares: [], powHash: randomBytes(32), potPayable: 777n, unitNanos: UNIT });
    assert.equal(got.notes.length, 0);
    assert.equal(got.minted, 0n);
    assert.equal(got.carryOut, 777n);
    const pool = wallet();
    const fee = oneTimeKey({ B: pool.B, Y: pool.Y });
    const withFee = blunoteSettle({ shares: [], powHash: randomBytes(32), potPayable: 777n, feeNanos: 7n, feeKey: { R: fee.R, P: fee.P, viewTag: fee.tag }, unitNanos: UNIT });
    assert.equal(withFee.notes.length, 1);
    assert.equal(withFee.notes[0].kind, 'pool-fee');
    assert.equal(withFee.minted, 7n);
    assert.equal(withFee.carryOut, 770n);
  });

  it('scales the hash bonus inside the block when over budget (D2)', () => {
    const r = rows(10, wallet(), () => 20); // 10 x 2^20 units
    const capped = blunoteSettle({ shares: r, powHash: randomBytes(32), potPayable: 0n, unitNanos: UNIT, budgetNanos: 1n << 20n });
    assert.equal(capped.hashNanos, 1n << 20n);
    const free = blunoteSettle({ shares: r, powHash: randomBytes(32), potPayable: 0n, unitNanos: UNIT });
    assert.equal(free.hashNanos, 10n << 20n);
  });

  it('forfeits a winner whose key is not a point to carry, and conserves', () => {
    const r = rows(1);
    r[0].shareP = Buffer.alloc(32, 0xff);
    const got = blunoteSettle({ shares: r, powHash: randomBytes(32), potPayable: 1_600n, unitNanos: UNIT });
    assert.equal(got.winners.length, 0);
    assert.equal(got.minted, 0n);
    assert.equal(got.carryOut, 1_600n + got.hashNanos);
  });

  it('a fee key that is not a point forfeits the fee to the miners', () => {
    const got = blunoteSettle({
      shares: rows(4), powHash: randomBytes(32), potPayable: 16_000n, feeNanos: 160n,
      feeKey: { R: randomBytes(32), P: Buffer.alloc(32, 0xff), viewTag: 0 }, unitNanos: UNIT,
    });
    assert.equal(got.notes.filter((n) => n.kind === 'pool-fee').length, 0);
    assert.equal(got.minted + got.carryOut, 16_000n + got.hashNanos);
  });

  it('only the miner finds its winner notes', () => {
    const me = wallet();
    const stranger = wallet();
    const got = blunoteSettle({ shares: rows(20, me), powHash: randomBytes(32), potPayable: 3_200_000n, unitNanos: UNIT });
    for (const w of got.winners) {
      assert.ok(recogniseOneTime({ y: me.y, B: me.B }, w.R, w.admitPub, w.viewTag) != null);
      assert.equal(recogniseOneTime({ y: stranger.y, B: stranger.B }, w.R, w.admitPub, w.viewTag), null);
    }
  });
});
