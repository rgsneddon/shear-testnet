/**
 * P2-L. verifyReservePayout refuses a withdraw while the credit's own epoch
 * is still open. Epoch 0 is already refused by settlementIndex <= 0. A lock
 * at the start of epoch 1, withdrawn for exactly the principal while that
 * epoch is open, pays no completed interest, so the amount check would pass
 * if the arrival-epoch gate were removed.
 *
 * The fork check (verifyOneForkBlock) calls verifyReservePayout before the
 * body. The same public receipt fails that body as mint_amount, so the fork
 * reason is epoch_open only while that call stays. payoutOnTip is the
 * post-verify call used when a mempool tx is sealed into a block. A receipt
 * the body already rejects never reaches it, so the test keeps that call in
 * place. Mempool admission of this receipt stops on the admit shape before
 * the vault trial.
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

async function appendTemplate(store, dest, stamp, extra) {
  const parent = store.tip();
  const { tpl } = store.template({ miner: dest, now: stamp });
  let block = { ...asBlock(tpl), miner: dest };
  if (extra) {
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
    block = { ...asBlock(built), miner: dest };
  }
  const got = await Promise.resolve(store.append(block, {
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
    portalId: portalIdFromDest(dest),
    payoutPortalId: portalIdFromDest(dest),
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
    portalId: portalIdFromDest(dest),
    payoutPortalId: portalIdFromDest(dest),
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
    const lockedAt = await appendTemplate(store, dest, nextStamp(store.blocks), [publicLock(dest, d20)]);
    assert.ok(lockedAt >= T0 + RESERVE_EPOCH_MS);
    assert.ok(lockedAt < T0 + 2 * RESERVE_EPOCH_MS);
    assert.equal(Number(store.reserveVault.totalLockedNanos), PI_SHE_NANOS);
    const portal = store.reserveVault.portals[portalIdFromDest(dest)];
    const early = publicWithdraw(dest, d20);
    const drawAt = nextStamp(store.blocks);
    assert.ok(drawAt > lockedAt);
    assert.ok(drawAt < T0 + 2 * RESERVE_EPOCH_MS);
    assert.equal(portalEpochInterest(store.reserveVault, portal, drawAt), 0);
    const direct = verifyReservePayout(store.reserveVault, early, drawAt);
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
    const fork = store.blocks.concat([block]);
    const checked = await Promise.resolve(store.verifyFork(fork, {
      trustBlockHash: true,
      skipSharePow: true,
    }));
    assert.equal(checked.ok, false);
    assert.equal(checked.reason, 'epoch_open');
    assert.equal(checked.at, fork.length - 1);

    const appended = await Promise.resolve(store.append(block, {
      trustedPowHash: block.hash,
      skipSharePow: true,
    }));
    assert.equal(appended.ok, false);
    assert.equal(appended.reason, 'mint_amount');
    assert.equal(store.tip().height, parent.height);
    assert.equal(store.queueTx(early, { nowMs: drawAt }).ok, false);
    assert.equal(store.mempool.some((row) => row.id === early.id), false);
  });
});
