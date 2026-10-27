/**
 * A withdraw receipt opens to principal plus the leaf's arrival stub.
 * Interest is not minted on withdraw (it waits for the ZK claim). Snap fill
 * and the supply step both reject a note that is not that receipt.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newIdentity, hash20FromAddress } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { encodeHeader, decodeHeader } from '../../crypto/header.js';
import { merkleRoot } from '../../crypto/merkle.js';
import {
  potSubsidyAt,
  MS_PER_DAY,
  EPOCH_DAYS_TESTNET,
  joinCutoffMs,
} from '../../crypto/pot_sched.js';
import {
  PI_SHE_NANOS,
  GENESIS_BPS,
  MAGIC_TESTNET,
  HASH_BONUS_NANOS,
  HASH_BONUS_NANOS_FLOOR,
} from '../../crypto/asert.js';
import { interestNanos } from '../../crypto/reserve_oracle.js';
import { sealCoinbaseNote, addExcess, excessOf, randomScalar } from '../../crypto/note.js';
import { reserveFeeDest } from '../../crypto/levy.js';
import {
  voteTx,
  reserveAction,
  cloneVault,
  VOTE_DECREASE,
  blockWithdrawInterest,
  blockPermittedInterest,
  attachLockEquality,
  provePrincipalOpen,
  lockWitnessOf,
  portalIdFromDest,
  applyReserveBlock,
  chainPeriodIndex,
  consensusUnlockPeriod,
  emptyVault,
  leafEpochsToBurn,
  leafStubNanos,
  lockUnlockOf,
  rewardCommitment,
  signWithdrawReward,
  withdrawSignedDest,
} from '../../crypto/reserve_vault.js';
import { lockTx, ownerFor, withdrawTx } from '../../crypto/owned_portal.js';
import { txDigestV3 } from '../../crypto/admit_v3.js';
import { proveLeafRetire, vaultLockNote } from '../../crypto/vault_reward_fs1.js';
import { explicitTypedKindRejected, boundReserveWithdraw } from '../../crypto/spend.js';
import { compactTx, reserveNanosRejected } from '../../crypto/chronoflux.js';
import { walletAnchor, checkAdmitAnchor } from '../../crypto/admit_v3.js';
import { coinbaseTx, verifyBlock, digestTx } from '../src/chain.js';
import { createStore } from '../src/store.js';
import {
  auditCirculatingSupply,
  fillSnapInterest,
  foldSupply,
  supplyStep,
  vaultAfterBlock,
} from '../src/supply.js';

const GENESIS = 1_700_000_000_000;
const EPOCH_MS = EPOCH_DAYS_TESTNET * MS_PER_DAY;
const DRAW = GENESIS + EPOCH_MS + 1;
const U64 = 0xffffffffffffffffn;
const ABOVE_SAFE = 2n ** 53n;

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

// Every block names its height, as a store or wire block does. The fold, the
// supply step, the snap fill and the audit all replay a block that omits it at
// i+1 (test_supply_walk_heights_v12 pins that they agree).
// A lock at height 0 is on a period start (stub 0); at height 1 it earns an
// arrival stub.
function blockAt(ts, miner, notes, moreTxs, observe, height = 1) {
  const potNotes = notes.filter((n) => n.kind !== 'finder-fee' && n.kind !== 'reserve-fee' && n.kind !== 'hash');
  const shares = potNotes.map((n) => ({
    address: n.address || miner,
    nanos: n.nanos,
    kind: n.kind || 'pot',
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
  const rest = notes.filter((n) => n.kind === 'finder-fee' || n.kind === 'reserve-fee' || n.kind === 'hash');
  for (const n of rest) {
    const sealed = sealCoinbaseNote(n.nanos, {
      dest20: hash20FromAddress(n.address || miner),
      kind: n.kind,
    });
    tx.vout.push(sealed);
    tx.excess = addExcess(tx.excess, sealed.r);
  }
  if (observe) tx.observe = observe;
  return {
    height,
    header: header(ts),
    txs: [tx, ...(moreTxs || [])],
    shareBatch: [],
  };
}

function potBlock(ts, miner, more, observe, height = 1) {
  return blockAt(ts, miner, [{ nanos: potAt(ts), kind: 'pot' }], more, observe, height);
}

// Since d5529d81 a lock with no vaultLockNote is stake_reward, and only a π
// leaf can carry one. Each lock here is a π vault lock note bound by its
// equality proof. A withdraw opens that leaf with a principal proof and a
// retire proof, and the portal owner signs over the receipt dest20
// (withdrawSignedDest, a5760821). The receipt is π plus the leaf's arrival
// stub (cfe93bf5). Supply counts that stub as minted interest.
const LOCK_BY_PORTAL = new Map();
const LEAF_OF = new WeakMap();

function resetLocks() {
  LOCK_BY_PORTAL.clear();
}


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
  // A leaf note exists only for a π leaf. A non-π lock carries none and is refused.
  const leaf = vaultLockNote(held.amount, scalar, held.blind, unlock);
  if (leaf) {
    tx.vaultLockNote = leaf.note;
    LEAF_OF.set(tx, {
      note: leaf.note,
      commit: leaf.note.subarray(32, 64),
      scalar,
      blind: held.blind,
      unlock,
    });
  }
  if (!attachLockEquality(tx)) throw new Error(`lock equality ${id}`);
  const list = LOCK_BY_PORTAL.get(portal) || [];
  list.push({ tx, at, stake });
  LOCK_BY_PORTAL.set(portal, list);
  return tx;
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

/** The newest leaf of `portal` whose tranche has matured in `state` at `nowMs`, else its newest leaf. */
function leafFor(state, portal, nowMs) {
  const rows = [...(LOCK_BY_PORTAL.get(portal) || [])].reverse();
  const tranches = state?.portals?.[portalIdFromDest(portal)]?.tranches || [];
  const chain = Math.floor((Number(nowMs) - Number(state?.genesisMs || GENESIS)) / EPOCH_MS);
  for (const row of rows) {
    const leaf = LEAF_OF.get(row.tx);
    if (!leaf) continue;
    const hex = leaf.commit.toString('hex');
    const tranche = tranches.find((t) => String(t.commit) === hex);
    if (tranche && chain > Math.floor(Number(tranche.epoch) || 0)) return leaf;
  }
  for (const row of rows) {
    const leaf = LEAF_OF.get(row.tx);
    if (leaf) return leaf;
  }
  return null;
}

/** Arrival stub the matured leaf of `portal` earns. */
function stubFor(state, portal, nowMs = DRAW) {
  const leaf = leafFor(state, portal, nowMs);
  if (!state || !leaf) return 0n;
  return leafStubNanos(state, [leaf.commit.toString('hex')]);
}

/** π plus the arrival stub: the one receipt the vault pays. */
function dueFor(state, portal, nowMs = DRAW) {
  return PI_SHE_NANOS + Number(stubFor(state, portal, nowMs));
}

/**
 * A withdraw of `nanos` against the matured leaf of `portal` in `state`.
 * Fields in `extra` are set before the proofs, so the proofs bind them.
 */
function drawOf(state, portal, miner, nanos, id, { nowMs = DRAW, extra = null } = {}) {
  const tx = withdrawTx({ from: portal, to: miner, nanos, id });
  if (extra) Object.assign(tx, extra);
  const leaf = state ? leafFor(state, portal, nowMs) : null;
  if (!leaf) return tx;
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
  return tx;
}

/**
 * The next pot block after `prefix`. `make(vault)` builds its txs from the
 * parent vault. A coinbase commits the reward root when one is due.
 */
function nextBlock(prefix, ts, miner, make) {
  const vault = prefix.length ? vaultAfter(prefix) : null;
  const block = potBlock(ts, miner, make ? make(vault) : [], undefined, prefix.length + 1);
  if (vault) {
    const plan = rewardCommitment(vault, ts);
    if (plan.rows.length) block.txs[0].rewardRoot = plan.root;
  }
  return block;
}

/** Reason the parent vault gives `txs` alone at `nowMs`. */
function vaultReason(vault, txs, nowMs, action) {
  const state = cloneVault(vault);
  const applied = applyReserveBlock({ state, block: { txs: [{ coinbase: true, vout: [] }, ...txs] }, nowMs, genesisMs: GENESIS });
  const row = (applied || []).find((r) => r && r.action === action && r.ok === false);
  return row ? row.reason : '';
}

function foldOpts() {
  return { genesisMs: GENESIS, magic: MAGIC_TESTNET };
}

function expectSupplyReject(chain, label) {
  const snap = fillSnapInterest(chain.map(() => ({})), chain);
  assert.equal(snap.ok, false, `${label} snap ${snap.reason}`);
  assert.equal(snap.reason, 'supply', label);
  const folded = foldSupply(chain, foldOpts());
  assert.equal(folded.ok, false, `${label} fold ${folded.reason}`);
  assert.ok(folded.reason === 'supply' || folded.reason === 'epoch_open', `${label} fold ${folded.reason}`);
  const audit = auditCirculatingSupply(chain);
  assert.equal(audit.status, 'mismatch', label);
  assert.ok(audit.reason === 'supply' || audit.reason === 'epoch_open', `${label} ${audit.reason}`);
}

function expectVerified(chain, interest, label) {
  const snap = fillSnapInterest(chain.map(() => ({})), chain);
  assert.equal(snap.ok, true, `${label} snap ${snap.reason}`);
  const folded = foldSupply(chain, foldOpts());
  assert.equal(folded.ok, true, `${label} fold ${folded.reason}`);
  assert.equal(folded.state.mintedInterest, BigInt(interest), label);
  assert.equal(folded.state.permittedInterest, BigInt(interest), label);
  const audit = auditCirculatingSupply(chain);
  assert.equal(audit.status, 'verified', `${label} ${audit.reason}`);
  assert.equal(audit.extraMintNanos, interest, label);
}

describe('principal-only withdraw receipts', () => {
  it('accepts one, two, and many exact withdraws and rejects every deviation', () => {
    const counts = [1, 2, 4];
    const interest = interestNanos(PI_SHE_NANOS, GENESIS_BPS);
    assert.ok(interest > 1);
    const deltas = [
      { name: 'exact', delta: 0, ok: true },
      { name: 'small-plus', delta: 1, ok: false },
      { name: 'small-minus', delta: -1, ok: false },
      { name: 'large-plus', delta: PI_SHE_NANOS, ok: false },
      { name: 'large-minus', delta: -interest, ok: false },
    ];
    for (const count of counts) {
      for (const row of deltas) {
        const miner = minerDest();
        const portals = Array.from({ length: count }, () => portalDest());
        const locks = portals.map((portal, i) => lockOf(miner, portal, PI_SHE_NANOS, `L${count}-${row.name}-${i}`));
        const first = potBlock(GENESIS, miner, locks);
        const parent = vaultAfter([first]);
        let stubs = 0n;
        for (const portal of portals) stubs += stubFor(parent, portal);
        const draw = nextBlock([first], DRAW, miner, (vault) => portals.map((portal, i) => drawOf(
          vault,
          portal,
          miner,
          dueFor(vault, portal) + row.delta,
          `W${count}-${row.name}-${i}`,
        )));
        const label = `${count} ${row.name}`;
        if (row.ok) expectVerified([first, draw], Number(stubs), label);
        else expectSupplyReject([first, draw], label);
      }
    }
  });

  it('rejects an offsetting pair whose block total still matches the schedule', () => {
    const miner = minerDest();
    const a = portalDest();
    const b = portalDest();
    const first = potBlock(GENESIS, miner, [
      lockOf(miner, a, PI_SHE_NANOS, 'off-a'),
      lockOf(miner, b, PI_SHE_NANOS, 'off-b'),
    ]);
    const chain = [
      first,
      nextBlock([first], DRAW, miner, (vault) => [
        drawOf(vault, a, miner, dueFor(vault, a) + 5, 'off-wa'),
        drawOf(vault, b, miner, dueFor(vault, b) - 5, 'off-wb'),
      ]),
    ];
    expectSupplyReject(chain, 'offset');
    const parent = vaultAfterBlock(null, chain[0]);
    assert.equal(parent.ok, true);
    const minted = blockWithdrawInterest(parent.vault, chain[1], DRAW);
    const allowed = blockPermittedInterest(parent.vault, chain[1], DRAW);
    assert.equal(minted.ok, false);
    assert.equal(allowed.ok, false);
    assert.equal(minted.reason, 'supply');
  });

  it('pays zero interest on dust and the rounding boundary, and no stake on a last-quarter lock', () => {
    // Smallest stake whose floor(stake * bps / 10000) is 1, and the unit below it.
    // The schedule still computes that unit. A vault leaf is exactly π, so a
    // dust or a π-plus-boundary principal is not a receipt the vault pays.
    const boundary = Math.ceil(10000 / GENESIS_BPS);
    const dust = boundary - 1;
    assert.equal(interestNanos(dust, GENESIS_BPS), 0);
    assert.equal(interestNanos(boundary, GENESIS_BPS), 1);
    const miner = minerDest();
    const sponsor = portalDest();
    const low = portalDest();
    const edge = portalDest();
    const sponsorInterest = interestNanos(PI_SHE_NANOS, GENESIS_BPS);
    const edgeStake = PI_SHE_NANOS + boundary;
    const edgeInterest = interestNanos(edgeStake, GENESIS_BPS);
    assert.equal(edgeInterest, sponsorInterest + 1);
    // A dust lock has no π leaf note, so it never lands (d5529d81).
    const dustBlock = potBlock(GENESIS, miner, [lockOf(miner, low, dust, 'z-dust')]);
    assert.equal(vaultAfterBlock(null, dustBlock).ok, false);
    const blank = emptyVault();
    blank.magic = MAGIC_TESTNET;
    blank.genesisMs = GENESIS;
    assert.equal(vaultReason(blank, [dustBlock.txs[1]], GENESIS, 'lock'), 'stake_reward');
    const dustSnap = fillSnapInterest([{}], [dustBlock]);
    assert.equal(dustSnap.ok, false);
    assert.equal(dustSnap.reason, 'supply');
    // The π sponsor is paid π plus its stub and no interest.
    const sponsored = potBlock(GENESIS, miner, [lockOf(miner, sponsor, PI_SHE_NANOS, 'z-sponsor')]);
    const sponsorStub = stubFor(vaultAfter([sponsored]), sponsor);
    expectVerified([
      sponsored,
      nextBlock([sponsored], DRAW, miner, (vault) => [drawOf(vault, sponsor, miner, dueFor(vault, sponsor), 'z-ws')]),
    ], Number(sponsorStub), 'sponsor');
    // A receipt that asks the π-plus-boundary stake is refused.
    const edgeLock = potBlock(GENESIS, miner, [lockOf(miner, edge, edgeStake, 'z-edge')]);
    expectSupplyReject([
      edgeLock,
      potBlock(DRAW, miner, [drawOf(null, edge, miner, edgeStake, 'z-we')], undefined, 2),
    ], 'dust-boundary');

    const late = GENESIS + EPOCH_MS - joinCutoffMs(MAGIC_TESTNET) + 1000;
    assert.ok(late < GENESIS + EPOCH_MS);
    const idleMiner = minerDest();
    const parked = portalDest();
    const opened = potBlock(GENESIS, idleMiner, [lockOf(idleMiner, portalDest(), PI_SHE_NANOS, 'idle-open')]);
    const parkedLock = nextBlock([opened], late, idleMiner, () => [lockOf(idleMiner, parked, PI_SHE_NANOS, 'idle-lock', late)]);
    const atLate = vaultAfter([opened, parkedLock]);
    const parkedPortal = atLate.portals[portalIdFromDest(parked)];
    assert.equal(Number(parkedPortal.staked) + Number(parkedPortal.idle), 0);
    const idleStub = stubFor(atLate, parked);
    const idleChain = [
      opened,
      parkedLock,
      nextBlock([opened, parkedLock], DRAW, idleMiner, (vault) => [
        drawOf(vault, parked, idleMiner, dueFor(vault, parked), 'idle-draw'),
      ]),
    ];
    expectVerified(idleChain, Number(idleStub), 'idle');
  });

  it('keeps the genesis bps across epochs; an observe is not a rate', () => {
    const miner = minerDest();
    const first = portalDest();
    const second = portalDest();
    const stake = PI_SHE_NANOS;
    const observed = potBlock(GENESIS, miner, [lockOf(miner, first, stake, 'bps-obs')], {
      annualBps: 0,
      observedAtMs: GENESIS,
    });
    assert.equal(vaultAfterBlock(null, observed).ok, false);
    resetLocks();
    const chain = [potBlock(GENESIS, miner, [lockOf(miner, first, stake, 'bps-a')])];
    chain.push(nextBlock(chain, GENESIS + 1000, miner, () => []));
    const firstStub = stubFor(vaultAfter(chain), first);
    chain.push(nextBlock(chain, DRAW, miner, (vault) => [drawOf(vault, first, miner, dueFor(vault, first), 'bps-wa')]));
    chain.push(nextBlock(chain, GENESIS + 2 * EPOCH_MS, miner, () => [
      lockOf(miner, second, stake, 'bps-b', GENESIS + 2 * EPOCH_MS),
    ]));
    const third = GENESIS + 3 * EPOCH_MS;
    const secondStub = stubFor(vaultAfter(chain), second, third);
    chain.push(nextBlock(chain, third, miner, (vault) => [
      drawOf(vault, second, miner, dueFor(vault, second, third), 'bps-wb', { nowMs: third }),
    ]));
    expectVerified(chain, Number(firstStub + secondStub), 'genesis-rate');
    let vault = vaultAfterBlock(null, chain[0]);
    assert.equal(vault.ok, true);
    vault = vaultAfterBlock(vault.vault, chain[1]);
    assert.equal(vault.ok, true);
    assert.equal(vault.vault.epochBps, GENESIS_BPS);
    vault = vaultAfterBlock(vault.vault, chain[2]);
    assert.equal(vault.ok, true);
    vault = vaultAfterBlock(vault.vault, chain[3]);
    assert.equal(vault.ok, true, 'roll');
    assert.equal(vault.vault.epochBps, GENESIS_BPS);

    const floorMiner = minerDest();
    const voter = portalDest();
    const opened = potBlock(GENESIS, floorMiner, [lockOf(floorMiner, voter, stake, 'floor-lock')]);
    const down = potBlock(GENESIS + 1000, floorMiner, [
      voteTx({ from: floorMiner, dest: voter, choice: VOTE_DECREASE, id: 'floor-down' }),
    ], undefined, 2);
    assert.equal(HASH_BONUS_NANOS_FLOOR, 1);
    const seated = vaultAfterBlock(null, opened);
    assert.equal(seated.ok, true);
    const denied = vaultAfterBlock(seated.vault, down);
    assert.equal(denied.ok, false);
    expectSupplyReject([opened, down], 'unit-floor');
  });

  it('rejects a mid-epoch withdraw, and a same-block lock does not earn that epoch', () => {
    resetLocks();
    const miner = minerDest();
    const portal = portalDest();
    const interest = interestNanos(PI_SHE_NANOS, GENESIS_BPS);
    const midLock = potBlock(GENESIS, miner, [lockOf(miner, portal, PI_SHE_NANOS, 'mid-lock')]);
    const midAt = GENESIS + Math.floor(EPOCH_MS / 2);
    const mid = [
      midLock,
      nextBlock([midLock], midAt, miner, (vault) => [
        drawOf(vault, portal, miner, dueFor(vault, portal, midAt), 'mid-draw', { nowMs: midAt }),
      ]),
    ];
    expectSupplyReject(mid, 'mid-epoch');

    const again = minerDest();
    const who = portalDest();
    // Smallest top-up that lifts floor((π + added) * bps / 10000) by one nanos.
    const rem = (PI_SHE_NANOS * GENESIS_BPS) % 10000;
    const gap = rem === 0 ? 10000 : 10000 - rem;
    const added = Math.ceil(gap / GENESIS_BPS);
    const withLock = interestNanos(PI_SHE_NANOS + added, GENESIS_BPS);
    assert.equal(withLock, interest + 1);
    // One credit per portal (cb733226). A top-up of the same portal is
    // portal_exists, before or after its withdraw in the block, so neither
    // the top-up nor any interest on it is paid.
    resetLocks();
    const preLock = potBlock(GENESIS, again, [lockOf(again, who, PI_SHE_NANOS, 'pre-lock')]);
    const preVault = vaultAfter([preLock]);
    const topUp = lockOf(again, who, PI_SHE_NANOS, 'pre-add', DRAW);
    assert.equal(vaultReason(preVault, [topUp], DRAW, 'lock'), 'portal_exists');
    expectSupplyReject([
      preLock,
      nextBlock([preLock], DRAW, again, (vault) => [
        topUp,
        drawOf(vault, who, again, PI_SHE_NANOS + added + withLock, 'pre-draw'),
      ]),
    ], 'lock-then-withdraw-old');
    expectSupplyReject([
      preLock,
      nextBlock([preLock], DRAW, again, (vault) => [
        lockOf(again, who, PI_SHE_NANOS, 'pre-add-ok', DRAW),
        drawOf(vault, who, again, dueFor(vault, who), 'pre-draw-ok'),
      ]),
    ], 'lock-then-withdraw');
    expectSupplyReject([
      preLock,
      nextBlock([preLock], DRAW, again, (vault) => [
        drawOf(vault, who, again, dueFor(vault, who), 'post-draw'),
        lockOf(again, who, PI_SHE_NANOS, 'post-add', DRAW),
      ]),
    ], 'withdraw-then-lock');
    // A same-block lock on a fresh portal lands and earns nothing this block.
    // The earlier principal is payable in that block, before or after it.
    const stub = stubFor(preVault, who);
    expectVerified([
      preLock,
      nextBlock([preLock], DRAW, again, (vault) => [
        lockOf(again, portalDest(), PI_SHE_NANOS, 'own-add', DRAW),
        drawOf(vault, who, again, dueFor(vault, who), 'own-draw'),
      ]),
    ], Number(stub), 'old-principal-beside-fresh-lock');
    expectVerified([
      preLock,
      nextBlock([preLock], DRAW, again, (vault) => [
        drawOf(vault, who, again, dueFor(vault, who), 'own-draw-first'),
        lockOf(again, portalDest(), PI_SHE_NANOS, 'own-add-after', DRAW),
      ]),
    ], Number(stub), 'withdraw-then-fresh-lock');
  });

  it('rejects a value above 2^53, and a principal withdraw does not move a full u64 book', () => {
    const wide = 2 ** 52;
    const one = interestNanos(wide, GENESIS_BPS);
    assert.equal(Number.isSafeInteger(one), true);
    assert.ok(one > 0);
    const miner = minerDest();
    const portal = portalDest();
    const safeLock = potBlock(GENESIS, miner, [lockOf(miner, portal, PI_SHE_NANOS, 'safe-lock')]);
    const safeStub = stubFor(vaultAfter([safeLock]), portal);
    const honest = [
      safeLock,
      nextBlock([safeLock], DRAW, miner, (vault) => [drawOf(vault, portal, miner, dueFor(vault, portal), 'safe-draw')]),
    ];
    expectVerified(honest, Number(safeStub), 'near-2^53');

    resetLocks();
    const highLock = potBlock(GENESIS, miner, [lockOf(miner, portal, PI_SHE_NANOS, 'high-lock')]);
    let high = null;
    const above = [
      highLock,
      nextBlock([highLock], DRAW, miner, (vault) => {
        high = drawOf(vault, portal, miner, dueFor(vault, portal), 'high-draw');
        // A top-level amount is refused at arrival and dropped by
        // compaction; the amount a block carries is the receipt's own.
        assert.deepEqual(reserveNanosRejected({ ...high, nanos: ABOVE_SAFE.toString() }), { ok: false, reason: 'amount_field' });
        const at = high.vout.findIndex((o) => String(o?.kind || '') === 'withdraw');
        high.vout[at] = { ...high.vout[at], valueProof: { ...high.vout[at].valueProof, v: ABOVE_SAFE.toString() } };
        return [high];
      }),
    ];
    assert.equal(reserveAction(high).opened, false);
    expectSupplyReject(above, 'above-2^53');

    const vault = vaultAfterBlock(null, honest[0]);
    assert.equal(vault.ok, true);
    const stepFrom = (book) => {
      const parent = foldSupply([honest[0]], foldOpts());
      assert.equal(parent.ok, true);
      parent.state.mintedInterest = book;
      parent.state.permittedInterest = book;
      return supplyStep(parent.state, honest[1], {
        magic: MAGIC_TESTNET,
        unit: HASH_BONUS_NANOS,
        tipHeight: 2,
        height: 2,
        genesisMs: GENESIS,
        vault: vault.vault,
      });
    };
    // The lock is at height 1, past its period start, so it earns an arrival
    // stub. The receipt mints exactly that stub and no principal or epoch
    // interest: a book one stub short of u64 ends full, not over.
    assert.ok(safeStub > 0n, 'height-1 lock earns an arrival stub');
    const filled = stepFrom(U64 - safeStub);
    assert.equal(filled.ok, true, filled.reason);
    assert.equal(filled.state.mintedInterest, U64);
    assert.equal(filled.state.permittedInterest, U64);
    // A full book cannot take that stub. The step refuses it, it does not wrap.
    const full = stepFrom(U64);
    assert.equal(full.ok, false);
    assert.equal(full.reason, 'supply');
  });

  it('a reorg that drops the withdraw does not keep the minted interest', () => {
    const miner = minerDest();
    const portal = portalDest();
    const lock = potBlock(GENESIS, miner, [lockOf(miner, portal, PI_SHE_NANOS, 're-lock')]);
    const stub = stubFor(vaultAfter([lock]), portal);
    const draw = nextBlock([lock], DRAW, miner, (vault) => [drawOf(vault, portal, miner, dueFor(vault, portal), 're-draw')]);
    const empty = nextBlock([lock], DRAW, miner, () => []);
    expectVerified([lock, draw], Number(stub), 'withdraw-fork');
    expectVerified([lock, empty], 0, 'reorg-fork');
    const rows = [{}, {}];
    const snap = fillSnapInterest(rows, [lock, empty]);
    assert.equal(snap.ok, true);
    assert.equal(rows[1].mintedInterest, 0n);
    assert.equal(rows[1].permittedInterest, 0n);
    const kept = fillSnapInterest([{}, {}], [lock, draw]);
    assert.equal(kept.ok, true);
  });

  it('trips lock conservation when locked-in is short of principal out', () => {
    const miner = minerDest();
    const portal = portalDest();
    const lock = potBlock(GENESIS, miner, [lockOf(miner, portal, PI_SHE_NANOS, 'cons-lock')]);
    const draw = nextBlock([lock], DRAW, miner, (vault) => [drawOf(vault, portal, miner, dueFor(vault, portal), 'cons-draw')]);
    const parent = vaultAfterBlock(null, lock);
    assert.equal(parent.ok, true, parent.reason);
    const stub = stubFor(parent.vault, portal);
    const honest = blockWithdrawInterest(parent.vault, draw, DRAW);
    assert.equal(honest.ok, true, honest.reason);
    assert.equal(honest.nanos, stub);

    // Plaintext totalLockedNanos is not the note book. Zeroing it still pays.
    const plain = cloneVault(parent.vault);
    plain.totalLockedNanos = 0n;
    const plainWalk = blockWithdrawInterest(plain, draw, DRAW);
    assert.equal(plainWalk.ok, true, plainWalk.reason);
    assert.equal(plainWalk.nanos, stub);
    // The note book is openedLockNanos. A book of 0 under this receipt is short.
    const short = cloneVault(parent.vault);
    short.openedLockNanos = 0n;
    const folded = foldSupply([lock], foldOpts());
    assert.equal(folded.ok, true, folded.reason);
    const stepped = supplyStep(folded.state, draw, {
      magic: MAGIC_TESTNET,
      unit: HASH_BONUS_NANOS,
      tipHeight: 2,
      height: 2,
      genesisMs: GENESIS,
      vault: short,
    });
    assert.equal(stepped.ok, false);
    assert.equal(stepped.reason, 'supply');

    const over = cloneVault(parent.vault);
    over.totalLockedNanos = BigInt(PI_SHE_NANOS) + 5n;
    const still = blockWithdrawInterest(over, draw, DRAW);
    assert.equal(still.ok, true, still.reason);
    assert.equal(still.nanos, stub);
  });

  it('rejects a multi-note withdraw, a note-less withdraw, and a kindless note', () => {
    const miner = minerDest();
    const portal = portalDest();
    const lock = potBlock(GENESIS, miner, [lockOf(miner, portal, PI_SHE_NANOS, 'note-lock')]);
    const parent = vaultAfterBlock(null, lock);
    assert.equal(parent.ok, true);
    const payout = dueFor(parent.vault, portal);

    const multi = drawOf(parent.vault, portal, miner, payout, 'note-multi');
    multi.vout.push(drawOf(parent.vault, portal, miner, payout, 'note-multi-2').vout[0]);
    assert.equal(reserveAction(multi).opened, false);
    expectSupplyReject([lock, nextBlock([lock], DRAW, miner, () => [multi])], 'multi-note');

    const bare = drawOf(parent.vault, portal, miner, payout, 'note-bare');
    delete bare.vout[0].commit;
    delete bare.vout[0].valueProof;
    assert.equal(reserveAction(bare).opened, false);
    expectSupplyReject([lock, nextBlock([lock], DRAW, miner, () => [bare])], 'no-note');

    const hidden = drawOf(parent.vault, portal, miner, payout, 'note-kind');
    delete hidden.vout[0].kind;
    assert.equal(reserveAction(hidden).opened, false);
    assert.equal(explicitTypedKindRejected(hidden)?.reason, 'kind');
    expectSupplyReject([lock, nextBlock([lock], DRAW, miner, () => [hidden])], 'no-kind');

    // The leaf proofs bind the body. A kindless note added after them fails
    // the kind gate on the block, and the proofs no longer open the leaf.
    const beside = drawOf(parent.vault, portal, miner, payout, 'note-beside');
    beside.vout.push({ commit: beside.vout[0].commit });
    assert.equal(reserveAction(beside).opened, true);
    assert.equal(explicitTypedKindRejected(beside)?.reason, 'kind');
    const bound = boundReserveWithdraw(beside, parent.vault, null, DRAW);
    assert.equal(bound.ok, false);
    assert.equal(bound.reason, 'stake_reward');
  });

  it('verifyBlock does not reach supply until vault funding lands', async () => {
    // A vault withdraw that does not present FS-1 stops at admit_version.
    // A missing anchor is not a window miss until that shape is present.
    // The byte-3 funding shape stops at vault_unavailable. supplyStep does
    // not run, so plus, minus, an offsetting pair, and an honest withdraw
    // share those reason codes. Snap fill still tells them apart.
    const chainMiner = minerDest();
    const store = createStore(fs.mkdtempSync(path.join(os.tmpdir(), 'shear-vb-anchor-')));
    for (let i = 0; i < 16; i += 1) {
      const { job } = store.template({ miner: chainMiner, now: GENESIS + i * 90_000 });
      const sealed = await store.submitHeader({
        jobId: job.jobId,
        nonce: 0n,
        miner: chainMiner,
        powHash: `${'00'.repeat(31)}${(0x20 + i).toString(16).padStart(2, '0')}`,
      }, { trusted: true });
      assert.equal(sealed.ok, true, sealed.reason);
    }
    const parent = store.tip();
    const height = parent.height + 1;
    const anchor = walletAnchor(height);
    assert.equal(checkAdmitAnchor({ anchor }, height).ok, true);
    const parentTs = Number(decodeHeader(Buffer.from(parent.header)).timestamp);

    const portal = portalDest();
    const other = portalDest();
    const lock = potBlock(GENESIS, chainMiner, [
      lockOf(chainMiner, portal, PI_SHE_NANOS, 'vb-lock'),
      lockOf(chainMiner, other, PI_SHE_NANOS, 'vb-lock-b'),
    ]);
    const vault = vaultAfterBlock(null, lock);
    assert.equal(vault.ok, true, vault.reason);
    const payout = dueFor(vault.vault, portal);
    const stub = stubFor(vault.vault, portal);

    async function verdictFor(rows) {
      const { tpl } = store.template({ miner: chainMiner, now: parentTs + 90_000 });
      const decoded = decodeHeader(Buffer.from(tpl.header));
      const txs = [tpl.txs[0], ...rows.map((tx) => compactTx(tx))];
      const header = encodeHeader({
        version: decoded.version,
        prevBlockHash: decoded.prevBlockHash,
        merkleRoot: merkleRoot(txs.map((tx) => digestTx(tx))),
        continuityRoot: decoded.continuityRoot,
        timestamp: decoded.timestamp,
        bits: decoded.bits,
        nonce: 0n,
        baseFee: decoded.baseFee,
      });
      return verifyBlock({
        header,
        txs,
        samples: tpl.samples,
        shareBatch: tpl.shareBatch || [],
        miner: tpl.miner,
        aLeaves: tpl.aLeaves,
        bLeaves: tpl.bLeaves,
        weight: tpl.weight,
        height,
      }, parent, {
        probeBody: true,
        genesisMs: GENESIS,
        magic: MAGIC_TESTNET,
        reserveState: vault.vault,
      });
    }

    // The leaf proofs bind the anchor, so it is set before they are taken.
    const atAnchor = (who, nanos, id) => drawOf(vault.vault, who, chainMiner, nanos, id, { extra: { anchor } });

    const honest = atAnchor(portal, payout, 'vb-honest');
    const plus = atAnchor(portal, payout + 1, 'vb-plus');
    const minus = atAnchor(portal, payout - 1, 'vb-minus');
    const high = atAnchor(portal, payout + 5, 'vb-off-high');
    const low = atAnchor(other, dueFor(vault.vault, other) - 5, 'vb-off-low');
    expectVerified([lock, nextBlock([lock], DRAW, chainMiner, () => [honest])], Number(stub), 'vb-honest');
    expectSupplyReject([lock, nextBlock([lock], DRAW, chainMiner, () => [plus])], 'vb-plus');
    expectSupplyReject([lock, nextBlock([lock], DRAW, chainMiner, () => [minus])], 'vb-minus');
    expectSupplyReject([lock, nextBlock([lock], DRAW, chainMiner, () => [high, low])], 'vb-offset');

    for (const row of [
      { name: 'honest', txs: [honest] },
      { name: 'plus', txs: [plus] },
      { name: 'minus', txs: [minus] },
      { name: 'offset', txs: [high, low] },
    ]) {
      const got = await verdictFor(row.txs);
      assert.equal(got.ok, false, row.name);
      assert.equal(got.reason, 'admit_version', `${row.name} ${got.reason}`);
    }

    const unanchored = drawOf(vault.vault, portal, chainMiner, payout, 'vb-window');
    const windowed = await verdictFor([unanchored]);
    assert.equal(windowed.ok, false);
    assert.equal(windowed.reason, 'admit_version', windowed.reason);

    const funded = drawOf(vault.vault, portal, chainMiner, payout, 'vb-fund');
    const ct = Buffer.alloc(32, 7);
    funded.anchor = anchor;
    funded.vin = [{ commit: ct }];
    funded.admit_proof = {
      blob: Buffer.concat([Buffer.from([3]), Buffer.alloc(40, 1)]),
      cTilde: ct,
    };
    const stage0 = await verdictFor([funded]);
    assert.equal(stage0.ok, false);
    assert.equal(stage0.reason, 'vault_unavailable', stage0.reason);

    const bare = atAnchor(portal, payout, 'vb-bare');
    delete bare.vout[0].commit;
    delete bare.vout[0].valueProof;
    const noteLess = await verdictFor([bare]);
    assert.equal(noteLess.ok, false);
    assert.equal(noteLess.reason, 'mint_amount', noteLess.reason);
  });
});
