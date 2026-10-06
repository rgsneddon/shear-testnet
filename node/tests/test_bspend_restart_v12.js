import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newIdentity, hash20FromAddress } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { bLeafId, bProof } from '../../crypto/clearing.js';
import { decodeHeader } from '../../crypto/header.js';
import { SPENDABLE_CONFIRMATIONS } from '../../crypto/asert.js';
import { packEpochBlock, unpackEpochBlock, writeChainBin } from '../../crypto/chainbin.js';
import { setHashBackend } from '../../crypto/shear_hash.js';
import { createStore } from '../src/store.js';
import { buildTemplate, retarget, GENESIS_PREV, shouldAdopt } from '../src/chain.js';

try { setHashBackend('jit'); } catch { /* interpreter */ }

function minerDest() {
  const id = newIdentity();
  return destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
}

function easyPow(tag) {
  const h = Buffer.alloc(32);
  h.writeUInt32LE((tag >>> 0) || 1, 4);
  return h;
}

function idsOf(store) {
  return [...store.spentB].sort();
}

function tipHex(store) {
  return Buffer.from(store.tip().hash).toString('hex');
}

let tag = 50_000;
function sealBuilt(store, dest, extra = {}) {
  const tip = store.tip();
  const now = tip
    ? Number(decodeHeader(Buffer.from(tip.header)).timestamp) + 90_000
    : 1_700_000_000_000;
  const bits = retarget(store.blocks, now);
  tag += 1;
  const tpl = buildTemplate({
    prev: tip ? tip.hash : GENESIS_PREV,
    prevHeader: tip ? tip.header : null,
    prevBlock: tip,
    parentWeight: tip ? tip.weight : 1,
    height: tip ? tip.height + 1 : 1,
    miner: dest,
    now,
    bits,
    parentBlocks: store.blocks,
    ...extra,
  });
  const pow = easyPow(tag);
  return store.append({
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
}

function heavierFork(store, dest, parentIndex, count, tagBase) {
  const prefix = store.blocks.slice(0, parentIndex + 1);
  const out = [];
  let prev = prefix[prefix.length - 1];
  let now = Number(decodeHeader(Buffer.from(prev.header)).timestamp) + 90_000;
  for (let i = 0; i < count; i += 1) {
    const bits = retarget(prefix.concat(out), now);
    const tpl = buildTemplate({
      prev: prev.hash,
      prevHeader: prev.header,
      prevBlock: prev,
      height: Number(prev.height) + 1,
      miner: dest,
      now,
      bits,
      parentBlocks: prefix.concat(out),
    });
    const pow = easyPow(tagBase + i);
    out.push({
      header: tpl.header,
      txs: tpl.txs,
      samples: tpl.samples,
      shareBatch: tpl.shareBatch || [],
      miner: dest,
      aLeaves: tpl.aLeaves,
      bLeaves: tpl.bLeaves,
      rootA: tpl.rootA,
      rootB: tpl.rootB,
      hash: pow,
      height: Number(prev.height) + 1,
      weight: tpl.weight,
      bSpendIds: [],
    });
    prev = out[out.length - 1];
    now += 90_000;
  }
  return out;
}

function adopt(store, dest, parentIndex, count, tagBase) {
  const fork = heavierFork(store, dest, parentIndex, count, tagBase);
  const candidate = store.blocks.slice(0, parentIndex + 1).concat(fork);
  assert.equal(shouldAdopt(store.blocks, candidate), true);
  return store.ingest(fork, { trustBlockHash: true });
}

describe('v12 b-spend stamps survive a restart', () => {
  it('rebuilds spentB from the chain trailer and still rejects a re-spend', { timeout: 180_000 }, () => {
    assert.equal(SPENDABLE_CONFIRMATIONS, 9);
    const src = fs.readFileSync(new URL('../src/store.js', import.meta.url), 'utf8');
    const rebuild = src.split('function rebuildSpentB()')[1].split('function bounceMempool')[0];
    assert.match(rebuild, /skipSharePow:\s*false/);
    assert.doesNotMatch(rebuild, /skipSharePow:\s*true/);
    assert.match(src, /function restoreSpentB\(\)/);
    const bin = fs.readFileSync(new URL('../../crypto/chainbin.js', import.meta.url), 'utf8');
    assert.match(bin, /bSpendIds/);

    const dest = minerDest();
    const dest20 = hash20FromAddress(dest);
    const leaf = {
      dest20,
      unit: 9,
      nonce: 1,
      memoH: Buffer.alloc(32),
      tag: 'b-extra',
    };
    const id = bLeafId(leaf, 1, 0);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-bspend-'));
    const live = createStore(dir, { pruneAfter: 1_000_000 });
    const committed = sealBuilt(live, dest, { bLeaves: [leaf] });
    assert.equal(committed.ok, true, committed.reason);
    assert.equal(live.tip().height, 1);
    while ((live.tip()?.height || 0) < SPENDABLE_CONFIRMATIONS - 1) {
      const pad = sealBuilt(live, dest);
      assert.equal(pad.ok, true, pad.reason);
    }
    assert.equal(live.tip().height, 8);
    const commit = live.blocks[0];
    const spendTx = {
      id: 'bspend-restart',
      kind: 'b-spend',
      from: dest,
      to: dest,
      nanos: 0,
      fee: 0,
      commitHeight: 1,
      commitHeader: commit.header,
      commitRootA: commit.rootA,
      commitRootB: commit.rootB,
      leaf,
      proof: bProof([leaf], 0),
      index: 0,
      vin: [{ address: dest }],
      vout: [],
    };
    const spent = sealBuilt(live, dest, { txs: [spendTx] });
    assert.equal(spent.ok, true, spent.reason);
    assert.equal(live.tip().height, 9);
    assert.equal(live.spentB.has(id), true);
    const stamped = live.blocks[8];
    assert.ok(Array.isArray(stamped.bSpendIds));
    assert.equal(stamped.bSpendIds.includes(id), true);
    const round = unpackEpochBlock(packEpochBlock(stamped));
    assert.deepEqual(round.bSpendIds, stamped.bSpendIds.map(String));
    const unstamped = { ...live.blocks[0] };
    delete unstamped.bSpendIds;
    const old = unpackEpochBlock(packEpochBlock(unstamped));
    assert.equal(Object.prototype.hasOwnProperty.call(old, 'bSpendIds'), false);

    while ((live.tip()?.height || 0) < 24) {
      const pad = sealBuilt(live, dest);
      assert.equal(pad.ok, true, pad.reason);
    }
    const liveIds = idsOf(live);
    const liveTip = tipHex(live);
    const bounced = createStore(dir, { pruneAfter: 1_000_000 });
    assert.equal(tipHex(bounced), liveTip);
    assert.deepEqual(idsOf(bounced), liveIds);
    assert.equal(bounced.spentB.has(id), true);

    const again = sealBuilt(bounced, dest, { txs: [{ ...spendTx, id: 'bspend-again' }] });
    assert.equal(again.ok, false);
    assert.equal(again.reason, 'double_open');
    assert.equal(tipHex(bounced), liveTip);
    assert.equal(bounced.spentB.has(id), true);

    const depths = [1, 3, 8];
    for (const depth of depths) {
      const parentIndex = bounced.blocks.length - 1 - depth;
      assert.ok(parentIndex >= 8, 'prefix still holds the spend');
      const got = adopt(bounced, dest, parentIndex, depth + 1, 80_000 + depth * 1000);
      assert.equal(got.ok, true, got.reason);
      assert.equal(bounced.spentB.has(id), true);
      assert.notEqual(tipHex(bounced), liveTip);
    }

    const cut = 7;
    const dropped = adopt(bounced, dest, cut, bounced.blocks.length - cut, 120_000);
    assert.equal(dropped.ok, true, dropped.reason);
    assert.equal(bounced.spentB.has(id), false);
    const reopened = sealBuilt(bounced, dest, { txs: [{ ...spendTx, id: 'bspend-reopen' }] });
    assert.equal(reopened.ok, true, reopened.reason);
    assert.equal(bounced.spentB.has(id), true);

    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-bspend-bare-'));
    const stripped = bounced.blocks.map((b) => {
      const copy = { ...b };
      delete copy.bSpendIds;
      return copy;
    });
    writeChainBin(path.join(bare, 'chain.bin'), stripped);
    assert.throws(() => createStore(bare, { pruneAfter: 1_000_000 }), /spent_checkpoint_missing/);

    const dupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-bspend-dup-'));
    const duplicated = bounced.blocks.map((b) => ({ ...b, bSpendIds: Array.isArray(b.bSpendIds) ? b.bSpendIds.slice() : [] }));
    const host = duplicated.find((b) => !(b.bSpendIds || []).includes(id));
    host.bSpendIds = host.bSpendIds.concat([id]);
    writeChainBin(path.join(dupDir, 'chain.bin'), duplicated);
    assert.throws(() => createStore(dupDir, { pruneAfter: 1_000_000 }), /double_open/);

    const oldDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-bspend-old-'));
    const mixed = bounced.blocks.map((b) => {
      const copy = { ...b, bSpendIds: Array.isArray(b.bSpendIds) ? b.bSpendIds.slice() : [] };
      const hasSpend = (copy.txs || []).some((tx) => tx && tx.kind === 'b-spend');
      if (!hasSpend) delete copy.bSpendIds;
      return copy;
    });
    writeChainBin(path.join(oldDir, 'chain.bin'), mixed);
    const oldStore = createStore(oldDir, { pruneAfter: 1_000_000 });
    assert.equal(oldStore.spentB.has(id), true);
    assert.equal(tipHex(oldStore), tipHex(bounced));
  });
});
