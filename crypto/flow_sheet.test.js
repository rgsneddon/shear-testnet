import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { newIdentity, isShearAddress, isDestAddress } from './address.js';
import { EMPTY_ROOT } from './merkle.js';
import {
  destForLogin,
  destsForViewKey,
  degenerateDest,
  viewSecretFromPassword,
  closureCommit,
  vaultDest,
  reserveRejectsDest,
  memoSeal,
  memoOpen,
  explorerRowPublic,
  spendHashFromAddress,
} from './flow_sheet.js';
import { issueVorticeKey, parseVorticeKey, addVortice, RESERVE_VORTICE } from './vortex.js';
import { extraMintAllowed } from './asert.js';

describe('flow sheets', () => {
  it('paid dest is she1, needs password C, not C-from-S', () => {
    const alice = newIdentity();
    const bob = newIdentity();
    const salt = Buffer.alloc(16, 9);
    const V = viewSecretFromPassword('correct-horse', salt);
    const C = closureCommit(V);
    const root1 = Buffer.alloc(32, 1);
    const root2 = Buffer.alloc(32, 2);
    const paid = destForLogin(alice.address, { continuityRoot: root1, height: 3, closureCommit: C });
    const deg = degenerateDest(alice.address, { continuityRoot: root1, height: 3 });
    assert.equal(destForLogin(alice.address, { continuityRoot: root1, height: 3 }), null);
    assert.equal(isDestAddress(paid), true);
    assert.equal(paid.startsWith('she1'), true);
    assert.equal(isShearAddress(paid), false);
    assert.equal(isDestAddress(alice.address), false);
    assert.notEqual(paid, alice.address);
    assert.notEqual(paid, deg);
    assert.notEqual(
      destForLogin(alice.address, { continuityRoot: root2, height: 3, closureCommit: C }),
      paid,
    );
    assert.notEqual(
      destForLogin(alice.address, { continuityRoot: root1, height: 4, closureCommit: C }),
      paid,
    );
    const bobD = destForLogin(bob.address, { continuityRoot: root1, height: 3, closureCommit: C });
    assert.notEqual(paid, bobD);
    const otherV = viewSecretFromPassword('wrong-horse', salt);
    assert.notEqual(
      destForLogin(alice.address, { continuityRoot: root1, height: 3, viewKey: otherV }),
      paid,
    );
    assert.equal(destForLogin(paid), paid);
  });

  it('view key opens only that user’s dests', () => {
    const alice = newIdentity();
    const bob = newIdentity();
    const rounds = [
      { continuityRoot: EMPTY_ROOT, height: 1 },
      { continuityRoot: Buffer.alloc(32, 7), height: 2 },
    ];
    const paid = destForLogin(alice.address, { ...rounds[0], viewKey: alice.viewKey });
    assert.deepEqual(destsForViewKey('', alice.address, rounds, { ownerViewKey: alice.viewKey }), []);
    const aliceDests = destsForViewKey(alice.viewKey, alice.address, rounds, { ownerViewKey: alice.viewKey });
    const bobDests = destsForViewKey(bob.viewKey, bob.address, rounds, { ownerViewKey: bob.viewKey });
    assert.equal(aliceDests[0], paid);
    assert.equal(aliceDests.length, 2);
    assert.ok(aliceDests.every(isDestAddress));
    assert.ok(aliceDests.every((d, i) => d !== bobDests[i]));
    assert.deepEqual(destsForViewKey(bob.viewKey, alice.address, rounds, { ownerViewKey: alice.viewKey }), []);
  });

  it('Reserve vault dest is stable she1, not rest-frame, not round dest', () => {
    const id = newIdentity();
    const opts = { viewKey: id.viewKey, height: 1 };
    const vault = vaultDest(id.address, opts);
    const round = destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
    assert.equal(isDestAddress(vault), true);
    assert.notEqual(vault, id.address);
    assert.notEqual(vault, round);
    assert.equal(reserveRejectsDest(id.address, round, opts), true);
    assert.equal(reserveRejectsDest(id.address, id.address, opts), true);
    assert.equal(spendHashFromAddress(id.address).length, 20);
  });

  it('memo seals to dest; public explorer row is boolean only', () => {
    const id = newIdentity();
    const dest = destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
    const env = memoSeal(dest, 'hello flow');
    assert.equal(memoOpen(dest, env), 'hello flow');
    const other = destForLogin(id.address, { viewKey: id.viewKey, height: 2 });
    assert.notEqual(memoOpen(other, env), 'hello flow');
    const pub = explorerRowPublic({ to: dest, amount: 1, memoCt: env, memoPlain: 'hello flow' });
    assert.equal(pub.memo, true);
    assert.equal(pub.memoCt, undefined);
    assert.equal(pub.memoPlain, undefined);
    assert.equal(explorerRowPublic({ to: dest, amount: 1 }).memo, false);
  });
});

describe('vortex keys', () => {
  it('Reserve is default; creator key adds a third-party vortice that cannot mint', () => {
    assert.equal(RESERVE_VORTICE.id, 'shear-reserve-v1');
    assert.equal(RESERVE_VORTICE.name, 'The Reserve');
    assert.equal(issueVorticeKey('shear-reserve-v1'), null);
    const key = issueVorticeKey('stake-pool-a');
    assert.ok(key);
    const parsed = parseVorticeKey(key);
    assert.equal(parsed.id, 'stake-pool-a');
    assert.equal(extraMintAllowed(parsed.id), false);
    assert.equal(parseVorticeKey('deadbeef.stake-pool-a'), null);
    const list = addVortice([], key);
    assert.equal(list.length, 1);
    assert.equal(addVortice(list, key).length, 1);
  });
});
