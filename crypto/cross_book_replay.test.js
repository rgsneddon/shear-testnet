/**
 * Cross-book replay (WH P1-6). A signature made for one book is refused on
 * every other book, in both directions, shear-dev included.
 *
 * shear-testnet-v12 and shear-v1 share EVM chain id 2701, so between them the
 * magic word is what refuses a replay. shear-dev binds its own chain id 2799
 * and its own magic.
 *
 * Fails on b3efdc26: crypto/chain_params.js and withdrawChainId do not
 * exist, and withdrawBinding stamps chain id 2701 on a shear-dev vault, so a
 * dev withdraw signature is bound to the public chain id.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { MAGIC_DEV, evmChainIdFor } from './chain_params.js';
import { MAGIC_TESTNET, MAGIC_MAINNET } from './asert.js';
import {
  withdrawBinding, withdrawChainId, withdrawOwnerMessage, reserveMagicBytes,
  signRewardAuth, verifyRewardAuth,
} from './reserve_vault.js';
import { lockOwnerMessage } from './reserve_evm.js';
import { txDigestV3 } from './admit_v3.js';
import { poolWithdrawDigest } from './eip712.js';
import { ed25519RawPub } from './address.js';

const BOOKS = [MAGIC_TESTNET, MAGIC_MAINNET, MAGIC_DEV];
const PAIRS = BOOKS.flatMap((a) => BOOKS.filter((b) => b !== a).map((b) => [a, b]));
const PID = 'ab'.repeat(32);
const GENESIS = 1_700_000_000_000;

function key() {
  return generateKeyPairSync('ed25519').privateKey;
}

function vaultOf(magic) {
  return { magic, genesisMs: GENESIS, epochStartMs: GENESIS, portals: {} };
}

function withdrawMsg(magic) {
  const state = vaultOf(magic);
  const bind = withdrawBinding(state, { tranches: [] }, GENESIS + 1000);
  return withdrawOwnerMessage({
    nullifier: PID,
    nanos: 3_141_592_653n,
    dest: 'ab'.repeat(20),
    magic: bind.magic,
    chainId: bind.chainId,
    epoch: bind.epoch,
    trancheSet: bind.trancheSet,
  });
}

test('chain ids: v12 and shear-v1 stay 2701, shear-dev is 2799', () => {
  assert.equal(withdrawChainId(MAGIC_TESTNET), 2701n);
  assert.equal(withdrawChainId(MAGIC_MAINNET), 2701n);
  assert.equal(withdrawChainId(MAGIC_DEV), 2799n);
  assert.equal(evmChainIdFor(MAGIC_TESTNET), 2701);
  assert.equal(evmChainIdFor(MAGIC_MAINNET), 2701);
  assert.equal(evmChainIdFor(MAGIC_DEV), 2799);
  assert.equal(withdrawBinding(vaultOf(MAGIC_DEV), { tranches: [] }, GENESIS + 1).chainId, 2799n);
  assert.equal(withdrawBinding(vaultOf(MAGIC_TESTNET), { tranches: [] }, GENESIS + 1).chainId, 2701n);
  assert.equal(withdrawBinding(vaultOf(MAGIC_MAINNET), { tranches: [] }, GENESIS + 1).chainId, 2701n);
});

test('a withdraw owner signature for one book does not verify on another', () => {
  for (const [a, b] of PAIRS) {
    const k = key();
    const pub = ed25519RawPub(k).toString('hex');
    const msgA = withdrawMsg(a);
    const msgB = withdrawMsg(b);
    assert.ok(msgA && msgB);
    const sig = signRewardAuth(msgA, k);
    assert.equal(verifyRewardAuth(msgA, pub, sig), true, `${a} on ${a}`);
    assert.equal(verifyRewardAuth(msgB, pub, sig), false, `${a} replayed on ${b}`);
  }
});

test('a lock owner signature for one book does not verify on another', () => {
  const commit = Buffer.alloc(32, 7);
  const id = Buffer.from(PID, 'hex');
  for (const [a, b] of PAIRS) {
    const k = key();
    const pub = ed25519RawPub(k).toString('hex');
    const msgA = lockOwnerMessage(id, commit, reserveMagicBytes(a), BigInt(evmChainIdFor(a)));
    const msgB = lockOwnerMessage(id, commit, reserveMagicBytes(b), BigInt(evmChainIdFor(b)));
    const sig = signRewardAuth(msgA, k);
    assert.equal(verifyRewardAuth(msgA, pub, sig), true);
    assert.equal(verifyRewardAuth(msgB, pub, sig), false, `${a} lock replayed on ${b}`);
  }
});

test('the FS-1 tx digest and the pool-withdraw domain differ per book', () => {
  const tx = { kind: 'send', anchor: 5, fee: 100, vin: [{ commit: 'cd'.repeat(32) }], vout: [] };
  for (const [a, b] of PAIRS) {
    assert.notDeepEqual(txDigestV3(tx, a), txDigestV3(tx, b), `txd ${a}/${b}`);
    const fields = { login: 'she1x', dest: 'ssa1y', nanos: 1, height: 2, nonce: 3, deadline: 4 };
    assert.notDeepEqual(poolWithdrawDigest({ ...fields, chainId: a }), poolWithdrawDigest({ ...fields, chainId: b }));
  }
});
