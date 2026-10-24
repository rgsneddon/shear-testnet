import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { newIdentity, hash20FromAddress } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { encodeHeader } from '../../crypto/header.js';
import { potSubsidyAt, potSubsidyNanos, MS_PER_DAY, EPOCH_DAYS_TESTNET } from '../../crypto/pot_sched.js';
import { PI_SHE_NANOS, GENESIS_BPS, MAGIC_TESTNET } from '../../crypto/asert.js';
import { interestNanos } from '../../crypto/reserve_oracle.js';
import { sealCoinbaseNote, addExcess, excessOf, randomScalar } from '../../crypto/note.js';
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
import { verifySealedNote } from '../../crypto/note.js';
import { coinbaseTx } from '../src/chain.js';
import { auditCirculatingSupply, foldSupply, supplyReport, supplyStep, emptySupplyState, vaultAfterBlock } from '../src/supply.js';

const GENESIS = 1_700_000_000_000;
const EPOCH_MS = EPOCH_DAYS_TESTNET * MS_PER_DAY;
const STAKES = [PI_SHE_NANOS];
const LEADS = [1, EPOCH_MS];
const PORTALS = [1, 3];

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
function blockAt(ts, miner, notes, moreTxs, height = 1) {
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
  if (!tx.vout.length) tx.excess = excessOf([]);
  return {
    height,
    header: header(ts),
    txs: [tx, ...(moreTxs || [])],
    shareBatch: [],
  };
}

/** Pro-rata of the lock epoch, then each later full epoch before the draw. */
function earned(stake, lockTs, drawTs) {
  const lockIdx = Math.floor((lockTs - GENESIS) / EPOCH_MS);
  const drawIdx = Math.floor((drawTs - GENESIS) / EPOCH_MS);
  const end = GENESIS + (lockIdx + 1) * EPOCH_MS;
  const remain = Math.max(0, end - lockTs);
  let total = 0;
  if (drawIdx > lockIdx) {
    total += Number((BigInt(stake) * BigInt(GENESIS_BPS) * BigInt(remain)) / (BigInt(EPOCH_MS) * 10000n));
  }
  for (let e = lockIdx + 1; e < drawIdx; e += 1) total += interestNanos(stake, GENESIS_BPS);
  return total;
}

// Since d5529d81 a lock with no vaultLockNote is stake_reward, and only a π
// leaf can carry one. Since ac3951ea a withdraw needs the portal's recorded
// owner, and since a5760821 the owner signs over the receipt dest20. Each lock
// here is a π vault lock note bound by its equality proof, funded by a vin
// note that opens to the locked amount. A withdraw opens that leaf with a
// principal proof and a retire proof. The receipt is π plus the leaf's
// arrival stub (cfe93bf5), which supply counts as minted interest. Same
// construction as test_interest_spread_v12.js (f2256d29).
const LEAF_OF = new Map();

/** A lock of `stake` into `portal`. `vin` replaces the funding note to test a bad one. */
function lockOf(miner, portal, stake, id, { at = GENESIS, mark = 0x91, vin = null } = {}) {
  const tx = lockTx({ from: miner, to: portal, nanos: stake, id });
  const prev = tx.vin && tx.vin[0] ? tx.vin[0] : {};
  if (vin) {
    tx.vin = [{ ...prev, ...vin }];
  } else {
    const sealed = sealCoinbaseNote(Math.floor(Number(stake)), { dest20: Buffer.alloc(20, mark & 0xff), kind: 'pot' });
    tx.vin = [{
      ...prev,
      commit: sealed.commit,
      valueProof: sealed.valueProof,
      rangeProof: sealed.rangeProof,
    }];
  }
  const held = lockWitnessOf(tx);
  const stamp = lockUnlockOf({ genesisMs: GENESIS, magic: MAGIC_TESTNET }, at);
  const unlock = consensusUnlockPeriod(stamp.epoch);
  const scalar = randomScalar();
  // A leaf note exists only for a π leaf. A lock with no leaf is refused.
  const leaf = vaultLockNote(held.amount, scalar, held.blind, unlock);
  if (leaf) {
    tx.vaultLockNote = leaf.note;
    LEAF_OF.set(portal, {
      note: leaf.note,
      commit: leaf.note.subarray(32, 64),
      scalar,
      blind: held.blind,
      unlock,
    });
  }
  if (!attachLockEquality(tx)) throw new Error(`lock equality ${id}`);
  return tx;
}

function lockBlock(ts, miner, portals, stake) {
  const locks = portals.map((portal, i) => lockOf(miner, portal, stake, `lock-${i}-${stake}-${ts}`, { at: ts, mark: i + 1 }));
  return blockAt(ts, miner, [{ nanos: potAt(ts), kind: 'pot' }], locks, 1);
}

/** Vault after `blocks`, replayed as the audit replays it. */
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

/** Arrival stub the leaf of `portal` earns in `vault`. */
function stubFor(vault, portal) {
  const leaf = LEAF_OF.get(portal);
  if (!vault || !leaf) return 0;
  return Number(leafStubNanos(vault, [leaf.commit.toString('hex')]));
}

/** π plus the arrival stub: the one receipt the vault pays. */
function dueFor(vault, portal) {
  return PI_SHE_NANOS + stubFor(vault, portal);
}

/** A withdraw of `nanos` from `portal`. With a vault it carries the opening, the retire, and the owner signature. */
function drawOf(vault, portal, miner, nanos, id, nowMs) {
  const tx = withdrawTx({ from: portal, to: miner, nanos, id });
  const leaf = vault ? LEAF_OF.get(portal) : null;
  if (!leaf) return tx;
  const portalId = portalIdFromDest(portal);
  const proof = provePrincipalOpen(leaf.commit, PI_SHE_NANOS, leaf.blind, tx, portalId, vault.magic, leaf.unlock);
  assert.ok(proof, `${id} principal proof`);
  tx.principalProof = proof;
  const period = chainPeriodIndex(vault, nowMs);
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
    nowMs,
  });
  return tx;
}

/**
 * The withdraw block after `prefix`. `pay(vault, portal)` is each receipt.
 * `prove: false` sends the withdraw with no opening. The coinbase commits the
 * reward root when one is due. `stubs` is what an honest draw mints.
 */
function drawBlock(prefix, ts, miner, portals, pay, { prove = true } = {}) {
  const vault = vaultAfter(prefix);
  const draws = portals.map((portal, i) => drawOf(prove ? vault : null, portal, miner, pay(vault, portal), `draw-${i}-${ts}`, ts));
  const block = blockAt(ts, miner, [{ nanos: potAt(ts), kind: 'pot' }], draws, prefix.length + 1);
  const plan = rewardCommitment(vault, ts);
  if (plan.rows.length) block.txs[0].rewardRoot = plan.root;
  let stubs = 0;
  for (const portal of portals) stubs += stubFor(vault, portal);
  return { block, stubs, vault };
}

describe('v12 supply counts reserve interest from the chain', () => {
  it('pays principal only for an exact pi lock, any portal count, and any epoch lead', () => {
    const minerOnly = minerDest();
    const potOnly = [blockAt(GENESIS, minerOnly, [{ nanos: potAt(GENESIS), kind: 'pot' }])];
    const potAudit = auditCirculatingSupply(potOnly);
    assert.equal(potAudit.status, 'verified');
    assert.equal(potAudit.extraMintNanos, 0);
    assert.equal(potAudit.circulatingNanos, potAt(GENESIS));
    assert.equal(potAudit.measuredLevyNanos, 0);

    const emptyOmitted = auditCirculatingSupply([]);
    assert.equal(emptyOmitted.status, 'verified');
    assert.equal(emptyOmitted.extraMintNanos, 0);
    assert.equal(emptyOmitted.circulatingNanos, 0);
    const emptyZero = auditCirculatingSupply([], { extraMintNanos: 0 });
    assert.equal(emptyZero.status, 'verified');
    assert.equal(emptyZero.extraMintNanos, 0);
    for (const claim of [1, PI_SHE_NANOS]) {
      const emptyClaim = auditCirculatingSupply([], { extraMintNanos: claim });
      assert.equal(emptyClaim.status, 'mismatch', `empty claim ${claim}`);
      assert.equal(emptyClaim.reason, 'supply');
    }

    for (const stake of STAKES) {
      for (const count of PORTALS) {
        for (const lead of LEADS) {
          const drawTs = GENESIS + EPOCH_MS + lead;
          const one = earned(stake, GENESIS, drawTs);
          const interestSum = one * count;
          assert.ok(one > 0, `stake ${stake} lead ${lead} earns interest`);
          const epoch = Math.floor((drawTs - GENESIS) / EPOCH_MS);
          assert.equal(potAt(drawTs), potSubsidyNanos(epoch), `lead ${lead}`);
          assert.equal(potAt(GENESIS), potSubsidyNanos(0));
          const potSum = potAt(GENESIS) + potAt(drawTs);
          const miner = minerDest();
          const portals = Array.from({ length: count }, () => portalDest());
          const locked = lockBlock(GENESIS, miner, portals, stake);
          const draw = drawBlock([locked], drawTs, miner, portals, dueFor);
          const chain = [locked, draw.block];
          // The withdraw mints the arrival stubs only, never the epoch interest.
          const minted = draw.stubs;
          const label = `stake ${stake} portals ${count} lead ${lead}`;
          const paid = auditCirculatingSupply(chain);
          assert.equal(paid.status, 'verified', `${label} ${paid.reason}`);
          assert.equal(paid.extraMintNanos, minted, label);
          assert.equal(paid.circulatingNanos, potSum + minted, label);
          assert.equal(paid.measuredPotNanos, potSum, label);
          assert.equal(paid.measuredLevyNanos, 0, label);
          assert.equal(paid.differenceNanos, 0, label);
          const echoed = auditCirculatingSupply(chain, { extraMintNanos: minted });
          assert.equal(echoed.status, 'verified', `${label} echo`);
          assert.equal(echoed.extraMintNanos, minted, label);
          assert.equal(echoed.differenceNanos, 0, label);
          // Any claim other than the measured stub is a mismatch, including the
          // epoch interest the schedule computes.
          const claims = [minted + 1, minted + interestSum, minted + interestSum + 1 + stake];
          if (minted > 0) claims.push(0, minted - 1);
          for (const claim of claims) {
            const miss = auditCirculatingSupply(chain, { extraMintNanos: claim });
            assert.equal(miss.status, 'mismatch', `${label} claim ${claim}`);
            assert.equal(miss.reason, 'supply', `${label} claim ${claim}`);
            assert.equal(miss.extraMintNanos, minted, `${label} claim ${claim}`);
            assert.equal(miss.differenceNanos, 0, `${label} claim ${claim}`);
          }
          const withReward = [
            locked,
            drawBlock([locked], drawTs, miner, portals, (vault, portal) => dueFor(vault, portal) + one).block,
          ];
          const rewarded = auditCirculatingSupply(withReward);
          assert.equal(rewarded.status, 'mismatch', `${label} reward receipt`);
          const folded = foldSupply(chain, { genesisMs: GENESIS });
          assert.equal(folded.ok, true, `${label} fold ${folded.reason}`);
          assert.equal(folded.state.mintedInterest, BigInt(minted), label);
          assert.equal(folded.state.permittedInterest, BigInt(minted), label);
        }
      }
    }
    // π+1 and 3π are not one π leaf. Their receipt of the stake is not paid.
    for (const stake of [PI_SHE_NANOS + 1, PI_SHE_NANOS * 3]) {
      const miner = minerDest();
      const portal = portalDest();
      const locked = lockBlock(GENESIS, miner, [portal], stake);
      const chain = [
        locked,
        blockAt(GENESIS + EPOCH_MS + 1, miner, [{ nanos: potAt(GENESIS + EPOCH_MS + 1), kind: 'pot' }], [
          drawOf(null, portal, miner, stake, `non-pi-${stake}`, GENESIS + EPOCH_MS + 1),
        ], 2),
      ];
      const paid = auditCirculatingSupply(chain);
      assert.equal(paid.status, 'mismatch', `non-pi ${stake} ${paid.reason}`);
    }
  });

  it('counts locked principal in the total supply', () => {
    const stake = PI_SHE_NANOS;
    const miner = minerDest();
    const portal = portalDest();
    const lock = lockBlock(GENESIS, miner, [portal], stake);
    const folded = foldSupply([lock], { genesisMs: GENESIS });
    assert.equal(folded.ok, true, folded.reason);
    assert.equal(folded.state.vaultPrincipal, BigInt(stake));
    const report = supplyReport(folded.state);
    assert.equal(report.status, 'verified', report.reason);
    assert.equal(report.vaultPrincipalNanos, stake);
    assert.equal(report.totalNanos, report.circulatingNanos + stake);
    const lockedAudit = auditCirculatingSupply([lock]);
    assert.equal(lockedAudit.status, 'verified', lockedAudit.reason);
    assert.equal(lockedAudit.vaultPrincipalNanos, stake);
    // A π leaf whose vin names a bare commit is not funded.
    const sticker = lockOf(miner, portalDest(), stake, 'sticker-lock', { vin: { noteCommit: Buffer.alloc(32, 4) } });
    const stickerFold = foldSupply([
      blockAt(GENESIS, miner, [{ nanos: potAt(GENESIS), kind: 'pot' }], [sticker]),
    ], { genesisMs: GENESIS });
    assert.equal(stickerFold.ok, false, stickerFold.reason);
    assert.equal(stickerFold.reason, 'supply');
    // A π leaf funded by a note that opens to 1 is not funded either.
    const shortNote = sealCoinbaseNote(1, { dest20: Buffer.alloc(20, 3), kind: 'pot' });
    const short = lockOf(miner, portalDest(), stake, 'short-lock', {
      vin: {
        commit: shortNote.commit,
        valueProof: shortNote.valueProof,
        rangeProof: shortNote.rangeProof,
      },
    });
    const shortFold = foldSupply([
      blockAt(GENESIS, miner, [{ nanos: potAt(GENESIS), kind: 'pot' }], [short]),
    ], { genesisMs: GENESIS });
    assert.equal(shortFold.ok, false, shortFold.reason);
    assert.equal(shortFold.reason, 'supply');
    assert.equal(lockedAudit.totalNanos, lockedAudit.circulatingNanos + stake);
    const drawTs = GENESIS + EPOCH_MS + 1;
    const draw = drawBlock([lock], drawTs, miner, [portal], dueFor);
    const paid = auditCirculatingSupply([lock, draw.block]);
    assert.equal(paid.status, 'verified', paid.reason);
    assert.equal(paid.vaultPrincipalNanos, 0);
    assert.equal(paid.totalNanos, paid.circulatingNanos);
    // One lock output per portal (cb733226). MAX_SAFE_INTEGER splits into 16 π
    // leaves plus change, so the lock is refused and books no principal.
    const edge = Number.MAX_SAFE_INTEGER;
    const edgeChain = [lockBlock(GENESIS, minerDest(), [portalDest()], edge)];
    assert.equal(edgeChain[0].txs[1].vout.filter((row) => row?.kind === 'lock').length, 16);
    const edgeFold = foldSupply(edgeChain, { genesisMs: GENESIS });
    const edgeAudit = auditCirculatingSupply(edgeChain);
    assert.equal(edgeFold.ok, false, edgeFold.reason);
    assert.equal(edgeFold.reason, 'supply');
    assert.equal(edgeAudit.status, 'mismatch', `${edgeAudit.status} ${edgeAudit.reason}`);
    assert.equal(edgeAudit.reason, 'supply');
  });

  it('rejects a receipt that is not the principal, and a second withdraw of the same portal', () => {
    const stake = PI_SHE_NANOS;
    const drawTs = GENESIS + EPOCH_MS + 1;
    const one = earned(stake, GENESIS, drawTs);
    assert.ok(one > 0);
    const miner = minerDest();
    const portal = portalDest();
    const locked = lockBlock(GENESIS, miner, [portal], stake);
    const draw = drawBlock([locked], drawTs, miner, [portal], dueFor);
    const honest = [locked, draw.block];
    const paid = auditCirculatingSupply(honest);
    assert.equal(paid.status, 'verified', paid.reason);
    assert.equal(paid.extraMintNanos, draw.stubs);

    const inflated = [
      honest[0],
      drawBlock([locked], drawTs, miner, [portal], (vault, p) => dueFor(vault, p) + one).block,
    ];
    const bad = auditCirculatingSupply(inflated);
    assert.equal(bad.status, 'mismatch');
    assert.equal(bad.reason, 'supply');
    assert.notEqual(bad.extraMintNanos, draw.stubs + one);
    assert.notEqual(bad.circulatingNanos, potAt(GENESIS) + potAt(drawTs) + draw.stubs + one);

    const againTs = drawTs + EPOCH_MS;
    const twice = honest.concat([
      blockAt(againTs, miner, [{ nanos: potAt(againTs), kind: 'pot' }], [
        drawOf(vaultAfter(honest), portal, miner, dueFor(vaultAfter(honest), portal), 'draw-again', againTs),
      ], 3),
    ]);
    const second = auditCirculatingSupply(twice);
    assert.notEqual(second.status, 'verified', second.reason);
    // The portal paid once. The second receipt mints nothing: the measured
    // mint is still the first withdraw's stub, not a second stub or the epoch interest.
    assert.equal(second.extraMintNanos, draw.stubs);
    assert.notEqual(second.extraMintNanos, draw.stubs + one);

    let state = emptySupplyState(GENESIS);
    const stepped = supplyStep(state, honest[0], {
      height: 1,
      genesisMs: GENESIS,
      tipHeight: 2,
    });
    assert.equal(stepped.ok, true, stepped.reason);
    state = stepped.state;
    const bare = supplyStep(state, honest[1], {
      height: 2,
      genesisMs: GENESIS,
      tipHeight: 2,
    });
    assert.equal(bare.ok, false);
    assert.equal(bare.reason, 'supply');
  });

  it('rejects a withdraw note that opens above the public amount, and an inflated interest', () => {
    const stake = PI_SHE_NANOS;
    const drawTs = GENESIS + EPOCH_MS + 1;
    const one = earned(stake, GENESIS, drawTs);
    assert.ok(one > 0);
    const miner = minerDest();
    const portal = portalDest();
    const lock = lockBlock(GENESIS, miner, [portal], stake);
    const honestPay = dueFor(vaultAfter([lock]), portal);

    const openedHigh = drawBlock([lock], drawTs, miner, [portal], () => honestPay).block;
    const fat = withdrawTx({
      from: portal,
      to: miner,
      nanos: honestPay + 1,
      id: 'note-opens-high',
    });
    const wd = openedHigh.txs[1];
    wd.vout = fat.vout;
    wd.nanos = honestPay;
    const act = reserveAction(wd);
    assert.equal(act.nanos, honestPay);
    assert.equal(act.opened, false);
    assert.equal(verifySealedNote(wd.vout[0], honestPay + 1), true);
    assert.equal(verifySealedNote(wd.vout[0], act.nanos), false);
    const high = auditCirculatingSupply([lock, openedHigh]);
    assert.equal(high.status, 'mismatch', high.reason);
    assert.equal(high.reason, 'supply');
    const highFold = foldSupply([lock, openedHigh], { genesisMs: GENESIS });
    assert.equal(highFold.ok, false);
    assert.equal(highFold.reason, 'supply');

    const inflatedBlock = drawBlock([lock], drawTs, miner, [portal], () => honestPay + 1).block;
    const fatAct = reserveAction(inflatedBlock.txs[1]);
    assert.equal(fatAct.opened, true, 'the inflated receipt does open to its public amount');
    assert.equal(fatAct.nanos, honestPay + 1);
    const inflated = [lock, inflatedBlock];
    const refused = foldSupply(inflated, { genesisMs: GENESIS });
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, 'supply');
    assert.equal(refused.state, null);
    const audited = auditCirculatingSupply(inflated);
    assert.equal(audited.status, 'mismatch');
    assert.equal(audited.reason, 'supply');
    assert.notEqual(audited.extraMintNanos, honestPay + 1 - stake);
    assert.notEqual(audited.circulatingNanos, potAt(GENESIS) + potAt(drawTs) + honestPay + 1 - stake);
  });
});
