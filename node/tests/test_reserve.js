import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { printConfig } from '../src/node.js';
import { createStore } from '../src/store.js';
import { mineTemplate } from '../src/chain.js';
import { decodeHeader } from '../../crypto/header.js';
import {
  RESERVE_PROGRAM,
  PI_SHE_NANOS,
  RESERVE_EPOCH_MS,
  LIVE_MIN_BITS,
  SPENDABLE_CONFIRMATIONS,
  NANOS_PER_SHE,
  HASH_BONUS_NANOS,
  INTEREST_DENOM_DAYS,
} from '../../crypto/asert.js';
import { RESERVE_ORACLE_ID, RESERVE_ORACLE_DEFAULT_BPS, interestNanos } from '../../crypto/reserve_oracle.js';
import {
  publicVaultView,
  previewWithdraw,
  lockTx,
  withdrawTx,
  voteTx,
  portalIdFromDest,
  VOTE_INCREASE,
} from '../../crypto/reserve_vault.js';
import { sampleCapExceeded, sampleCountCap } from '../src/chain.js';
import { explorerRecentTxs, reconstructOwner } from '../../pool/src/wallet_api.js';
import { roundActualHashes } from '../../pool/src/hash_credit.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { newIdentity, destOpeningFromView, hash20FromAddress, payoutDest, freshStealthDest, ed25519SeedOf } from '../../crypto/address.js';
import { vaultDest, destForLogin, destAtIndex } from '../../crypto/flow_sheet.js';
import { matureSpendableNanos, signSpendTx } from '../../crypto/spend.js';
import { levyNanos } from '../../crypto/levy.js';
import { attachDummyOuts } from '../../crypto/dummy.js';

function spendBox(id) {
  const pay = freshStealthDest(id.paymentCode);
  return {
    dest: pay.dest,
    key: { type: 'ed25519-stealth', seed: ed25519SeedOf(id.privateKey), shared: pay.shared },
  };
}

async function mineOne(store, dest, { bits = 4, now } = {}) {
  const parent = store.tip();
  const stamp = now != null
    ? now
    : (parent
      ? Number(decodeHeader(Buffer.from(parent.header)).timestamp) + 90_000
      : Date.now());
  const { tpl } = store.template({ miner: dest, bits, shareBits: bits, now: stamp });
  const found = mineTemplate(tpl, { maxTries: 3_000_000, shareBits: bits });
  assert.ok(found && found.block, 'need pow');
  const got = await store.append({
    header: found.header,
    txs: tpl.txs,
    samples: tpl.samples,
    shareBatch: tpl.shareBatch || [],
    miner: dest,
    aLeaves: tpl.aLeaves,
    bLeaves: tpl.bLeaves,
    rootA: tpl.rootA,
    rootB: tpl.rootB,
    weight: tpl.weight,
  });
  assert.equal(got.ok, true, got.reason || got.error);
  return got;
}

function spendableOf(store, dest) {
  const tipH = Number(store.tip()?.height || 0);
  return matureSpendableNanos(store.historyFor(dest), dest, tipH);
}

describe('node Reserve vault', () => {
  it('printConfig names the Reserve oracle and epoch', () => {
    const c = printConfig();
    assert.equal(c.reserveProgram, RESERVE_PROGRAM);
    assert.equal(c.extraMintOnlyReserve, true);
    assert.equal(c.reserveEpochDays, 400);
    assert.equal(c.reserveJoinCutoffDays, 99);
    assert.equal(c.reserveOracle, RESERVE_ORACLE_ID);
    assert.equal(c.reserveOracleDefaultBps, RESERVE_ORACLE_DEFAULT_BPS);
    assert.equal(c.reserveOracleDefaultBps, 264);
    assert.equal(c.reserveEpochDays, 400);
    assert.equal(c.interestDenomDays, INTEREST_DENOM_DAYS);
    assert.equal(c.interestDenomDays, 400);
    assert.equal(c.hashBonusNanos, HASH_BONUS_NANOS);
    assert.equal(c.hashBonusNanos, 1);
    assert.equal(c.mainnet, false);
    assert.equal(c.magic, 'shear-testnet-v3');
  });

  it('lock spends mature Continuum, refuses when spendable is short, withdraw returns principal + staked interest', { timeout: 600_000 }, async () => {
    const alice = newIdentity();
    const aliceBox = spendBox(alice);
    const continuum = aliceBox.dest;
    const vault = vaultDest(alice.address, { viewKey: alice.viewKey });
    const open = destOpeningFromView(alice.viewKey, alice.spendPub, 0);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-reserve-append-'));
    const store = createStore(dir);
    const t0 = 1_700_000_000_000;
    const pid = portalIdFromDest(vault);

    const lockL = levyNanos(PI_SHE_NANOS);
    const lock = lockTx({ from: continuum, to: vault, nanos: PI_SHE_NANOS, id: 'lock-1' });
    lock.open = open;
    lock.fee = lockL;
    lock.maxLevy = lockL;
    signSpendTx(lock, aliceBox.key);

    const unfunded = store.queueTx(lock);
    assert.equal(unfunded.ok, false);
    assert.equal(unfunded.reason, 'insufficient');
    assert.equal(Number(store.reserveVault.totalLockedNanos), 0);

    const fundBlocks = 4;
    for (let i = 0; i < fundBlocks + SPENDABLE_CONFIRMATIONS; i += 1) {
      await mineOne(store, continuum, { bits: LIVE_MIN_BITS, now: t0 + i * 90_000 });
    }
    const before = spendableOf(store, continuum);
    assert.ok(before >= fundBlocks * NANOS_PER_SHE, `spendable ${before} after ${fundBlocks} pots`);
    assert.ok(before >= PI_SHE_NANOS + lockL);

    const unsignedLock = lockTx({ from: continuum, to: vault, nanos: PI_SHE_NANOS, id: 'lock-unsigned' });
    unsignedLock.fee = lockL;
    unsignedLock.maxLevy = lockL;
    const unsigned = store.queueTx(unsignedLock);
    assert.equal(unsigned.ok, false);
    assert.equal(unsigned.reason, 'unsigned');
    assert.equal(Number(store.reserveVault.totalLockedNanos), 0);
    assert.equal(spendableOf(store, continuum), before);

    const tooMuch = lockTx({
      from: continuum,
      to: vault,
      nanos: before + NANOS_PER_SHE,
      id: 'lock-too-much',
    });
    tooMuch.open = open;
    tooMuch.fee = levyNanos(tooMuch.nanos);
    tooMuch.maxLevy = tooMuch.fee;
    signSpendTx(tooMuch, aliceBox.key);
    const refused = store.queueTx(tooMuch);
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, 'insufficient');
    assert.equal(Number(store.reserveVault.totalLockedNanos), 0);
    assert.equal(store.reserveVault.portals[pid], undefined);
    assert.equal(spendableOf(store, continuum), before);

    const queued = store.queueTx(lock);
    assert.equal(queued.ok, true, queued.reason);
    await mineOne(store, continuum, {
      bits: LIVE_MIN_BITS,
      now: t0 + (fundBlocks + SPENDABLE_CONFIRMATIONS) * 90_000,
    });
    assert.equal(store.reserveVault.epochStartMs > 0, true);
    assert.equal(Number(store.reserveVault.totalLockedNanos), PI_SHE_NANOS);
    assert.equal(Number(store.reserveVault.portals[pid].staked), PI_SHE_NANOS);
    assert.equal(store.reserveVault.portals[pid].joined, true);
    const afterLock = spendableOf(store, continuum);
    // Mining the lock block also matures one more prior pot (same miner).
    assert.equal(afterLock, before - PI_SHE_NANOS - lockL + NANOS_PER_SHE);
    const pub = JSON.stringify(publicVaultView(store.reserveVault, t0));
    assert.equal(pub.includes(alice.address), false);
    assert.equal(pub.includes(alice.viewKey), false);
    assert.equal(pub.includes('shear1'), false);

    const preview = previewWithdraw(store.reserveVault, vault);
    assert.equal(preview.to, continuum);
    assert.ok(preview.interest > 0);
    assert.equal(preview.interest, interestNanos(PI_SHE_NANOS, RESERVE_ORACLE_DEFAULT_BPS, 400));
    assert.equal(preview.payout, PI_SHE_NANOS + preview.interest);

    const again = createStore(dir);
    assert.equal(Number(again.reserveVault.totalLockedNanos), PI_SHE_NANOS);
    const dumped = JSON.stringify(again.reserveVault, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
    assert.equal(dumped.includes(alice.address), false);
    assert.equal(dumped.includes(alice.viewKey), false);
  });

  it('hash bonus is proven-only; sample_cap; no 365 on interest paths', () => {
    assert.equal(roundActualHashes({ roundHashes: 256, clientHashes: 9e12, clientHashesRound0: 0 }), 256);
    assert.equal(roundActualHashes({ roundHashes: 0, clientHashes: 9e12, clientHashesRound0: 0 }), 0);
    assert.equal(HASH_BONUS_NANOS, 1);
    assert.equal(sampleCountCap(17), 2n ** 17n * 16n);
    assert.equal(sampleCapExceeded([{ miner: 'ssa1a', count: 630130 }], 17), false);
    assert.equal(sampleCapExceeded([{ miner: 'ssa1a', count: Number((1n << 17n) * 16n) + 1 }], 17), true);
    assert.equal(sampleCapExceeded([{ miner: 'ssa1a', count: Number((1n << 8n) * 16n) + 1 }], 8), true);
    const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
    for (const rel of [
      'crypto/reserve_oracle.js',
      'crypto/reserve_vault.js',
      'contracts/Reserve.sol',
      'crypto/reserve_evm.js',
    ]) {
      const src = fs.readFileSync(join(root, rel), 'utf8');
      for (const line of src.split('\n')) {
        if (!/\b365\b/.test(line)) continue;
        assert.match(line, /do not use 365/, `${rel}: ${line}`);
      }
    }
  });

  it('GATE still accepts a reused dest', () => {
    const alice = newIdentity();
    const dest = freshStealthDest(alice.paymentCode).dest;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-reuse-dest-'));
    const store = createStore(dir);
    const mk = (id) => attachDummyOuts({
      id,
      kind: 'send',
      from: dest,
      to: dest,
      nanos: 2,
      fee: levyNanos(2, { depth: 1e9 }),
      vout: [{ address: dest, nanos: 2, kind: 'send' }],
    });
    const a = store.queueTx(mk('reuse-a'));
    const b = store.queueTx(mk('reuse-b'));
    assert.equal(a.ok, true, a.reason);
    assert.equal(b.ok, true, b.reason);
    assert.equal(a.tx?.to || dest, dest);
  });

  it('Reserve lock then vote in mempool paint (pending) before the next block', { timeout: 600_000 }, async () => {
    const alice = newIdentity();
    const aliceBox = spendBox(alice);
    const continuum = aliceBox.dest;
    const vault = vaultDest(alice.address, { viewKey: alice.viewKey });
    const open = destOpeningFromView(alice.viewKey, alice.spendPub, 0);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-reserve-pending-'));
    const store = createStore(dir);
    const t0 = 1_700_000_000_000;
    for (let i = 0; i < 4 + SPENDABLE_CONFIRMATIONS; i += 1) {
      await mineOne(store, continuum, { bits: LIVE_MIN_BITS, now: t0 + i * 90_000 });
    }
    const lockL = levyNanos(PI_SHE_NANOS);
    const lock = lockTx({ from: continuum, to: vault, nanos: PI_SHE_NANOS, id: 'lock-pend' });
    lock.open = open;
    lock.fee = lockL;
    lock.maxLevy = lockL;
    signSpendTx(lock, aliceBox.key);
    const q = store.queueTx(lock);
    assert.equal(q.ok, true, q.reason);
    const painted = explorerRecentTxs(store);
    const lockRow = painted.find((t) => t.id === 'lock-pend');
    assert.ok(lockRow, JSON.stringify(painted.slice(0, 5)));
    assert.equal(lockRow.kind, 'lock');
    assert.equal(lockRow.status, 'pending');
    assert.equal(lockRow.pending, true);
    assert.ok(String(lockRow.to).startsWith('ssa1'));
    assert.equal(/she1|shear1/i.test(JSON.stringify(lockRow)), false);
    await mineOne(store, continuum, {
      bits: LIVE_MIN_BITS,
      now: t0 + (4 + SPENDABLE_CONFIRMATIONS) * 90_000,
    });
    const voteL = levyNanos(0);
    const vt = voteTx({ from: continuum, dest: vault, choice: VOTE_INCREASE, id: 'vote-pend' });
    vt.open = open;
    vt.portalOpen = open;
    vt.fee = voteL;
    vt.maxLevy = voteL;
    vt.payer = continuum;
    signSpendTx(vt, aliceBox.key);
    const qv = store.queueTx(vt);
    assert.equal(qv.ok, true, qv.reason);
    const afterVote = explorerRecentTxs(store);
    const voteRow = afterVote.find((t) => t.id === 'vote-pend');
    assert.ok(voteRow, JSON.stringify(afterVote.filter((t) => t.kind === 'vote' || t.kind === 'lock')));
    assert.equal(voteRow.kind, 'vote');
    assert.equal(voteRow.status, 'pending');
    assert.equal(/she1|shear1/i.test(JSON.stringify(voteRow)), false);
    const bad = lockTx({ from: continuum, to: vault, nanos: 1, id: 'lock-rejected' });
    const refused = store.queueTx(bad);
    assert.equal(refused.ok, false);
    assert.equal(explorerRecentTxs(store).some((t) => t.id === 'lock-rejected'), false);
    await mineOne(store, continuum, {
      bits: LIVE_MIN_BITS,
      now: t0 + (5 + SPENDABLE_CONFIRMATIONS) * 90_000,
    });
    assert.equal(store.reserveVault.votes.increase, 1);
    assert.equal(explorerRecentTxs(store).some((t) => t.id === 'lock-rejected' && t.status === 'confirmed'), false);
    for (let i = 1; i <= SPENDABLE_CONFIRMATIONS; i += 1) {
      await mineOne(store, continuum, {
        bits: LIVE_MIN_BITS,
        now: t0 + (5 + SPENDABLE_CONFIRMATIONS + i) * 90_000,
      });
    }
    const sealed = explorerRecentTxs(store).find((t) => String(t.id).startsWith('lock-pend'));
    assert.ok(sealed);
    assert.equal(sealed.status, 'confirmed');
    assert.equal(sealed.pending, false);
  });

  it('change vout leftover reconstructs onto the change dest, not from', { timeout: 600_000 }, async () => {
    const alice = newIdentity();
    const bob = newIdentity();
    const minerId = newIdentity();
    const aliceBox = spendBox(alice);
    const destA = aliceBox.dest;
    const destC = destAtIndex(alice.address, { index: 1, viewKey: alice.viewKey });
    const destB = freshStealthDest(bob.paymentCode).dest;
    const minerDest = freshStealthDest(minerId.paymentCode).dest;
    const open = destOpeningFromView(alice.viewKey, alice.spendPub, 0);
    assert.ok(destA.startsWith('ssa1'));
    assert.ok(destC.startsWith('ssa1'));
    assert.ok(destB.startsWith('ssa1'));
    assert.notEqual(destA, destC);
    assert.notEqual(destA, destB);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-change-vout-'));
    const store = createStore(dir);
    const t0 = 1_700_000_000_000;
    await mineOne(store, destA, { bits: LIVE_MIN_BITS, now: t0 });
    for (let i = 1; i < SPENDABLE_CONFIRMATIONS; i += 1) {
      await mineOne(store, minerDest, { bits: LIVE_MIN_BITS, now: t0 + i * 90_000 });
    }
    const fundH = Number(store.tip().height);
    const before = matureSpendableNanos(store.historyFor(destA), destA, fundH);
    assert.ok(before >= NANOS_PER_SHE, `funded dest A ${before}`);

    const pay = Math.floor(0.1 * NANOS_PER_SHE);
    const fee = levyNanos(pay);
    const leftover = before - pay - fee;
    assert.ok(leftover > 0, `leftover ${leftover}`);
    const queued = store.queueTx(signSpendTx(attachDummyOuts({
      id: 'flow-change-1',
      kind: 'send',
      from: destA,
      to: destB,
      nanos: pay,
      fee,
      maxLevy: fee,
      open,
      vin: [{ address: destA }],
      vout: [
        { address: destB, nanos: pay, kind: 'send' },
        { address: destC, nanos: leftover, kind: 'send' },
      ],
    }), aliceBox.key));
    assert.equal(queued.ok, true, queued.reason);

    await mineOne(store, minerDest, {
      bits: LIVE_MIN_BITS,
      now: t0 + SPENDABLE_CONFIRMATIONS * 90_000,
    });
    const sealedH = Number(store.tip().height);
    assert.equal(matureSpendableNanos(store.historyFor(destA), destA, sealedH), 0);
    assert.equal(reconstructOwner(store, destA).spendableNanos, 0);
    assert.equal(reconstructOwner(store, destC).spendableNanos, 0);

    const payRow = store.historyFor(destB).find((r) => r.to === destB && Number(r.nanos) === pay);
    const changeRow = store.historyFor(destC).find((r) => r.to === destC && Number(r.nanos) === leftover);
    assert.ok(payRow, JSON.stringify(store.historyFor(destB)));
    assert.ok(changeRow, JSON.stringify(store.historyFor(destC)));
    assert.ok(String(payRow.to).startsWith('ssa1'));
    assert.ok(String(changeRow.to).startsWith('ssa1'));
    assert.equal(payRow.kind, 'send');
    assert.equal(changeRow.kind, 'send');
    assert.equal(payRow.from, destA);
    assert.equal(changeRow.from, destA);
    assert.equal(/she1|shear1|memoPlain/i.test(JSON.stringify([payRow, changeRow])), false);

    for (let i = 1; i <= SPENDABLE_CONFIRMATIONS; i += 1) {
      await mineOne(store, minerDest, {
        bits: LIVE_MIN_BITS,
        now: t0 + (SPENDABLE_CONFIRMATIONS + i) * 90_000,
      });
    }
    const matureH = Number(store.tip().height);
    assert.equal(matureSpendableNanos(store.historyFor(destA), destA, matureH), 0);
    assert.equal(reconstructOwner(store, destA).spendableNanos, 0);
    assert.equal(matureSpendableNanos(store.historyFor(destC), destC, matureH), leftover);
    assert.equal(reconstructOwner(store, destC).spendableNanos, leftover);
  });
});
