import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { newIdentity, hash20FromAddress } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { encodeHeader } from '../../crypto/header.js';
import { potSubsidyAt, potSubsidyNanos, MS_PER_DAY, EPOCH_DAYS_TESTNET } from '../../crypto/pot_sched.js';
import { PI_SHE_NANOS, GENESIS_BPS, MAGIC_TESTNET } from '../../crypto/asert.js';
import { interestNanos } from '../../crypto/reserve_oracle.js';
import { sealCoinbaseNote, addExcess, excessOf } from '../../crypto/note.js';
import { reserveAction } from '../../crypto/reserve_vault.js';
import { lockTx, withdrawTx } from '../../crypto/owned_portal.js';
import { verifySealedNote } from '../../crypto/note.js';
import { coinbaseTx } from '../src/chain.js';
import { auditCirculatingSupply, foldSupply, supplyReport, supplyStep, emptySupplyState } from '../src/supply.js';

const GENESIS = 1_700_000_000_000;
const EPOCH_MS = EPOCH_DAYS_TESTNET * MS_PER_DAY;
const STAKES = [PI_SHE_NANOS, PI_SHE_NANOS + 1, PI_SHE_NANOS * 3];
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

function lockBlock(ts, miner, portals, stake) {
  const locks = portals.map((portal, i) => lockTx({
    from: miner,
    to: portal,
    nanos: stake,
    id: `lock-${i}-${stake}-${ts}`,
  }));
  return blockAt(ts, miner, [{ nanos: potAt(ts), kind: 'pot' }], locks);
}

function drawBlock(ts, miner, portals, payout, principal = null) {
  const signNanos = principal == null ? payout : principal;
  const draws = portals.map((portal, i) => withdrawTx({
    from: portal,
    to: miner,
    nanos: payout,
    id: `draw-${i}-${payout}-${ts}`,
  }, signNanos));
  return blockAt(ts, miner, [{ nanos: potAt(ts), kind: 'pot' }], draws);
}

describe('v12 supply counts reserve interest from the chain', () => {
  it('pays principal only for any stake, portal count, and epoch lead', () => {
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
          const chain = [
            lockBlock(GENESIS, miner, portals, stake),
            drawBlock(drawTs, miner, portals, stake),
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
            lockBlock(GENESIS, miner, portals, stake),
            drawBlock(drawTs, miner, portals, stake + one),
          ];
          const rewarded = auditCirculatingSupply(withReward);
          assert.equal(rewarded.status, 'mismatch', `${label} reward receipt`);
          const folded = foldSupply(chain, { genesisMs: GENESIS });
          assert.equal(folded.ok, true, `${label} fold ${folded.reason}`);
          assert.equal(folded.state.mintedInterest, 0n, label);
        }
      }
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
    assert.equal(lockedAudit.totalNanos, lockedAudit.circulatingNanos + stake);
    const drawTs = GENESIS + EPOCH_MS + 1;
    const paid = auditCirculatingSupply([lock, drawBlock(drawTs, miner, [portal], stake)]);
    assert.equal(paid.status, 'verified', paid.reason);
    assert.equal(paid.vaultPrincipalNanos, 0);
    assert.equal(paid.totalNanos, paid.circulatingNanos);
  });

  it('rejects a receipt that is not the principal, and a second withdraw of the same portal', () => {
    const stake = PI_SHE_NANOS * 2 + 17;
    const drawTs = GENESIS + EPOCH_MS + 1;
    const one = earned(stake, GENESIS, drawTs);
    assert.ok(one > 0);
    const miner = minerDest();
    const portal = portalDest();
    const honest = [
      lockBlock(GENESIS, miner, [portal], stake),
      drawBlock(drawTs, miner, [portal], stake),
    ];
    const paid = auditCirculatingSupply(honest);
    assert.equal(paid.status, 'verified', paid.reason);
    assert.equal(paid.extraMintNanos, 0);

    const inflated = [
      honest[0],
      drawBlock(drawTs, miner, [portal], stake + one, stake),
    ];
    const bad = auditCirculatingSupply(inflated);
    assert.equal(bad.status, 'mismatch');
    assert.equal(bad.reason, 'supply');
    assert.notEqual(bad.extraMintNanos, one);
    assert.notEqual(bad.circulatingNanos, potAt(GENESIS) + potAt(drawTs) + one);

    const againTs = drawTs + EPOCH_MS;
    const twice = honest.concat([
      drawBlock(againTs, miner, [portal], stake),
    ]);
    const second = auditCirculatingSupply(twice);
    assert.notEqual(second.status, 'verified', second.reason);
    assert.notEqual(second.extraMintNanos, one);

    let state = emptySupplyState(GENESIS);
    const locked = supplyStep(state, honest[0], {
      height: 1,
      genesisMs: GENESIS,
      tipHeight: 2,
    });
    assert.equal(locked.ok, true, locked.reason);
    state = locked.state;
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

    const openedHigh = drawBlock(drawTs, miner, [portal], honestPay);
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

    const inflatedBlock = drawBlock(drawTs, miner, [portal], honestPay + 1, honestPay);
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
