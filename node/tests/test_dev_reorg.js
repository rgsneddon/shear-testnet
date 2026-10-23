/**
 * A shear-dev reorg that crosses the 288s epoch must be adopted, and the
 * vault replay must use that book's clock. The v12 replay of the same
 * enactment withdraw is still inside the 4-day epoch and is refused.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { encodeDest, newIdentity } from '../../crypto/address.js';
import { PI_SHE_NANOS } from '../../crypto/asert.js';
import { chainParams } from '../../crypto/chain_params.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { decodeHeader, encodeHeader } from '../../crypto/header.js';
import { sealCoinbaseNote } from '../../crypto/note.js';
import { potSubsidyAt } from '../../crypto/pot_sched.js';
import { nativeLoaded, nativeLoadErrorText } from '../../crypto/native_admit.js';
import { lockTx, ownerFor } from '../../crypto/owned_portal.js';
import {
  applyReserveBlock,
  emptyVault,
  bonusUnitsBefore,
  portalIdFromDest,
  signWithdrawReward,
  withdrawTx,
} from '../../crypto/reserve_vault.js';
import { vaultCommitment } from '../../crypto/vault_seal.js';
import { createStore } from '../src/node.js';
import { coinbaseTx } from '../src/chain.js';
import { foldSupply, vaultAfterBlock, vaultParent } from '../src/supply.js';

const GENESIS = 1_700_000_000_000;
const STEP_MS = 9000;
const TRUST = { trustBlockHash: true, skipSharePow: true };
const DEV = 'shear-dev';

function easyPowHash(tag) {
  const h = Buffer.alloc(32);
  h[4] = tag & 0xff;
  h[5] = (tag >> 8) & 0xff;
  h[6] = (tag >> 16) & 0xff;
  return h;
}

function mine(store, dest, from, to, tagBase) {
  for (let h = from; h <= to; h += 1) {
    const stamp = GENESIS + (h - 1) * STEP_MS;
    const { tpl } = store.template({ miner: dest, shareBits: 4, now: stamp });
    const got = store.append({
      header: tpl.header,
      txs: tpl.txs,
      samples: tpl.samples,
      miner: dest,
      shareBatch: tpl.shareBatch || [],
      aLeaves: tpl.aLeaves,
      bLeaves: tpl.bLeaves,
      rootA: tpl.rootA,
      rootB: tpl.rootB,
      weight: tpl.weight,
    }, { trustedPowHash: easyPowHash(tagBase + h), skipSharePow: true });
    assert.equal(got.ok, true, got.reason || `height ${h}`);
  }
}

function replayChain(blocks, magic) {
  let vault = emptyVault(magic);
  const prior = [];
  for (const block of blocks) {
    const advanced = vaultAfterBlock(vault, block, prior, magic);
    assert.equal(advanced.ok, true, `replay height ${prior.length + 1}`);
    assert.ok(advanced.vault);
    vault = advanced.vault;
    prior.push(block);
  }
  return vault;
}

function sameVault(replay, live) {
  assert.equal(replay.magic, live.magic);
  assert.equal(replay.genesisMs, live.genesisMs);
  assert.equal(replay.epochStartMs, live.epochStartMs);
  assert.equal(replay.currentEpoch, live.currentEpoch);
  assert.equal(replay.bonusEnacted, live.bonusEnacted);
  assert.equal(replay.totalLockedNanos, live.totalLockedNanos);
  assert.equal(vaultCommitment(replay), vaultCommitment(live));
}

describe('shear-dev reorg across an epoch', () => {
  it('adopts the heavier fork and the replay matches the live vault', async () => {
    const epochMs = chainParams(DEV).epochMs;
    const dest = encodeDest(Buffer.alloc(20, 5));
    const local = createStore(fs.mkdtempSync(path.join(os.tmpdir(), 'shear-dev-reorg-local-')), { network: DEV });
    const peer = createStore(fs.mkdtempSync(path.join(os.tmpdir(), 'shear-dev-reorg-peer-')), { network: DEV });
    mine(local, dest, 1, 34, 0);
    const shared = await Promise.resolve(peer.ingest(local.blocks.slice(0, 1), TRUST));
    assert.equal(shared.ok, true, shared.reason);
    mine(peer, dest, 2, 35, 400);
    assert.equal(local.tip().height, 34);
    assert.equal(peer.tip().height, 35);
    const boundary = GENESIS + epochMs;
    const peerTipTs = Number(decodeHeader(Buffer.from(peer.tip().header)).timestamp);
    assert.ok(peerTipTs >= boundary, `peer tip ${peerTipTs} is still inside the epoch`);
    const reorg = await Promise.resolve(local.ingest(peer.blocks.slice(1), TRUST));
    assert.equal(reorg.ok, true, reorg.reason);
    assert.equal(reorg.reorg, true);
    assert.equal(local.tip().height, 35);
    assert.equal(
      Buffer.from(local.tip().hash).equals(Buffer.from(peer.tip().hash)),
      true,
    );
    const tipTs = Number(decodeHeader(Buffer.from(local.tip().header)).timestamp);
    assert.ok(tipTs >= boundary);
    assert.equal(local.reserveVault.magic, DEV);
    const replay = replayChain(local.blocks, DEV);
    sameVault(replay, local.reserveVault);
    const units = bonusUnitsBefore(local.blocks, DEV);
    assert.ok(Array.isArray(units));
    assert.equal(units.length, local.blocks.length);
    const folded = foldSupply(local.blocks, { magic: DEV });
    assert.equal(folded.ok, true, folded.reason);
  });

  it('replays a lock and enactment withdraw on the dev clock', () => {
    assert.equal(
      nativeLoaded(),
      true,
      `shearadmit.node failed to load: ${nativeLoadErrorText() || 'missing'}`,
    );
    const row = chainParams(DEV);
    const lockAt = GENESIS;
    const enactAt = GENESIS + row.epochMs;
    const miner = encodeDest(Buffer.alloc(20, 9));
    const id = newIdentity();
    const dest = destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
    const lock = lockTx({ from: miner, to: dest, nanos: PI_SHE_NANOS, id: 'reorg-lock' });
    const sealed = sealCoinbaseNote(PI_SHE_NANOS, { dest20: Buffer.alloc(20, 9), kind: 'pot' });
    const prev = lock.vin && lock.vin[0] ? lock.vin[0] : {};
    lock.vin = [{
      ...prev,
      commit: sealed.commit,
      valueProof: sealed.valueProof,
      rangeProof: sealed.rangeProof,
    }];
    const signing = emptyVault(DEV);
    const locked = applyReserveBlock({
      state: signing,
      block: { height: 1, txs: [lock] },
      nowMs: lockAt,
      genesisMs: GENESIS,
      requireStakeReward: true,
    });
    const lockRow = (locked || []).find((r) => r && r.action === 'lock');
    assert.equal(lockRow && lockRow.ok, true, lockRow && lockRow.reason);
    const draw = withdrawTx({ from: dest, to: miner, nanos: PI_SHE_NANOS, id: 'reorg-wd' });
    signWithdrawReward(draw, ownerFor(dest).key, {
      portalId: portalIdFromDest(dest),
      nanos: PI_SHE_NANOS,
      dest: miner,
      state: signing,
      nowMs: enactAt,
    });
    const header = (ts) => encodeHeader({
      prevBlockHash: Buffer.alloc(32),
      merkleRoot: Buffer.alloc(32),
      continuityRoot: Buffer.alloc(32),
      timestamp: ts,
      bits: 16,
    });
    const potBlock = (ts, more) => {
      const pot = potSubsidyAt({ nowMs: ts, genesisMs: GENESIS, magic: DEV });
      const tx = coinbaseTx({
        height: 1,
        miner,
        potShares: [{ address: miner, nanos: pot, kind: 'pot' }],
        potNanos: pot,
        carryNanos: 0,
        shareBatch: [],
      });
      return { header: header(ts), txs: [tx, ...more], shareBatch: [] };
    };
    const chain = [potBlock(lockAt, [lock]), potBlock(enactAt, [draw])];
    const live = emptyVault(DEV);
    for (const [i, block] of chain.entries()) {
      const applied = applyReserveBlock({
        state: live,
        block,
        nowMs: i === 0 ? lockAt : enactAt,
        genesisMs: GENESIS,
      });
      assert.equal(applied.ok, true, `live ${i} ${applied.reason}`);
    }
    assert.equal(live.magic, DEV);
    assert.equal(live.epochStartMs, GENESIS);
    assert.equal(live.bonusEnacted, true);
    assert.equal(live.totalLockedNanos, 0n);
    const replay = vaultParent(chain, chain.length, DEV);
    assert.equal(replay.ok, true);
    sameVault(replay.vault, live);
    assert.equal(vaultParent(chain, chain.length).ok, false);
    assert.equal(vaultParent(chain, chain.length, 'shear-testnet-v12').ok, false);
    const units = bonusUnitsBefore(chain, DEV);
    assert.ok(Array.isArray(units));
    assert.equal(units.length, chain.length);
    assert.equal(bonusUnitsBefore(chain), null);
  });
});
