/**
 * The vault the reorg and supply-carry paths rebuild is the book's vault.
 *
 * A note lock's π proof (fundProof) binds txDigestV3 at the book magic, and
 * applyReserveBlock refuses a lock whose leaves do not all prove π (2461ec67).
 * vaultBefore started from emptyVault(), whose magic is testnet, and store.js
 * called vaultParent and vaultAfterBlock with no magic. On a mainnet, regtest
 * or shear-dev book that rebuilt vault refused an honest note lock, so a reorg
 * above one failed as `supply` while the live vault, at the book magic,
 * accepted the same block: two honest nodes could part at the first orphan
 * race (Protocol lane, C1, PR 130). Testnet hid it: its fallback is itself.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { newIdentity } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { encodeHeader } from '../../crypto/header.js';
import { potSubsidyAt } from '../../crypto/pot_sched.js';
import { PI_SHE_NANOS, MAGIC_TESTNET } from '../../crypto/asert.js';
import { MAGIC_REGTEST } from '../../crypto/regtest_bits.js';
import { sealCoinbaseNote, excessOf, randomScalar } from '../../crypto/note.js';
import {
  attachLockEquality,
  consensusUnlockPeriod,
  lockNotePrincipal,
  lockUnlockOf,
  lockWitnessOf,
} from '../../crypto/reserve_vault.js';
import { lockTx } from '../../crypto/owned_portal.js';
import { vaultLockNote } from '../../crypto/vault_reward_fs1.js';
import { coinbaseTx } from '../src/chain.js';
import { vaultAfterBlock, vaultBefore, vaultParent } from '../src/supply.js';

const GENESIS = 1_700_000_000_000;
const PI = BigInt(PI_SHE_NANOS);

function freshDest() {
  const id = newIdentity();
  return destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
}

function header(ts) {
  return encodeHeader({
    prevBlockHash: Buffer.alloc(32),
    merkleRoot: Buffer.alloc(32),
    continuityRoot: Buffer.alloc(32),
    timestamp: ts,
    bits: 16,
  });
}

function potBlock(ts, miner, more, height, magic) {
  const nanos = potSubsidyAt({ nowMs: ts, genesisMs: GENESIS, magic });
  const tx = coinbaseTx({
    height: 1,
    miner,
    potShares: [{ address: miner, nanos, kind: 'pot' }],
    potNanos: nanos,
    carryNanos: 0,
    shareBatch: [],
  });
  tx.vout = (tx.vout || []).filter((o) => String(o?.kind || '') !== 'hash');
  tx.excess = excessOf(tx.vout);
  return { height, header: header(ts), txs: [tx, ...(more || [])], shareBatch: [] };
}

/** An honest π note lock, its fundProof proved at `magic`, as a wallet on that book sends it. */
function lockAt(miner, magic, id) {
  const tx = lockTx({ from: miner, to: freshDest(), nanos: PI_SHE_NANOS, id });
  const sealed = sealCoinbaseNote(PI_SHE_NANOS, { dest20: Buffer.alloc(20, 0x91), kind: 'pot' });
  const prev = tx.vin && tx.vin[0] ? tx.vin[0] : {};
  tx.vin = [{ ...prev, commit: sealed.commit, valueProof: sealed.valueProof, rangeProof: sealed.rangeProof }];
  const held = lockWitnessOf(tx);
  const stamp = lockUnlockOf({ genesisMs: GENESIS, magic }, GENESIS);
  const leaf = vaultLockNote(held.amount, randomScalar(), held.blind, consensusUnlockPeriod(stamp.epoch));
  assert.ok(leaf, `${id} π leaf`);
  tx.vaultLockNote = leaf.note;
  if (!attachLockEquality(tx, magic)) throw new Error(`lock equality ${id}`);
  return tx;
}

describe('the vault rebuilt for a reorg or a supply carry is at the book magic', () => {
  it('rebuilds a regtest book above an honest note lock, which a testnet-magic rebuild refused', () => {
    const miner = freshDest();
    const lock = lockAt(miner, MAGIC_REGTEST, 'regtest-lock');
    // The π proof is bound to the regtest digest, not the testnet one.
    assert.equal(lockNotePrincipal(lock, MAGIC_REGTEST), PI);
    assert.equal(lockNotePrincipal(lock, MAGIC_TESTNET), 0n);
    const first = potBlock(GENESIS, miner, [lock], 1, MAGIC_REGTEST);
    const second = potBlock(GENESIS + 90_000, miner, [], 2, MAGIC_REGTEST);
    const chain = [first, second];
    // The reorg path's parent vault (vaultParent) above the lock, at the book magic.
    const parent = vaultParent(chain, 1, MAGIC_REGTEST);
    assert.equal(parent.ok, true, 'regtest rebuild above the lock');
    assert.equal(parent.vault.magic, MAGIC_REGTEST);
    assert.equal((parent.vault.vaultLockNotes || []).length, 1, 'the leaf is indexed');
    assert.equal(BigInt(parent.vault.openedLockNanos || 0), PI, 'π booked');
    // The supply carry's step (vaultAfterBlock) applies the lock at the book magic.
    const stepped = vaultAfterBlock(null, first, [], { magic: MAGIC_REGTEST });
    assert.equal(stepped.ok, true, 'regtest step applies the lock');
    // What the old code did: the rebuild at the testnet fallback refuses it.
    assert.equal(vaultParent(chain, 1).ok, false, 'testnet-magic rebuild refuses the honest regtest lock');
    assert.equal(vaultBefore(chain, 1), null);
    assert.equal(vaultAfterBlock(null, first).ok, false);
  });

  it('leaves a testnet book byte-identical: the default is the testnet magic', () => {
    const miner = freshDest();
    const lock = lockAt(miner, MAGIC_TESTNET, 'testnet-lock');
    const chain = [potBlock(GENESIS, miner, [lock], 1, MAGIC_TESTNET), potBlock(GENESIS + 90_000, miner, [], 2, MAGIC_TESTNET)];
    const named = vaultParent(chain, 1, MAGIC_TESTNET);
    const fallback = vaultParent(chain, 1);
    assert.equal(named.ok, true);
    assert.equal(fallback.ok, true);
    const view = (v) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? `${x}n` : x));
    assert.equal(view(named.vault), view(fallback.vault));
  });

  it('store.js passes the book magic to every vault rebuild on the reorg and supply-carry paths', () => {
    const src = fs.readFileSync(new URL('../src/store.js', import.meta.url), 'utf8');
    const parents = src.match(/vaultParent\([^)]*\)/g) || [];
    const steps = src.match(/vaultAfterBlock\([^;]*\);/g) || [];
    assert.ok(parents.length >= 3, `vaultParent calls ${parents.length}`);
    assert.ok(steps.length >= 3, `vaultAfterBlock calls ${steps.length}`);
    for (const call of parents) assert.match(call, /, bookMagic\)$/, call);
    for (const call of steps) assert.match(call, /magic: bookMagic/, call);
  });

  it('every supply fold names its magic: the resume load in store.js and the parents in chain.js', () => {
    // foldSupply replays the vault at opts.magic || MAGIC_TESTNET, so a fold
    // with no magic refuses an honest note lock on any other book.
    const store = fs.readFileSync(new URL('../src/store.js', import.meta.url), 'utf8');
    const chain = fs.readFileSync(new URL('../src/chain.js', import.meta.url), 'utf8');
    const storeFolds = store.match(/foldSupply\([^)]*\)/g) || [];
    const chainFolds = chain.match(/foldSupply\([^)]*\)/g) || [];
    assert.ok(storeFolds.length >= 1, `store.js foldSupply calls ${storeFolds.length}`);
    assert.ok(chainFolds.length >= 2, `chain.js foldSupply calls ${chainFolds.length}`);
    for (const call of storeFolds) assert.match(call, /magic: bookMagic/, call);
    for (const call of chainFolds) assert.match(call, /\{ magic,/, call);
  });
});
