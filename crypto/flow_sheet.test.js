import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import {
  newIdentity, isShearAddress, isDestAddress, isPaymentCode, encodeHrp, encodeAddress,
  paymentCodeAtIndex, silentDestFromView,
} from './address.js';
import { EMPTY_ROOT } from './merkle.js';
import {
  destForLogin,
  destAtIndex,
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
  destEncodings,
} from './flow_sheet.js';
import { issueVorticeKey, parseVorticeKey, addVortice, RESERVE_VORTICE, JOIN_VORTICE } from './vortex.js';
import { extraMintAllowed, JOIN_PROGRAM } from './asert.js';

describe('flow sheets', () => {
  it('paid dest is ssa1, needs password C, not C-from-S', () => {
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
    assert.equal(paid.startsWith('ssa1'), true);
    assert.equal(paid.startsWith('she1'), false);
    assert.equal(paid.startsWith('shear1'), false);
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
    const she = encodeHrp('she', spendHashFromAddress(alice.address));
    assert.equal(isDestAddress(she), false);
    assert.equal(isPaymentCode(alice.paymentCode), true);
    assert.equal(isDestAddress(alice.paymentCode), false);
    const shePay = destForLogin(alice.paymentCode, { closureCommit: C, height: 3 });
    assert.equal(isDestAddress(shePay), true);
    assert.equal(shePay.startsWith('ssa1'), true);
    assert.equal(shePay.startsWith('she1'), false);
    assert.notEqual(shePay, alice.paymentCode);
    assert.equal(isDestAddress(encodeAddress(spendHashFromAddress(alice.address))), false);
  });

  it('indexed she1 dests are unlimited, regenerable, and tied to shear1 + C', () => {
    const alice = newIdentity();
    const bob = newIdentity();
    const C = closureCommit(alice.viewKey);
    assert.equal(destAtIndex(alice.address, { index: 0 }), null);
    const d0 = destAtIndex(alice.address, { index: 0, closureCommit: C });
    const d1 = destAtIndex(alice.address, { index: 1, viewKey: alice.viewKey });
    const d2 = destAtIndex(alice.address, { index: 2, viewKey: alice.viewKey });
    assert.equal(d0.startsWith('ssa1'), true);
    assert.equal(d0.startsWith('she1'), false);
    assert.equal(isDestAddress(d0), true);
    assert.notEqual(d0, alice.address);
    assert.notEqual(d0, d1);
    assert.notEqual(d1, d2);
    assert.equal(destAtIndex(alice.address, { index: 0, viewKey: alice.viewKey }), d0);
    assert.equal(destAtIndex(alice.address, { index: 1, closureCommit: C }), d1);
    assert.notEqual(destAtIndex(bob.address, { index: 0, viewKey: bob.viewKey }), d0);
    assert.notEqual(destAtIndex(alice.address, { index: 0, viewKey: bob.viewKey }), d0);
    const both = destEncodings(spendHashFromAddress(alice.address));
    assert.equal(both.every((a) => a.startsWith('ssa1')), true);
    assert.equal(destAtIndex(alice.address, { index: -1, viewKey: alice.viewKey }), null);
    const s = spendHashFromAddress(alice.address);
    const p0 = paymentCodeAtIndex(alice.viewKey, s, 0);
    const p1 = paymentCodeAtIndex(alice.viewKey, s, 1);
    const p2 = paymentCodeAtIndex(alice.viewKey, s, 2);
    assert.equal(p0, alice.paymentCode);
    assert.equal(isPaymentCode(p0), true);
    assert.equal(isDestAddress(p0), false);
    assert.notEqual(p0, p1);
    assert.notEqual(p1, p2);
    assert.equal(paymentCodeAtIndex(alice.viewKey, s, 1), p1);
    const { privateKey: eph } = generateKeyPairSync('x25519');
    const silent = silentDestFromView(alice.viewKey, s, eph, 0);
    assert.equal(isDestAddress(silent), true);
    assert.equal(silent.startsWith('ssa1'), true);
    assert.ok(p0.length < 50, p0);
    assert.notEqual(p0.slice(4), encodeAddress(s).slice(6));
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

  it('Reserve vault dest is stable ssa1, not rest-frame, not round dest', () => {
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
    const pub = explorerRowPublic({ to: dest, amount: 1, height: 1, id: 'x', memoCt: env, memoPlain: 'hello flow' });
    assert.equal(pub.memo, true);
    assert.equal(pub.to, undefined);
    assert.equal(pub.from, undefined);
    assert.equal(pub.memoCt, undefined);
    assert.equal(pub.memoPlain, undefined);
    assert.equal(pub.amount, 1);
    assert.equal(pub.id, 'x');
    assert.equal(explorerRowPublic({ to: dest, amount: 1 }).memo, false);
  });
});

describe('vortex keys', () => {
  it('Reserve is default; creator deploy key names a host and cannot mint', () => {
    assert.equal(RESERVE_VORTICE.id, 'shear-reserve-v1');
    assert.equal(RESERVE_VORTICE.name, 'The Reserve');
    assert.equal(JOIN_VORTICE.id, JOIN_PROGRAM);
    assert.equal(JOIN_VORTICE.name, 'The Join');
    const origin = 'https://dapp.example/stake-pool-a.json';
    const source = '{"id":"stake-pool-a"}';
    assert.equal(issueVorticeKey('shear-reserve-v1', origin, source), null);
    assert.equal(issueVorticeKey(JOIN_PROGRAM, origin, source), null);
    assert.equal(issueVorticeKey('stake-pool-a'), null);
    const key = issueVorticeKey('stake-pool-a', origin, source);
    assert.ok(key);
    const parsed = parseVorticeKey(key);
    assert.equal(parsed.id, 'stake-pool-a');
    assert.equal(parsed.origin, origin);
    assert.equal(extraMintAllowed(parsed.id), false);
    assert.equal(parseVorticeKey('deadbeef.stake-pool-a'), null);
    assert.equal(addVortice([], key).length, 0);
    const list = addVortice([], key, source);
    assert.equal(list.length, 1);
    assert.equal(addVortice(list, key, source).length, 1);
  });
});
