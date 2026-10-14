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
import { sealNote, verifyRange } from '../../crypto/note.js';
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

function cloneChain(blocks) {
  return blocks.map((b) => {
    const copy = { ...b, txs: (b.txs || []).slice() };
    if (Array.isArray(b.bSpendIds)) copy.bSpendIds = b.bSpendIds.slice();
    else delete copy.bSpendIds;
    return copy;
  });
}

function spendTxsOf(block) {
  return (block?.txs || []).filter((tx) => tx && tx.kind === 'b-spend');
}

function openChain(blocks, mutate) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-bspend-match-'));
  const copy = cloneChain(blocks);
  if (mutate) mutate(copy);
  writeChainBin(path.join(dir, 'chain.bin'), copy);
  return createStore(dir, { pruneAfter: 1_000_000 });
}

function expectTrailer(blocks, mutate, re, label) {
  let opened = null;
  try {
    opened = openChain(blocks, mutate);
  } catch (err) {
    assert.match(String(err && err.message), re, label);
    return;
  }
  throw new Error(`${label}: loaded spent=${idsOf(opened).join('|')}`);
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

    // Trusted-pow headers in a new dir have no book.seal. Load hashes them and
    // fails pow before restoreSpentB. A real ShearHash trailer mismatch is
    // test_load_verify_v12.js. The same-dir restart above still has the seal.
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-bspend-bare-'));
    const stripped = bounced.blocks.map((b) => {
      const copy = { ...b };
      delete copy.bSpendIds;
      return copy;
    });
    writeChainBin(path.join(bare, 'chain.bin'), stripped);
    assert.throws(() => createStore(bare, { pruneAfter: 1_000_000 }), /pow/);

    const dupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-bspend-dup-'));
    const duplicated = bounced.blocks.map((b) => ({ ...b, bSpendIds: Array.isArray(b.bSpendIds) ? b.bSpendIds.slice() : [] }));
    const host = duplicated.find((b) => !(b.bSpendIds || []).includes(id));
    host.bSpendIds = host.bSpendIds.concat([id]);
    writeChainBin(path.join(dupDir, 'chain.bin'), duplicated);
    assert.throws(() => createStore(dupDir, { pruneAfter: 1_000_000 }), /pow/);

    const twinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-bspend-twin-'));
    const twinned = bounced.blocks.map((b) => ({
      ...b,
      txs: (b.txs || []).slice(),
      bSpendIds: Array.isArray(b.bSpendIds) ? b.bSpendIds.slice() : [],
    }));
    const origin = twinned.find((b) => spendTxsOf(b).length > 0);
    const carrier = twinned.find((b) => b !== origin && spendTxsOf(b).length === 0);
    const copiedSpend = spendTxsOf(origin)[0];
    carrier.txs = carrier.txs.concat([{ ...copiedSpend, id: 'bspend-copied' }]);
    carrier.bSpendIds = [id];
    writeChainBin(path.join(twinDir, 'chain.bin'), twinned);
    assert.throws(() => createStore(twinDir, { pruneAfter: 1_000_000 }), /pow/);

    const oldDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-bspend-old-'));
    const mixed = bounced.blocks.map((b) => {
      const copy = { ...b, bSpendIds: Array.isArray(b.bSpendIds) ? b.bSpendIds.slice() : [] };
      const hasSpend = (copy.txs || []).some((tx) => tx && tx.kind === 'b-spend');
      if (!hasSpend) delete copy.bSpendIds;
      return copy;
    });
    writeChainBin(path.join(oldDir, 'chain.bin'), mixed);
    assert.throws(() => createStore(oldDir, { pruneAfter: 1_000_000 }), /pow/);
  });

  it('rejects a trailer that is not the set of ids derived from that block', { timeout: 180_000 }, () => {
    const amounts = [1, 1_000_000_000, 2 ** 32, 2 ** 40, Number.MAX_SAFE_INTEGER];
    assert.ok(amounts.every((n) => Number.isSafeInteger(n) && n >= 1));
    const dest = minerDest();
    const dest20 = hash20FromAddress(dest);
    const leaves = [1, 2, 3].map((n) => ({
      dest20,
      unit: n,
      nonce: n,
      memoH: Buffer.alloc(32),
      tag: `b-leaf-${n}`,
    }));
    const ids = leaves.map((leaf, index) => bLeafId(leaf, 1, index));
    assert.equal(new Set(ids).size, ids.length);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-bspend-match-'));
    const live = createStore(dir, { pruneAfter: 1_000_000 });
    const committed = sealBuilt(live, dest, { bLeaves: leaves });
    assert.equal(committed.ok, true, committed.reason);
    while ((live.tip()?.height || 0) < SPENDABLE_CONFIRMATIONS - 1) {
      const pad = sealBuilt(live, dest);
      assert.equal(pad.ok, true, pad.reason);
    }
    const commit = live.blocks[0];
    const spendTx = (leaf, index, vout, id) => ({
      id,
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
      proof: bProof(leaves, index),
      index,
      vin: [{ address: dest }],
      vout,
    });
    const note = (nanos) => sealNote(nanos, { dest20, kind: 'send' });
    for (const nanos of amounts) {
      const plain = sealBuilt(live, dest, {
        txs: [spendTx(leaves[0], 0, [{ kind: 'send', address: dest, nanos }], 'bspend-plain')],
      });
      assert.equal(plain.ok, false, `plaintext ${nanos}`);
      assert.equal(plain.reason, 'range_proof');
      assert.equal(live.tip().height, SPENDABLE_CONFIRMATIONS - 1);
      assert.equal(live.spentB.has(ids[0]), false);
    }
    const vouts = [
      [note(amounts[0])],
      [note(amounts[1]), note(amounts[2])],
      [note(amounts[3]), note(amounts[4]), note(amounts[0])],
    ];
    assert.deepEqual(vouts.map((v) => v.length), [1, 2, 3]);
    const pair = sealBuilt(live, dest, {
      txs: [
        spendTx(leaves[0], 0, vouts[0], 'bspend-a'),
        spendTx(leaves[1], 1, vouts[1], 'bspend-b'),
      ],
    });
    assert.equal(pair.ok, true, pair.reason);
    assert.equal(live.spentB.has(ids[0]), true);
    assert.equal(live.spentB.has(ids[1]), true);
    while ((live.tip()?.height || 0) < 11) {
      const pad = sealBuilt(live, dest);
      assert.equal(pad.ok, true, pad.reason);
    }
    const third = sealBuilt(live, dest, {
      txs: [spendTx(leaves[2], 2, vouts[2], 'bspend-c')],
    });
    assert.equal(third.ok, true, third.reason);
    assert.equal(live.spentB.has(ids[2]), true);
    while ((live.tip()?.height || 0) < 14) {
      const pad = sealBuilt(live, dest);
      assert.equal(pad.ok, true, pad.reason);
    }
    const multi = live.blocks.find((b) => spendTxsOf(b).length > 1);
    const single = live.blocks.find((b) => spendTxsOf(b).length === 1);
    assert.ok(multi && single);
    assert.ok(Number(single.height) > Number(multi.height));
    assert.deepEqual([...multi.bSpendIds].sort(), [ids[0], ids[1]].sort());
    assert.deepEqual(single.bSpendIds, [ids[2]]);
    for (const block of [multi, single]) {
      for (const tx of spendTxsOf(block)) {
        assert.ok((tx.vout || []).length >= 1);
        for (const o of tx.vout) {
          assert.notEqual(o.rangeProof, true);
          assert.equal(verifyRange(o.commit, o.rangeProof), true);
        }
      }
    }
    const snapshot = cloneChain(live.blocks);
    const liveIds = idsOf(live);
    const bounced = createStore(dir, { pruneAfter: 1_000_000 });
    assert.deepEqual(idsOf(bounced), liveIds);
    for (const block of bounced.blocks) {
      for (const tx of spendTxsOf(block)) {
        for (const o of tx.vout || []) {
          assert.equal(verifyRange(o.commit, o.rangeProof), true);
        }
      }
    }

    const multiH = Number(multi.height);
    const singleH = Number(single.height);
    const at = (chain, height) => chain.find((b) => Number(b.height) === height);
    {
      let opened = null;
      let err = null;
      try {
        opened = openChain(snapshot, (chain) => {
          at(chain, multiH).bSpendIds = [ids[0]];
        });
      } catch (e) {
        err = e;
      }
      if (!err) {
        const has0 = opened.spentB.has(ids[0]);
        const has1 = opened.spentB.has(ids[1]);
        const again = sealBuilt(opened, dest, {
          txs: [spendTx(leaves[1], 1, vouts[1], 'bspend-hole')],
        });
        throw new Error(`partial loaded has0=${has0} has1=${has1} respend=${again.ok}:${again.reason}`);
      }
      assert.match(String(err.message), /pow/, 'partial');
    }
    // Same trusted-pow foreign files as the restart case: pow, not the trailer.
    expectTrailer(snapshot, (chain) => {
      at(chain, multiH).bSpendIds = [ids[0], ids[1], 'extra-not-a-leaf'];
    }, /pow/, 'extra');
    expectTrailer(snapshot, (chain) => {
      at(chain, singleH).bSpendIds = ['wrong-not-a-leaf'];
    }, /pow/, 'wrong');
    expectTrailer(snapshot, (chain) => {
      const a = at(chain, multiH);
      const b = at(chain, singleH);
      const swap = a.bSpendIds;
      a.bSpendIds = b.bSpendIds;
      b.bSpendIds = swap;
    }, /pow/, 'swapped');
    expectTrailer(snapshot, (chain) => {
      delete at(chain, multiH).bSpendIds;
    }, /pow/, 'stripped');

    const keepParent = bounced.blocks.length - 2;
    assert.ok(keepParent > bounced.blocks.findIndex((b) => Number(b.height) === singleH));
    const kept = adopt(bounced, dest, keepParent, 2, 200_000);
    assert.equal(kept.ok, true, kept.reason);
    for (const id of ids) assert.equal(bounced.spentB.has(id), true);

    const singleIdx = bounced.blocks.findIndex((b) => Number(b.height) === singleH);
    const dropped = adopt(bounced, dest, singleIdx - 1, bounced.blocks.length - (singleIdx - 1), 210_000);
    assert.equal(dropped.ok, true, dropped.reason);
    assert.equal(bounced.spentB.has(ids[0]), true);
    assert.equal(bounced.spentB.has(ids[1]), true);
    assert.equal(bounced.spentB.has(ids[2]), false);

    const multiIdx = bounced.blocks.findIndex((b) => Number(b.height) === multiH);
    const tipBefore = tipHex(bounced);
    bounced.blocks[multiIdx].bSpendIds = [ids[0]];
    const refused = adopt(bounced, dest, multiIdx - 1, bounced.blocks.length - (multiIdx - 1), 220_000);
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, 'spent_checkpoint_mismatch');
    assert.equal(tipHex(bounced), tipBefore);
    assert.equal(bounced.spentB.has(ids[0]), true);
    assert.equal(bounced.spentB.has(ids[1]), true);
  });
});
