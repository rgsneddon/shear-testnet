/**
 * The four supply walks replay the vault at the same height.
 *
 * foldSupply and supplyStep replay a block that omits height at i+1.
 * fillSnapInterest and auditCirculatingSupply must do the same: a lock
 * replayed at height 0 sits on a period start and records no arrival stub,
 * so its later withdraw receipt (π plus the stub at height 1) would not open
 * there, and snap fill and the audit would refuse a chain the fold accepts.
 *
 * The chain here carries no height on any block. The lock is a real π vault
 * lock note; the withdraw opens it with a principal proof and a retire proof
 * signed by the portal owner, the same fixtures as test_interest_supply_v12.js.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { newIdentity } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { encodeHeader } from '../../crypto/header.js';
import { potSubsidyAt, MS_PER_DAY, EPOCH_DAYS_TESTNET } from '../../crypto/pot_sched.js';
import { PI_SHE_NANOS, MAGIC_TESTNET } from '../../crypto/asert.js';
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
import { auditCirculatingSupply, fillSnapInterest, foldSupply, vaultAfterBlock } from '../src/supply.js';

const GENESIS = 1_700_000_000_000;
const EPOCH_MS = EPOCH_DAYS_TESTNET * MS_PER_DAY;
const DRAW = GENESIS + EPOCH_MS + 1;

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

function potAt(ts) {
  return potSubsidyAt({ nowMs: ts, genesisMs: GENESIS, magic: MAGIC_TESTNET });
}

/** A pot block with no height field, as a wire block may arrive. */
function heightless(ts, miner, more) {
  const nanos = potAt(ts);
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
  return { header: header(ts), txs: [tx, ...(more || [])], shareBatch: [] };
}

function lockOf(miner, portal) {
  const tx = lockTx({ from: miner, to: portal, nanos: PI_SHE_NANOS, id: 'heights-lock' });
  const sealed = sealCoinbaseNote(PI_SHE_NANOS, { dest20: Buffer.alloc(20, 0x91), kind: 'pot' });
  const prev = tx.vin && tx.vin[0] ? tx.vin[0] : {};
  tx.vin = [{ ...prev, commit: sealed.commit, valueProof: sealed.valueProof, rangeProof: sealed.rangeProof }];
  const held = lockWitnessOf(tx);
  const stamp = lockUnlockOf({ genesisMs: GENESIS, magic: MAGIC_TESTNET }, GENESIS);
  const unlock = consensusUnlockPeriod(stamp.epoch);
  const scalar = randomScalar();
  const leaf = vaultLockNote(held.amount, scalar, held.blind, unlock);
  assert.ok(leaf, 'π leaf');
  tx.vaultLockNote = leaf.note;
  if (!attachLockEquality(tx)) throw new Error('lock equality');
  return { tx, leaf: { note: leaf.note, commit: leaf.note.subarray(32, 64), scalar, blind: held.blind, unlock } };
}

function drawOf(vault, leaf, portal, miner, nanos) {
  const tx = withdrawTx({ from: portal, to: miner, nanos, id: 'heights-draw' });
  const portalId = portalIdFromDest(portal);
  const proof = provePrincipalOpen(leaf.commit, PI_SHE_NANOS, leaf.blind, tx, portalId, vault.magic, leaf.unlock);
  assert.ok(proof, 'principal proof');
  tx.principalProof = proof;
  const period = chainPeriodIndex(vault, DRAW);
  const retire = proveLeafRetire({
    scalar: leaf.scalar,
    epochs: leafEpochsToBurn(vault, leaf.note.toString('hex'), period),
    leaf: leaf.note,
    txBind: txDigestV3(tx, vault.magic),
    unlockEpoch: period,
    magic: vault.magic,
  });
  if (retire) tx.retireProof = retire.proof;
  signWithdrawReward(tx, ownerFor(portal).key, {
    portalId,
    nanos: PI_SHE_NANOS,
    dest: withdrawSignedDest(tx, reserveAction(tx)),
    state: vault,
    nowMs: DRAW,
  });
  return tx;
}

describe('supply walks replay a heightless block at i+1', () => {
  it('the arrival stub, fold, snap fill, and audit agree on a heightless chain', () => {
    const miner = freshDest();
    const portal = freshDest();
    const lock = lockOf(miner, portal);
    const first = heightless(GENESIS, miner, [lock.tx]);
    assert.equal(first.height, undefined);

    // The parent vault as foldSupply builds it: block 0 replayed at height 1.
    const parent = vaultAfterBlock(null, { ...first, height: 1 }, [], { requireStakeReward: true, magic: MAGIC_TESTNET });
    assert.equal(parent.ok, true);
    const stub = leafStubNanos(parent.vault, [lock.leaf.commit.toString('hex')]);
    // A lock at height 1 is past its period start, so it earns a stub. At
    // height 0 the same lock earns none, which is what made the walks disagree.
    assert.ok(stub > 0n, 'height-1 lock earns an arrival stub');
    const atZero = vaultAfterBlock(null, first, [], { requireStakeReward: true, magic: MAGIC_TESTNET });
    assert.equal(atZero.ok, true);
    assert.notEqual(leafStubNanos(atZero.vault, [lock.leaf.commit.toString('hex')]), stub);

    const receipt = PI_SHE_NANOS + Number(stub);
    const second = heightless(DRAW, miner, [drawOf(parent.vault, lock.leaf, portal, miner, receipt)]);
    const plan = rewardCommitment(parent.vault, DRAW);
    if (plan.rows.length) second.txs[0].rewardRoot = plan.root;
    assert.equal(second.height, undefined);
    const chain = [first, second];

    const folded = foldSupply(chain, { genesisMs: GENESIS, magic: MAGIC_TESTNET });
    assert.equal(folded.ok, true, folded.reason);
    assert.equal(folded.state.mintedInterest, stub);
    assert.equal(folded.state.permittedInterest, stub);

    const rows = [{}, {}];
    const filled = fillSnapInterest(rows, chain);
    assert.equal(filled.ok, true, filled.reason);
    assert.equal(rows[0].mintedInterest, 0n);
    assert.equal(rows[1].mintedInterest, stub);
    assert.equal(rows[1].permittedInterest, stub);

    const audit = auditCirculatingSupply(chain);
    assert.equal(audit.status, 'verified', audit.reason);
    assert.equal(audit.extraMintNanos, Number(stub));
    assert.equal(audit.differenceNanos, 0);
    assert.equal(audit.vaultPrincipalNanos, 0);

    // The same chain with explicit heights gives the same answers.
    const named = chain.map((block, i) => ({ ...block, height: i + 1 }));
    const namedFold = foldSupply(named, { genesisMs: GENESIS, magic: MAGIC_TESTNET });
    assert.equal(namedFold.ok, true, namedFold.reason);
    assert.equal(namedFold.state.mintedInterest, folded.state.mintedInterest);
    const namedRows = [{}, {}];
    assert.equal(fillSnapInterest(namedRows, named).ok, true);
    assert.equal(namedRows[1].mintedInterest, rows[1].mintedInterest);
    const namedAudit = auditCirculatingSupply(named);
    assert.equal(namedAudit.status, 'verified', namedAudit.reason);
    assert.equal(namedAudit.extraMintNanos, audit.extraMintNanos);
    assert.equal(namedAudit.circulatingNanos, audit.circulatingNanos);
  });
});
