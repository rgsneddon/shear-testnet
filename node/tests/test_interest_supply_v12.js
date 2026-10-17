import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { newIdentity, hash20FromAddress } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { encodeHeader } from '../../crypto/header.js';
import { potSubsidyAt, potSubsidyNanos, MS_PER_DAY, EPOCH_DAYS_TESTNET } from '../../crypto/pot_sched.js';
import { PI_SHE_NANOS, GENESIS_BPS, MAGIC_TESTNET } from '../../crypto/asert.js';
import { interestNanos } from '../../crypto/reserve_oracle.js';
import { sealCoinbaseNote, addExcess, excessOf } from '../../crypto/note.js';
import { reserveAction, attachLockEquality, provePrincipalOpen, lockWitnessOf, portalIdFromDest } from '../../crypto/reserve_vault.js';
import { lockTx, withdrawTx } from '../../crypto/owned_portal.js';
import { verifySealedNote } from '../../crypto/note.js';
import { coinbaseTx } from '../src/chain.js';
import { auditCirculatingSupply, foldSupply, supplyReport, supplyStep, emptySupplyState } from '../src/supply.js';

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

function blockAt(ts, miner, notes, moreTxs) {
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

/** A lock whose vin opens a note for the hidden principal. A dest20 receipt is bare. */
function noteFund(tx, mark, amount) {
  const n = Math.floor(Number(amount));
  const sealed = sealCoinbaseNote(n, { dest20: Buffer.alloc(20, mark & 0xff), kind: 'pot' });
  const prev = tx.vin && tx.vin[0] ? tx.vin[0] : {};
  tx.vin = [{
    ...prev,
    commit: sealed.commit,
    valueProof: sealed.valueProof,
    rangeProof: sealed.rangeProof,
  }];
  if (!attachLockEquality(tx)) throw new Error('lock equality');
  return tx;
}

function lockBlock(ts, miner, portals, stake) {
  const locks = portals.map((portal, i) => noteFund(lockTx({
    from: miner,
    to: portal,
    nanos: stake,
    id: `lock-${i}-${stake}-${ts}`,
  }), i + 1, stake));
  const block = blockAt(ts, miner, [{ nanos: potAt(ts), kind: 'pot' }], locks);
  block.lockTxs = locks;
  return block;
}

function drawBlock(ts, miner, portals, payout, principal = null, lockBlock = null) {
  const signNanos = principal == null ? payout : principal;
  const locks = lockBlock?.lockTxs || null;
  const draws = portals.map((portal, i) => {
    const tx = withdrawTx({
      from: portal,
      to: miner,
      nanos: payout,
      id: `draw-${i}-${payout}-${ts}`,
      nowMs: ts,
      authBind: locks && locks[i] ? {
        genesisMs: GENESIS,
        nowMs: ts,
        tranches: [{
          commit: locks[i].vout[0].commit,
          epoch: 0,
          remainMs: EPOCH_MS,
          noteIsPrincipal: false,
        }],
      } : { genesisMs: GENESIS, nowMs: ts, locks: [{ nanos: signNanos, at: GENESIS }] },
    }, signNanos);
    const lock = locks && locks[i];
    const held = lock ? lockWitnessOf(lock) : null;
    if (held && lock?.vout?.[0]?.commit) {
      tx.principalProof = provePrincipalOpen(lock.vout[0].commit, payout, held.blind, tx, portalIdFromDest(portal));
    }
    return tx;
  });
  return blockAt(ts, miner, [{ nanos: potAt(ts), kind: 'pot' }], draws);
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
          const chain = [
            locked,
            drawBlock(drawTs, miner, portals, stake, null, locked),
          ];
          const label = `stake ${stake} portals ${count} lead ${lead}`;
          const paid = auditCirculatingSupply(chain);
          assert.equal(paid.status, 'verified', `${label} ${paid.reason}`);
          assert.equal(paid.extraMintNanos, 0, label);
          assert.equal(paid.circulatingNanos, potSum, label);
          assert.equal(paid.measuredPotNanos, potSum, label);
          assert.equal(paid.measuredLevyNanos, 0, label);
          assert.equal(paid.differenceNanos, 0, label);
          const echoed = auditCirculatingSupply(chain, { extraMintNanos: 0 });
          assert.equal(echoed.status, 'verified', `${label} echo`);
          assert.equal(echoed.extraMintNanos, 0, label);
          assert.equal(echoed.differenceNanos, 0, label);
          for (const claim of [1, interestSum, interestSum + 1 + stake]) {
            const miss = auditCirculatingSupply(chain, { extraMintNanos: claim });
            assert.equal(miss.status, 'mismatch', `${label} claim ${claim}`);
            assert.equal(miss.reason, 'supply', `${label} claim ${claim}`);
            assert.equal(miss.extraMintNanos, 0, `${label} claim ${claim}`);
            assert.equal(miss.differenceNanos, 0, `${label} claim ${claim}`);
          }
          const withReward = [
            locked,
            drawBlock(drawTs, miner, portals, stake + one, null, locked),
          ];
          const rewarded = auditCirculatingSupply(withReward);
          assert.equal(rewarded.status, 'mismatch', `${label} reward receipt`);
          const folded = foldSupply(chain, { genesisMs: GENESIS });
          assert.equal(folded.ok, true, `${label} fold ${folded.reason}`);
          assert.equal(folded.state.mintedInterest, 0n, label);
        }
      }
    }
    for (const stake of [PI_SHE_NANOS + 1, PI_SHE_NANOS * 3]) {
      const miner = minerDest();
      const portal = portalDest();
      const locked = lockBlock(GENESIS, miner, [portal], stake);
      const chain = [
        locked,
        drawBlock(GENESIS + EPOCH_MS + 1, miner, [portal], stake, null, locked),
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
    const sticker = lockTx({ from: miner, to: portal, nanos: stake, id: 'sticker-lock' });
    const stickerVin = { ...(sticker.vin && sticker.vin[0] ? sticker.vin[0] : {}) };
    stickerVin.noteCommit = Buffer.alloc(32, 4);
    sticker.vin = [stickerVin];
    const stickerFold = foldSupply([
      blockAt(GENESIS, miner, [{ nanos: potAt(GENESIS), kind: 'pot' }], [sticker]),
    ], { genesisMs: GENESIS });
    assert.equal(stickerFold.ok, false, stickerFold.reason);
    assert.equal(stickerFold.reason, 'supply');
    const shortNote = sealCoinbaseNote(1, { dest20: Buffer.alloc(20, 3), kind: 'pot' });
    const short = lockTx({ from: miner, to: portal, nanos: stake, id: 'short-lock' });
    short.vin = [{
      commit: shortNote.commit,
      valueProof: shortNote.valueProof,
      rangeProof: shortNote.rangeProof,
    }];
    const shortFold = foldSupply([
      blockAt(GENESIS, miner, [{ nanos: potAt(GENESIS), kind: 'pot' }], [short]),
    ], { genesisMs: GENESIS });
    assert.equal(shortFold.ok, false, shortFold.reason);
    assert.equal(shortFold.reason, 'supply');
    assert.equal(lockedAudit.totalNanos, lockedAudit.circulatingNanos + stake);
    const drawTs = GENESIS + EPOCH_MS + 1;
    const paid = auditCirculatingSupply([lock, drawBlock(drawTs, miner, [portal], stake, null, lock)]);
    assert.equal(paid.status, 'verified', paid.reason);
    assert.equal(paid.vaultPrincipalNanos, 0);
    assert.equal(paid.totalNanos, paid.circulatingNanos);
    const edge = Number.MAX_SAFE_INTEGER;
    const edgeChain = [lockBlock(GENESIS, minerDest(), [portalDest()], edge)];
    const edgeFold = foldSupply(edgeChain, { genesisMs: GENESIS });
    const edgeAudit = auditCirculatingSupply(edgeChain);
    const booked = PI_SHE_NANOS * 16;
    assert.equal(edgeFold.ok, true, edgeFold.reason);
    assert.equal(edgeFold.state.vaultPrincipal, BigInt(booked));
    assert.equal(edgeAudit.status, 'verified', `${edgeAudit.status} ${edgeAudit.reason}`);
    assert.equal(edgeAudit.vaultPrincipalNanos, booked);
  });

  it('rejects a receipt that is not the principal, and a second withdraw of the same portal', () => {
    const stake = PI_SHE_NANOS;
    const drawTs = GENESIS + EPOCH_MS + 1;
    const one = earned(stake, GENESIS, drawTs);
    assert.ok(one > 0);
    const miner = minerDest();
    const portal = portalDest();
    const locked = lockBlock(GENESIS, miner, [portal], stake);
    const honest = [
      locked,
      drawBlock(drawTs, miner, [portal], stake, null, locked),
    ];
    const paid = auditCirculatingSupply(honest);
    assert.equal(paid.status, 'verified', paid.reason);
    assert.equal(paid.extraMintNanos, 0);

    const inflated = [
      honest[0],
      drawBlock(drawTs, miner, [portal], stake + one, stake, locked),
    ];
    const bad = auditCirculatingSupply(inflated);
    assert.equal(bad.status, 'mismatch');
    assert.equal(bad.reason, 'supply');
    assert.notEqual(bad.extraMintNanos, one);
    assert.notEqual(bad.circulatingNanos, potAt(GENESIS) + potAt(drawTs) + one);

    const againTs = drawTs + EPOCH_MS;
    const twice = honest.concat([
      drawBlock(againTs, miner, [portal], stake, null, locked),
    ]);
    const second = auditCirculatingSupply(twice);
    assert.notEqual(second.status, 'verified', second.reason);
    assert.notEqual(second.extraMintNanos, one);

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
    const honestPay = stake;
    const lock = lockBlock(GENESIS, miner, [portal], stake);

    const openedHigh = drawBlock(drawTs, miner, [portal], honestPay, null, lock);
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

    const inflatedBlock = drawBlock(drawTs, miner, [portal], honestPay + 1, honestPay, lock);
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
    assert.notEqual(audited.extraMintNanos, 1);
    assert.notEqual(audited.circulatingNanos, potAt(GENESIS) + potAt(drawTs) + 1);
  });
});
