/**
 * Pruning is on: the spend block is buried SAMPLE_PRUNE_CONFIRMATIONS deep,
 * samples and B leaves are dropped, and a restart still has the spend spent.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bLeafId, bProof } from '../../crypto/clearing.js';
import { decodeHeader } from '../../crypto/header.js';
import { SAMPLE_PRUNE_CONFIRMATIONS, SPENDABLE_CONFIRMATIONS } from '../../crypto/asert.js';
import { excessOf } from '../../crypto/note.js';
import { signSpendTx } from '../../crypto/spend.js';
import { setHashBackend } from '../../crypto/shear_hash.js';
import { createStore } from '../src/store.js';
import { buildTemplate, retarget } from '../src/chain.js';
import { payerIdentity, sealMintOut } from './b_leaf_fund.js';
import { publishBLeaves } from './b_leaf_fs1.js';

try { setHashBackend('jit'); } catch { /* interpreter */ }

let tag = 80_000;
function easyPow() {
  tag += 1;
  const h = Buffer.alloc(32);
  h.writeUInt32LE(tag >>> 0, 4);
  return h;
}

function padTo(store, dest, target) {
  while ((store.tip()?.height || 0) < target) {
    const tip = store.tip();
    const now = Number(decodeHeader(Buffer.from(tip.header)).timestamp) + 90_000;
    const flux = store.fluxThrough(store.blocks.length - 1);
    const tpl = buildTemplate({
      prev: tip.hash,
      prevHeader: tip.header,
      prevBlock: tip,
      parentWeight: tip.weight,
      height: tip.height + 1,
      miner: dest,
      now,
      bits: retarget(store.blocks, now),
      parentBlocks: store.blocks,
      parentFluxset: flux,
    });
    const pow = easyPow();
    const got = store.append({
      header: tpl.header,
      txs: tpl.txs,
      samples: tpl.samples,
      shareBatch: tpl.shareBatch || [],
      miner: dest,
      aLeaves: tpl.aLeaves,
      bLeaves: tpl.bLeaves,
      rootA: tpl.rootA,
      rootB: tpl.rootB,
      weight: tpl.weight,
    }, { trustedPowHash: pow, skipSharePow: true });
    assert.equal(got.ok, true, got.reason || 'pad');
  }
}

describe('a pruned b-spend restarts spent', () => {
  it('keeps the spent id after the spend block is pruned', { timeout: 600_000 }, async () => {
    assert.equal(SAMPLE_PRUNE_CONFIRMATIONS, 1000);
    const who = payerIdentity();
    const dest = who.dest;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-bspend-prune-'));
    const live = createStore(dir, { pruneAfter: SAMPLE_PRUNE_CONFIRMATIONS });
    const funded = await publishBLeaves(live, who, [{
      unit: 9,
      nonce: 1,
      memoH: Buffer.alloc(32),
      tag: 'b-extra',
      id: 'fund-bspend-prune',
    }]);
    const leaf = funded.leaves[0];
    const commitH = funded.height;
    const id = bLeafId(leaf, commitH, 0);
    padTo(live, dest, commitH + SPENDABLE_CONFIRMATIONS - 2);
    const commit = live.blocks[commitH - 1];
    const spendTx = {
      id: 'bspend-prune',
      kind: 'b-spend',
      from: dest,
      fee: 0,
      commitHeight: commitH,
      leaf,
      proof: bProof(commit.bLeaves, 0),
      index: 0,
      vin: [{ address: dest }],
      vout: [sealMintOut(leaf.unit, dest, 'b-spend')],
    };
    spendTx.excess = excessOf(spendTx.vout);
    signSpendTx(spendTx, who.key, { magic: 'shear-testnet-v12' });
    const flux = live.fluxThrough(live.blocks.length - 1);
    const now = Number(decodeHeader(Buffer.from(live.tip().header)).timestamp) + 90_000;
    const tpl = buildTemplate({
      prev: live.tip().hash,
      prevHeader: live.tip().header,
      prevBlock: live.tip(),
      parentWeight: live.tip().weight,
      height: live.tip().height + 1,
      miner: dest,
      now,
      bits: retarget(live.blocks, now),
      parentBlocks: live.blocks,
      parentFluxset: flux,
      txs: [spendTx],
    });
    const spent = live.append({
      header: tpl.header,
      txs: tpl.txs,
      samples: tpl.samples,
      shareBatch: tpl.shareBatch || [],
      miner: dest,
      aLeaves: tpl.aLeaves,
      bLeaves: tpl.bLeaves,
      rootA: tpl.rootA,
      rootB: tpl.rootB,
      weight: tpl.weight,
    }, { trustedPowHash: easyPow(), skipSharePow: true });
    assert.equal(spent.ok, true, spent.reason);
    const spendHeight = live.tip().height;
    assert.equal(live.spentB.has(id), true);
    padTo(live, dest, spendHeight + SAMPLE_PRUNE_CONFIRMATIONS);
    const buried = live.blocks[spendHeight - 1];
    assert.equal(buried.samplesPruned, true);
    assert.equal(buried.bLeavesPruned, true);
    assert.equal((buried.txs || []).some((tx) => tx && tx.kind === 'b-spend'), true);
    const liveTip = Buffer.from(live.tip().hash).toString('hex');
    const bounced = createStore(dir, { pruneAfter: SAMPLE_PRUNE_CONFIRMATIONS });
    assert.equal(Buffer.from(bounced.tip().hash).toString('hex'), liveTip);
    assert.equal(bounced.blocks[spendHeight - 1].samplesPruned, true);
    assert.equal(bounced.spentB.has(id), true);
    const againFlux = bounced.fluxThrough(bounced.blocks.length - 1);
    const againNow = Number(decodeHeader(Buffer.from(bounced.tip().header)).timestamp) + 90_000;
    const againTpl = buildTemplate({
      prev: bounced.tip().hash,
      prevHeader: bounced.tip().header,
      prevBlock: bounced.tip(),
      parentWeight: bounced.tip().weight,
      height: bounced.tip().height + 1,
      miner: dest,
      now: againNow,
      bits: retarget(bounced.blocks, againNow),
      parentBlocks: bounced.blocks,
      parentFluxset: againFlux,
      txs: [{ ...spendTx, id: 'bspend-prune-again' }],
    });
    const again = bounced.append({
      header: againTpl.header,
      txs: againTpl.txs,
      samples: againTpl.samples,
      shareBatch: againTpl.shareBatch || [],
      miner: dest,
      aLeaves: againTpl.aLeaves,
      bLeaves: againTpl.bLeaves,
      rootA: againTpl.rootA,
      rootB: againTpl.rootB,
      weight: againTpl.weight,
    }, { trustedPowHash: easyPow(), skipSharePow: true });
    assert.equal(again.ok, false);
    assert.equal(again.reason, 'double_open');
    assert.equal(bounced.spentB.has(id), true);
  });
});
