/**
 * P2-L. verifyReservePayout refuses a withdraw while the credit's own epoch
 * is still open. Epoch 0 is already refused by settlementIndex <= 0. A lock
 * at the start of epoch 1, withdrawn for exactly the principal while that
 * epoch is open, pays no completed interest, so the amount check would pass
 * if the arrival-epoch gate were removed.
 *
 * The fork check (verifyOneForkBlock) calls verifyReservePayout before the
 * body. A public lock never lands, so the book vault has no portal and that
 * call's reason is empty. verifyFork walks the hash-bonus units first, and
 * that walk applies each block's reserve rows (unitsAlongChain, c2df8c2a).
 * The public withdraw does not open, so the apply refuses it as stake_reward
 * at the last fork block before the per-tx check runs. The same receipt is
 * public_receipt on append.
 * The open-arrival refusal is verifyReservePayout on a credited vault.
 * payoutOnTip stays the post-verify call. A receipt the body already
 * rejects never reaches it.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newIdentity, spendDestOf, hash20FromAddress } from '../../crypto/address.js';
import {
  MTP_FUTURE_MS,
  MTP_WINDOW,
  PI_SHE_NANOS,
  RESERVE_EPOCH_MS,
  RESERVE_PROGRAM,
  medianTimePast,
} from '../../crypto/asert.js';
import {
  cloneVault,
  deposit,
  portalEpochInterest,
  portalIdFromDest,
  verifyReservePayout,
} from '../../crypto/reserve_vault.js';
import { bindWeightFee } from '../../crypto/levy.js';
import { decodeHeader } from '../../crypto/header.js';
import { GENESIS_PREV, buildTemplate } from '../src/chain.js';
import { createStore } from '../src/store.js';

const T0 = 1_700_000_000_000;
const STEP_MS = 20 * 60 * 1000;

let powTag = 1;
function easyPowHash() {
  const hash = Buffer.alloc(32);
  hash[2] = powTag & 0xff;
  hash[3] = (powTag >> 8) & 0xff;
  hash[4] = (powTag >> 16) & 0xff;
  powTag += 1;
  return hash;
}

function headerMs(block) {
  return Number(decodeHeader(Buffer.from(block.header)).timestamp);
}

function nextStamp(blocks) {
  const stamps = blocks.map(headerMs);
  const prev = stamps[stamps.length - 1];
  const mtp = medianTimePast(stamps.slice(-MTP_WINDOW));
  let stamp = Math.min(prev + STEP_MS, mtp + MTP_FUTURE_MS);
  if (!(stamp > prev)) stamp = prev + 1;
  return stamp;
}

function asBlock(tpl) {
  return {
    header: tpl.header,
    txs: tpl.txs,
    samples: tpl.samples,
    shareBatch: tpl.shareBatch || [],
    miner: tpl.miner,
    aLeaves: tpl.aLeaves,
    bLeaves: tpl.bLeaves,
    rootA: tpl.rootA,
    rootB: tpl.rootB,
    weight: tpl.weight,
  };
}

function blockAt(store, dest, stamp, extra) {
  const parent = store.tip();
  const { tpl } = store.template({ miner: dest, now: stamp });
  if (!extra) return { ...asBlock(tpl), miner: dest };
  const bits = Number(decodeHeader(Buffer.from(tpl.header)).bits);
  const built = buildTemplate({
    prev: parent ? parent.hash : GENESIS_PREV,
    prevHeader: parent ? parent.header : null,
    prevBlock: parent,
    height: (parent ? parent.height : 0) + 1,
    miner: dest,
    now: stamp,
    bits,
    txs: extra,
    parentBlocks: store.blocks,
  });
  return { ...asBlock(built), miner: dest };
}

async function appendTemplate(store, dest, stamp, extra) {
  const got = await Promise.resolve(store.append(blockAt(store, dest, stamp, extra), {
    trustedPowHash: easyPowHash(),
    skipSharePow: true,
  }));
  assert.equal(got.ok, true, got.reason);
  return headerMs(store.tip());
}

function publicLock(dest, d20) {
  const tx = {
    id: 'lock-epoch-1',
    programId: RESERVE_PROGRAM,
    kind: 'lock',
    nanos: PI_SHE_NANOS,
    // A lock that names payoutPortalId is vote_leak (cb733226). This
    // receipt carries only the portal id, so the receipt gate names it.
    portalId: portalIdFromDest(dest),
    vin: [{ dest20: d20 }],
    vout: [{ kind: 'lock', dest20: d20, valueProof: { v: PI_SHE_NANOS } }],
  };
  bindWeightFee(tx);
  tx.maxLevy = tx.fee;
  return tx;
}

function publicWithdraw(dest, d20) {
  return {
    id: 'withdraw-open-epoch',
    programId: RESERVE_PROGRAM,
    kind: 'withdraw',
    mint: true,
    nanos: PI_SHE_NANOS,
    // A withdraw names its lock by portalId only. payoutPortalId is
    // vote_leak (325b50f5) and would hide the receipt and epoch reasons.
    portalId: portalIdFromDest(dest),
    vin: [{ dest20: d20 }],
    vout: [{ kind: 'withdraw', dest20: d20, valueProof: { v: PI_SHE_NANOS } }],
  };
}

describe('P2-L early withdraw payout', () => {
  it('the fork check and the post-verify payout call refuse an open arrival epoch', { timeout: 180_000 }, async () => {
    const src = fs.readFileSync(new URL('../src/store.js', import.meta.url), 'utf8');
    const payoutFn = src.split('function payoutOnTip')[1].split('function blockTimeMs')[0];
    const forkFn = src.split('function verifyOneForkBlock')[1].split('function noteForkSnap')[0];
    assert.match(payoutFn, /return verifyReservePayout\(reserveVault, tx, clock\)/);
    assert.match(forkFn, /verifyReservePayout\(vault, tx, blockTimeMs\(fork\[i\]\)\)/);

    const who = newIdentity();
    const dest = spendDestOf(who.spendPub);
    const d20 = Buffer.from(hash20FromAddress(dest));
    const store = createStore(fs.mkdtempSync(path.join(os.tmpdir(), 'shear-early-payout-')));
    let ts = await appendTemplate(store, dest, T0);
    let guard = 0;
    while (ts < T0 + RESERVE_EPOCH_MS) {
      ts = await appendTemplate(store, dest, nextStamp(store.blocks));
      guard += 1;
      assert.ok(guard < 400, 'mtp walk did not reach the next epoch');
    }
    assert.ok(ts >= T0 + RESERVE_EPOCH_MS);
    assert.ok(ts < T0 + 2 * RESERVE_EPOCH_MS);
    const lockAt = nextStamp(store.blocks);
    const parentBeforeLock = store.tip();
    const refusedLock = await Promise.resolve(store.append(
      blockAt(store, dest, lockAt, [publicLock(dest, d20)]),
      { trustedPowHash: easyPowHash(), skipSharePow: true },
    ));
    assert.equal(refusedLock.ok, false);
    assert.equal(refusedLock.reason, 'public_receipt');
    assert.equal(store.tip().height, parentBeforeLock.height);
    assert.equal(Number(store.reserveVault.totalLockedNanos), 0);
    const held = cloneVault(store.reserveVault);
    const credited = deposit({
      state: held,
      dest,
      nanos: PI_SHE_NANOS,
      nowMs: ts,
      payout: dest,
      payoutPortalId: portalIdFromDest(dest),
    });
    assert.equal(credited.ok, true, credited.reason);
    const portal = held.portals[portalIdFromDest(dest)];
    const early = publicWithdraw(dest, d20);
    const drawAt = lockAt;
    assert.ok(drawAt > ts);
    assert.ok(drawAt < T0 + 2 * RESERVE_EPOCH_MS);
    assert.equal(portalEpochInterest(held, portal, drawAt), 0);
    const direct = verifyReservePayout(held, early, drawAt);
    assert.equal(direct.ok, false);
    assert.equal(direct.reason, 'epoch_open');

    const parent = store.tip();
    const { tpl } = store.template({ miner: dest, now: drawAt });
    const bits = Number(decodeHeader(Buffer.from(tpl.header)).bits);
    const built = buildTemplate({
      prev: parent.hash,
      prevHeader: parent.header,
      prevBlock: parent,
      height: parent.height + 1,
      miner: dest,
      now: drawAt,
      bits,
      txs: [early],
      parentBlocks: store.blocks,
    });
    const block = { ...asBlock(built), miner: dest, hash: easyPowHash() };
    // The per-tx payout call on the book vault: no portal landed.
    const noPortal = verifyReservePayout(store.reserveVault, early, drawAt);
    assert.equal(noPortal.ok, false);
    assert.equal(noPortal.reason, 'empty');
    const fork = store.blocks.concat([block]);
    const checked = await Promise.resolve(store.verifyFork(fork, {
      trustBlockHash: true,
      skipSharePow: true,
    }));
    // The units walk applies the reserve rows first. An unopened public
    // withdraw is stake_reward there, at the withdraw block.
    assert.equal(checked.ok, false);
    assert.equal(checked.reason, 'stake_reward');
    assert.equal(checked.at, fork.length - 1);

    const appended = await Promise.resolve(store.append(block, {
      trustedPowHash: block.hash,
      skipSharePow: true,
    }));
    assert.equal(appended.ok, false);
    assert.equal(appended.reason, 'public_receipt');
    assert.equal(store.tip().height, parent.height);
    assert.equal(store.queueTx(early, { nowMs: drawAt }).reason, 'public_receipt');
    assert.equal(store.mempool.some((row) => row.id === early.id), false);
  });
});
