/**
 * The vote-enactment block still stores the epoch that just ended.
 * A withdraw in that block must succeed on the store vault, on dev and on
 * v12, and the principal must leave exactly once.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { encodeDest, hash20FromAddress, newIdentity } from '../../crypto/address.js';
import { MAGIC_TESTNET, PI_SHE_NANOS } from '../../crypto/asert.js';
import { chainParams } from '../../crypto/chain_params.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { encodeHeader } from '../../crypto/header.js';
import { openedCoinbaseNanos, sealCoinbaseNote } from '../../crypto/note.js';
import { potSubsidyAt } from '../../crypto/pot_sched.js';
import { nativeLoaded, nativeLoadErrorText } from '../../crypto/native_admit.js';
import { lockTx, ownerFor } from '../../crypto/owned_portal.js';
import {
  applyReserveBlock,
  portalIdFromDest,
  rewardCommitment,
  signWithdrawReward,
  withdrawTx,
} from '../../crypto/reserve_vault.js';
import { createStore } from '../src/store.js';
import { auditCirculatingSupply, foldSupply } from '../src/supply.js';
import { coinbaseTx } from '../src/chain.js';

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

function noteFund(tx, mark) {
  const n = Math.floor(Number(tx.nanos) || 0);
  const sealed = sealCoinbaseNote(n, { dest20: Buffer.alloc(20, mark & 0xff), kind: 'pot' });
  const prev = tx.vin && tx.vin[0] ? tx.vin[0] : {};
  tx.vin = [{
    ...prev,
    commit: sealed.commit,
    valueProof: sealed.valueProof,
    rangeProof: sealed.rangeProof,
  }];
  return tx;
}

function potBlock(ts, magic, genesis, miner, more, rewardRoot) {
  const pot = potSubsidyAt({ nowMs: ts, genesisMs: genesis, magic });
  const tx = coinbaseTx({
    height: 1,
    miner,
    potShares: [{ address: miner, nanos: pot, kind: 'pot' }],
    potNanos: pot,
    carryNanos: 0,
    shareBatch: [],
  });
  if (rewardRoot) tx.rewardRoot = rewardRoot;
  return {
    header: header(ts),
    txs: [tx, ...(more || [])],
    shareBatch: [],
  };
}

function hashStubNanos(block) {
  let n = 0;
  let count = 0;
  let closed = 0;
  for (const o of block?.txs?.[0]?.vout || []) {
    if (String(o?.kind || '') !== 'hash') continue;
    count += 1;
    const got = openedCoinbaseNanos(o);
    if (got == null) {
      closed += 1;
      continue;
    }
    n += got;
  }
  return { n, count, closed };
}

function enactWithdraw(magic) {
  assert.equal(
    nativeLoaded(),
    true,
    `shearadmit.node failed to load: ${nativeLoadErrorText() || 'missing'}`,
  );
  const row = chainParams(magic);
  const genesis = 1_700_000_000_000;
  const enactAt = genesis + row.epochMs;
  const lockAt = genesis;
  assert.ok(lockAt < enactAt);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `shear-enact-${magic}-`));
  const store = createStore(dir, { network: magic });
  assert.equal(store.magic, magic);
  assert.equal(store.reserveVault.magic, magic);
  const miner = encodeDest(Buffer.alloc(20, magic === 'shear-dev' ? 3 : 4));
  const dest = portalDest();
  const lock = noteFund(lockTx({
    from: miner,
    to: dest,
    nanos: PI_SHE_NANOS,
    id: `lock-${magic}`,
  }), 1);
  const locked = applyReserveBlock({
    state: store.reserveVault,
    block: { height: 1, txs: [lock] },
    nowMs: lockAt,
    genesisMs: genesis,
    requireStakeReward: true,
  });
  const lockRows = locked.filter((r) => r && r.action === 'lock');
  assert.equal(lockRows.length, 1, `${magic} lock rows ${locked.length} ${locked.reason || ''}`);
  assert.equal(lockRows[0].ok, true, `${magic} lock ${lockRows[0].reason}`);
  assert.equal(store.reserveVault.totalLockedNanos, BigInt(PI_SHE_NANOS));
  const lockedPortal = store.reserveVault.portals[portalIdFromDest(dest)];
  assert.equal(lockedPortal.staked, BigInt(PI_SHE_NANOS));
  assert.equal(store.reserveVault.bonusEnacted, false);
  assert.equal(store.reserveVault.epochStartMs, genesis);
  const who = ownerFor(dest);
  const draw = withdrawTx({
    from: dest,
    to: miner,
    nanos: PI_SHE_NANOS,
    id: `wd-${magic}`,
  });
  signWithdrawReward(draw, who.key, {
    portalId: portalIdFromDest(dest),
    nanos: PI_SHE_NANOS,
    dest: miner,
    state: store.reserveVault,
    nowMs: enactAt,
  });
  const plan = rewardCommitment(store.reserveVault, enactAt);
  const coinbase = { coinbase: true, vout: [] };
  if (plan.rows.length) coinbase.rewardRoot = plan.root;
  const applied = applyReserveBlock({
    state: store.reserveVault,
    block: { height: 2, txs: [coinbase, draw] },
    nowMs: enactAt,
    genesisMs: genesis,
    requireStakeReward: true,
  });
  assert.equal(applied.ok, true, `${magic} enact ${applied.reason}`);
  const pays = applied.filter((r) => r && r.action === 'withdraw' && r.ok === true);
  assert.equal(pays.length, 1);
  assert.equal(pays[0].principal, PI_SHE_NANOS);
  assert.equal(pays[0].interest, 0);
  assert.equal(pays[0].payout, PI_SHE_NANOS);
  assert.equal(store.reserveVault.bonusEnacted, true);
  assert.equal(store.reserveVault.epochStartMs, genesis);
  assert.equal(Number(store.reserveVault.totalLockedNanos), 0);
  const portal = store.reserveVault.portals[portalIdFromDest(dest)];
  assert.equal(portal.redeemedNanos, BigInt(PI_SHE_NANOS));
  const again = withdrawTx({
    from: dest,
    to: miner,
    nanos: PI_SHE_NANOS,
    id: `wd-${magic}-2`,
  });
  signWithdrawReward(again, who.key, {
    portalId: portalIdFromDest(dest),
    nanos: PI_SHE_NANOS,
    dest: miner,
    state: store.reserveVault,
    nowMs: enactAt + row.targetBlockMs,
  });
  const second = applyReserveBlock({
    state: store.reserveVault,
    block: { height: 3, txs: [again] },
    nowMs: enactAt + row.targetBlockMs,
    genesisMs: genesis,
    requireStakeReward: true,
  });
  const secondRows = (second || []).filter((r) => r && r.action === 'withdraw');
  assert.equal(second.ok, false, `${magic} second withdraw`);
  assert.equal(second.reason, 'empty');
  assert.equal(secondRows.length, 1);
  assert.equal(secondRows[0].ok, false);
  assert.equal(secondRows[0].reason, 'empty');
  assert.equal(portal.redeemedNanos, BigInt(PI_SHE_NANOS));
  const lockBlock = potBlock(lockAt, magic, genesis, miner, [lock]);
  const drawBlock = potBlock(enactAt, magic, genesis, miner, [draw], plan.rows.length ? plan.root : undefined);
  // Empty share batch. coinbaseTx mints no hash note, so this reads the
  // builder output. Stripping hash rows first would make a zero count vacuous.
  const lockStub = hashStubNanos(lockBlock);
  const drawStub = hashStubNanos(drawBlock);
  assert.equal(lockStub.count, 0);
  assert.equal(lockStub.closed, 0);
  assert.equal(lockStub.n, 0);
  assert.equal(drawStub.count, 0);
  assert.equal(drawStub.closed, 0);
  assert.equal(drawStub.n, 0);
  const chain = [lockBlock, drawBlock];
  if (magic === MAGIC_TESTNET) {
    const folded = foldSupply(chain, { genesisMs: genesis, magic });
    assert.equal(folded.ok, true, `v12 fold ${folded.reason}`);
    assert.equal(folded.state.mintedInterest, 0n);
    const audit = auditCirculatingSupply(chain, { magic });
    assert.equal(audit.status, 'verified', audit.reason);
    assert.equal(audit.extraMintNanos, 0);
    assert.equal(audit.measuredHashNanos, 0);
    assert.equal(audit.vaultPrincipalNanos, 0);
    const pot = potSubsidyAt({ nowMs: lockAt, genesisMs: genesis, magic })
      + potSubsidyAt({ nowMs: enactAt, genesisMs: genesis, magic });
    assert.equal(audit.circulatingNanos, pot);
  }
  if (magic === 'shear-dev') {
    // π stays note-backed. It is not an extra mint, and the empty batch
    // adds no hash stub.
    const lockedFold = foldSupply([lockBlock], { genesisMs: genesis, magic });
    assert.equal(lockedFold.ok, true, `dev lock fold ${lockedFold.reason}`);
    assert.equal(lockedFold.state.vaultPrincipal, BigInt(PI_SHE_NANOS));
    assert.equal(lockedFold.state.mintedInterest, 0n);
    const lockedAudit = auditCirculatingSupply([lockBlock], { magic });
    assert.equal(lockedAudit.status, 'verified', lockedAudit.reason);
    assert.equal(lockedAudit.extraMintNanos, 0);
    assert.equal(lockedAudit.measuredHashNanos, 0);
    assert.equal(lockedAudit.vaultPrincipalNanos, PI_SHE_NANOS);
    assert.equal(
      lockedAudit.circulatingNanos,
      potSubsidyAt({ nowMs: lockAt, genesisMs: genesis, magic }),
    );
    // bonusUnitsBefore walks emptyVault(), and vaultApply passes the v12
    // magic. This withdraw is the dev enactment instant, still inside that
    // v12 epoch, so the two-block walk stops at epoch_open. The refused
    // row is not a second mint.
    const folded = foldSupply(chain, { genesisMs: genesis, magic });
    assert.equal(folded.ok, false, 'dev enactment fold');
    assert.equal(folded.reason, 'epoch_open');
    const audit = auditCirculatingSupply(chain, { magic });
    assert.notEqual(audit.status, 'verified');
    assert.equal(audit.extraMintNanos, 0);
    assert.equal(audit.measuredHashNanos, 0);
  }
  return { store, drawBlock };
}

describe('enactment-block withdraw on the store vault', () => {
  it('dev lock then withdraw pays principal once', () => {
    enactWithdraw('shear-dev');
  });

  it('v12 lock then withdraw pays principal once', () => {
    enactWithdraw('shear-testnet-v12');
  });
});
