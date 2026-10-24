import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { newIdentity } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { encodeHeader } from '../../crypto/header.js';
import { potSubsidyAt, MS_PER_DAY, EPOCH_DAYS_TESTNET } from '../../crypto/pot_sched.js';
import { PI_SHE_NANOS, GENESIS_BPS, MAGIC_TESTNET } from '../../crypto/asert.js';
import { interestNanos } from '../../crypto/reserve_oracle.js';
import { sealCoinbaseNote, excessOf, randomScalar } from '../../crypto/note.js';
import {
  attachLockEquality,
  chainPeriodIndex,
  consensusUnlockPeriod,
  leafEpochsToBurn,
  leafStubNanos,
  lockUnlockOf,
  lockWitnessOf,
  portalIdFromDest,
  provePrincipalOpen,
  reserveAction,
  rewardCommitment,
  signWithdrawReward,
  withdrawSignedDest,
} from '../../crypto/reserve_vault.js';
import { lockTx, ownerFor, withdrawTx } from '../../crypto/owned_portal.js';
import { txDigestV3 } from '../../crypto/admit_v3.js';
import { proveLeafRetire, vaultLockNote } from '../../crypto/vault_reward_fs1.js';
import { coinbaseTx } from '../src/chain.js';
import { fillSnapInterest, foldSupply, supplyFromScalar, vaultAfterBlock } from '../src/supply.js';

const GENESIS = 1_700_000_000_000;
const EPOCH_MS = EPOCH_DAYS_TESTNET * MS_PER_DAY;
const DRAW = GENESIS + EPOCH_MS + 1;

function minerDest() {
  const id = newIdentity();
  return destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
}

function portalDest() {
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

function potAt(ts) {
  return potSubsidyAt({ nowMs: ts, genesisMs: GENESIS, magic: MAGIC_TESTNET });
}

// Every block names its height, as a store or wire block does. foldSupply
// and supplyStep replay the vault at i+1 when a block omits it; vaultAfterBlock,
// fillSnapInterest, and the audit replay it at 0, which records a different
// arrival stub for the lock.
function blockAt(ts, miner, notes, moreTxs, height = 1) {
  const potNotes = notes.filter((n) => n.kind === 'pot');
  const shares = potNotes.map((n) => ({
    address: n.address || miner,
    nanos: n.nanos,
    kind: 'pot',
  }));
  const tx = coinbaseTx({
    height: 1,
    miner,
    potShares: shares,
    potNanos: shares.reduce((a, s) => a + s.nanos, 0),
    carryNanos: 0,
    shareBatch: [],
  });
  tx.vout = (tx.vout || []).filter((o) => String(o?.kind || '') !== 'hash');
  tx.excess = excessOf(tx.vout);
  if (!tx.vout.length) tx.excess = excessOf([]);
  return {
    height,
    header: header(ts),
    txs: [tx, ...(moreTxs || [])],
    shareBatch: [],
  };
}

function potBlock(ts, miner, more, height = 1) {
  return blockAt(ts, miner, [{ nanos: potAt(ts), kind: 'pot' }], more, height);
}

// Since d5529d81 a lock with no vaultLockNote is stake_reward, and only a π
// leaf can carry one; since ac3951ea a withdraw needs the portal's recorded
// owner. The lock is a π vault lock note bound by its equality proof, and the
// withdraw opens that leaf with a principal proof and a retire proof, signed
// by the portal owner over the receipt dest20 (a5760821). The receipt is π
// plus the leaf's arrival stub (cfe93bf5), which supply counts as minted
// interest. Same construction as test_interest_spread_v12.js (f2256d29).
function lockOf(miner, portal, stake, id, at = GENESIS) {
  const tx = lockTx({ from: miner, to: portal, nanos: stake, id });
  const sealed = sealCoinbaseNote(stake, { dest20: Buffer.alloc(20, 0x91), kind: 'pot' });
  const prev = tx.vin && tx.vin[0] ? tx.vin[0] : {};
  tx.vin = [{
    ...prev,
    commit: sealed.commit,
    valueProof: sealed.valueProof,
    rangeProof: sealed.rangeProof,
  }];
  const held = lockWitnessOf(tx);
  const stamp = lockUnlockOf({ genesisMs: GENESIS, magic: MAGIC_TESTNET }, at);
  const unlock = consensusUnlockPeriod(stamp.epoch);
  const scalar = randomScalar();
  const leaf = vaultLockNote(held.amount, scalar, held.blind, unlock);
  assert.ok(leaf, `${id} π leaf`);
  tx.vaultLockNote = leaf.note;
  if (!attachLockEquality(tx)) throw new Error(`lock equality ${id}`);
  return {
    tx,
    leaf: {
      note: leaf.note,
      commit: leaf.note.subarray(32, 64),
      scalar,
      blind: held.blind,
      unlock,
    },
  };
}

/** Vault after `blocks`, replayed as snap fill replays it. */
function vaultAfter(blocks) {
  let vault = null;
  for (let i = 0; i < blocks.length; i += 1) {
    const got = vaultAfterBlock(vault, blocks[i], blocks.slice(0, i), {
      requireStakeReward: true,
      magic: MAGIC_TESTNET,
    });
    assert.equal(got.ok, true, `vault replay ${i}`);
    vault = got.vault;
  }
  return vault;
}

/** The exact receipt: π plus the arrival stub, against the parent vault. */
function drawOf(state, leaf, portal, miner, id, nowMs = DRAW) {
  const stub = leafStubNanos(state, [leaf.commit.toString('hex')]);
  const tx = withdrawTx({ from: portal, to: miner, nanos: PI_SHE_NANOS + Number(stub), id });
  const portalId = portalIdFromDest(portal);
  const proof = provePrincipalOpen(leaf.commit, PI_SHE_NANOS, leaf.blind, tx, portalId, state.magic, leaf.unlock);
  assert.ok(proof, `${id} principal proof`);
  tx.principalProof = proof;
  const period = chainPeriodIndex(state, nowMs);
  const retire = proveLeafRetire({
    scalar: leaf.scalar,
    epochs: leafEpochsToBurn(state, leaf.note.toString('hex'), period),
    leaf: leaf.note,
    txBind: txDigestV3(tx, state.magic),
    unlockEpoch: period,
    magic: state.magic,
  });
  if (retire) tx.retireProof = retire.proof;
  signWithdrawReward(tx, ownerFor(portal).key, {
    portalId,
    nanos: PI_SHE_NANOS,
    dest: withdrawSignedDest(tx, reserveAction(tx)),
    state,
    nowMs,
  });
  return { tx, stub };
}

function snapOf(state) {
  return supplyFromScalar({
    height: state.height,
    blockHash: state.blockHash,
    schedulePot: state.schedulePot,
    carry: state.carry,
    mintedPot: state.mintedPot,
    mintedHash: state.mintedHash,
    mintedLevy: state.mintedLevy,
    bLocked: state.bLocked,
    permittedHashAll: state.permittedHashAll,
    acceptedHash: state.acceptedHash,
    dust: state.dust,
    overflow: state.overflow,
    liveUnit: state.liveUnit,
    genesisMs: state.genesisMs,
  }, { owedKnown: true });
}

describe('VS-1 snap interest', () => {
  it('a 12-u64 snap is zero until the vault walk, which matches the fold', () => {
    const stake = PI_SHE_NANOS;
    const one = interestNanos(stake, GENESIS_BPS);
    assert.ok(one > 0);
    const miner = minerDest();
    const portal = portalDest();
    const lock = lockOf(miner, portal, stake, 'lock-snap');
    const first = potBlock(GENESIS, miner, [lock.tx]);
    const parent = vaultAfter([first]);
    const draw = drawOf(parent, lock.leaf, portal, miner, 'draw-snap');
    const second = potBlock(DRAW, miner, [draw.tx], 2);
    const plan = rewardCommitment(parent, DRAW);
    if (plan.rows.length) second.txs[0].rewardRoot = plan.root;
    const chain = [first, second];

    const folded = foldSupply(chain, { genesisMs: GENESIS });
    assert.equal(folded.ok, true, folded.reason);
    // The withdraw mints only the arrival stub, never the epoch interest.
    assert.equal(folded.state.mintedInterest, draw.stub);
    assert.equal(folded.state.permittedInterest, draw.stub);

    // The full state keeps its interest when carried.
    const kept = supplyFromScalar(folded.state, { owedKnown: true });
    assert.equal(kept.mintedInterest, folded.state.mintedInterest);
    assert.equal(kept.permittedInterest, folded.state.permittedInterest);

    const prefix = foldSupply([first], { genesisMs: GENESIS });
    assert.equal(prefix.ok, true, prefix.reason);
    const whole = foldSupply(chain, { genesisMs: GENESIS });
    assert.equal(whole.ok, true, whole.reason);
    const rows = [snapOf(prefix.state), snapOf(whole.state)];
    // The 12-u64 snap carries no interest field, so it reads zero.
    assert.equal(rows[0].mintedInterest, 0n);
    assert.equal(rows[0].permittedInterest, 0n);
    assert.equal(rows[1].mintedInterest, 0n);
    assert.equal(rows[1].permittedInterest, 0n);
    const filled = fillSnapInterest(rows, chain);
    assert.equal(filled.ok, true, filled.reason);
    // The vault walk fills each row with the fold of its prefix.
    assert.equal(rows[0].mintedInterest, prefix.state.mintedInterest);
    assert.equal(rows[0].permittedInterest, prefix.state.permittedInterest);
    assert.equal(rows[0].mintedInterest, 0n);
    assert.equal(rows[1].mintedInterest, whole.state.mintedInterest);
    assert.equal(rows[1].permittedInterest, whole.state.permittedInterest);
    assert.equal(rows[1].mintedInterest, draw.stub);
  });
});
