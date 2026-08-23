import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { newIdentity, isShearAddress } from './address.js';
import { EMPTY_ROOT } from './merkle.js';
import {
  closureCommit,
  destForLogin,
  destsForViewKey,
  flowDestAddress,
  flowSpendMatches,
  reserveRejectsDest,
  spendHashFromAddress,
} from './flow_sheet.js';

describe('flow sheets', () => {
  it('round dest is shear1, changes with continuity, spend matches, sheets do not collide', () => {
    const alice = newIdentity();
    const bob = newIdentity();
    const root1 = Buffer.alloc(32, 1);
    const root2 = Buffer.alloc(32, 2);
    const d1 = destForLogin(alice.address, { continuityRoot: root1, height: 3, viewKey: alice.viewKey });
    const d2 = destForLogin(alice.address, { continuityRoot: root2, height: 3, viewKey: alice.viewKey });
    const d3 = destForLogin(alice.address, { continuityRoot: root1, height: 4, viewKey: alice.viewKey });
    const bobD = destForLogin(bob.address, { continuityRoot: root1, height: 3, viewKey: bob.viewKey });
    assert.equal(isShearAddress(d1), true);
    assert.notEqual(d1, alice.address);
    assert.notEqual(d1, d2);
    assert.notEqual(d1, d3);
    assert.notEqual(d1, bobD);
    const S = spendHashFromAddress(alice.address);
    assert.ok(S);
    assert.equal(flowSpendMatches({
      dest: d1,
      spendHash20: S,
      closureCommit: closureCommit(alice.viewKey),
      continuityRoot: root1,
      height: 3,
    }), true);
    assert.equal(flowSpendMatches({
      dest: d1,
      spendHash20: S,
      closureCommit: closureCommit(alice.viewKey),
      continuityRoot: root2,
      height: 3,
    }), false);
  });

  it('view key opens only that user’s dests; wrong key empty; amounts-only rows', () => {
    const alice = newIdentity();
    const bob = newIdentity();
    const rounds = [
      { continuityRoot: EMPTY_ROOT, height: 1 },
      { continuityRoot: Buffer.alloc(32, 7), height: 2 },
    ];
    const aliceS = spendHashFromAddress(alice.address);
    const bobS = spendHashFromAddress(bob.address);
    assert.deepEqual(destsForViewKey('', aliceS, rounds), []);
    const aliceDests = destsForViewKey(alice.viewKey, aliceS, rounds);
    const bobDests = destsForViewKey(bob.viewKey, bobS, rounds);
    assert.equal(aliceDests.length, 2);
    assert.ok(aliceDests.every(isShearAddress));
    assert.ok(aliceDests.every((d, i) => d !== bobDests[i]));
    const cross = destsForViewKey(bob.viewKey, aliceS, rounds);
    assert.ok(cross.every((d, i) => d !== aliceDests[i]));
    const rows = aliceDests.map((dest, i) => ({ dest, amount: 1 + i, height: rounds[i].height }));
    const opened = rows.filter((r) => aliceDests.includes(r.dest));
    const bobOpened = rows.filter((r) => bobDests.includes(r.dest));
    assert.equal(opened.length, 2);
    assert.equal(bobOpened.length, 0);
    assert.ok(opened.every((r) => typeof r.amount === 'number'));
  });

  it('implied rest-frame login still yields a dest (miner --user shear1)', () => {
    const id = newIdentity();
    const dest = destForLogin(id.address, { continuityRoot: EMPTY_ROOT, height: 1 });
    assert.equal(isShearAddress(dest), true);
    assert.notEqual(dest, id.address);
    const again = destForLogin(id.address, { continuityRoot: EMPTY_ROOT, height: 1 });
    assert.equal(dest, again);
  });

  it('Reserve rejects CTF dest as lock principal', () => {
    const id = newIdentity();
    const dest = destForLogin(id.address, { continuityRoot: EMPTY_ROOT, height: 1 });
    assert.equal(reserveRejectsDest(id.address, dest, { height: 1 }), true);
    assert.equal(reserveRejectsDest(id.address, id.address, { height: 1 }), false);
  });
});
