/**
 * P0-093b / N-16. Spend tags come from the proof bytes on every path.
 * A JSON field that disagrees is rejected. A missing field does not hide the tag.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newIdentity, freshStealthDest, ed25519SeedOf, stealthKey } from '../../crypto/address.js';
import { attachDummyOuts } from '../../crypto/dummy.js';
import {
  openedCoinbaseNanos,
  flowInputsBound,
  txSpendTags,
  kernelExcess,
  scalarFrom,
} from '../../crypto/note.js';
import { compactTx } from '../../crypto/chronoflux.js';
import { levyNanos } from '../../crypto/levy.js';
import { MAGIC_TESTNET } from '../../crypto/asert.js';
import { decodeHeader } from '../../crypto/header.js';
import {
  admitProve,
  admitScalarFromSeed,
  applyBlockToFluxset,
  emptyFluxset,
  fluxsetFromBlocks,
  fluxsetIndexOf,
  proveFlowSpend,
} from '../../crypto/admit.js';
import { anchorRootHash, verifyTypedAdmitFunding } from '../../crypto/admit_v3.js';
import { signSpendTx } from '../../crypto/spend.js';
import { createStore } from '../src/store.js';
import { bookSealKeyPath } from '../src/book_seal_key.js';
import { buildTemplate, retarget, shouldAdopt, GENESIS_PREV } from '../src/chain.js';

function identityDest() {
  const id = newIdentity();
  const pay = freshStealthDest(id);
  const spendSeed = id.spendSeed || ed25519SeedOf(id.privateKey);
  return { dest: pay.dest, spendSeed, key: stealthKey(pay.shared, spendSeed) };
}

let powTag = 1;
function easyPow() {
  const h = Buffer.alloc(32);
  h.writeUInt32LE(powTag >>> 0, 4);
  powTag += 1;
  return h;
}

function blobTag(proof) {
  const blob = Buffer.from(proof.blob);
  assert.ok(blob.length >= 33);
  return Buffer.from(blob.subarray(1, 33));
}

function versionedBlob(ver, tag) {
  const blob = Buffer.alloc(40, 0);
  blob[0] = ver;
  Buffer.from(tag).copy(blob, 1);
  return blob;
}

function omitTags(tx) {
  delete tx.spendTag;
  if (tx.admit_proof) delete tx.admit_proof.spendTag;
  if (Array.isArray(tx.admit_proofs)) {
    for (const proof of tx.admit_proofs) delete proof.spendTag;
  }
  return tx;
}

function cloneSpend(tx, id) {
  return {
    ...tx,
    id,
    vin: (tx.vin || []).map((v) => ({ ...v })),
    vout: (tx.vout || []).map((o) => ({ ...o })),
    admit_proof: tx.admit_proof ? { ...tx.admit_proof } : undefined,
    admit_proofs: Array.isArray(tx.admit_proofs) ? tx.admit_proofs.map((p) => ({ ...p })) : undefined,
  };
}

function blockFrom(tpl, pow) {
  return {
    header: tpl.header,
    txs: tpl.txs,
    samples: tpl.samples,
    miner: tpl.miner,
    aLeaves: tpl.aLeaves,
    bLeaves: tpl.bLeaves,
    rootA: tpl.rootA,
    rootB: tpl.rootB,
    weight: tpl.weight,
    shareBatch: tpl.shareBatch || [],
    hash: pow,
  };
}

async function appendBuilt(store, dest, txs = []) {
  const tipb = store.tip();
  const now = tipb
    ? Number(decodeHeader(Buffer.from(tipb.header)).timestamp) + 90_000
    : 1_700_000_000_000;
  const bits = retarget(store.blocks, now);
  const tpl = buildTemplate({
    prev: tipb ? tipb.hash : GENESIS_PREV,
    prevHeader: tipb ? tipb.header : null,
    prevBlock: tipb,
    parentWeight: tipb ? tipb.weight : 1,
    height: tipb ? tipb.height + 1 : 1,
    miner: dest,
    now,
    bits,
    parentBlocks: store.blocks,
    txs,
  });
  const pow = easyPow();
  const got = await store.append(blockFrom(tpl, pow), { trustedPowHash: pow, skipSharePow: true });
  return { got, tpl, now };
}

function potOf(tpl) {
  return tpl.txs[0].vout.find((o) => o.kind === 'pot');
}

function payOf(note) {
  const opened = openedCoinbaseNanos(note);
  assert.ok(opened > 1);
  const pay = Math.max(1, Math.floor(opened / 5));
  const fee = levyNanos(pay);
  const change = opened - pay - fee;
  assert.ok(change > 0, `change ${change} opened ${opened} fee ${fee}`);
  return { pay, fee, change, opened };
}

function sendBody({ id, dest, notes, pay, fee, change }) {
  return attachDummyOuts({
    id,
    kind: 'send',
    from: dest,
    to: dest,
    nanos: pay,
    fee,
    changeNanos: change,
    vin: notes.map(() => ({ address: dest })),
    vout: [
      { address: dest, nanos: pay, kind: 'send' },
      { address: dest, nanos: change, kind: 'send' },
    ],
  }, { spent: notes.length === 1 ? notes[0] : notes });
}

function tagHex(tx) {
  return txSpendTags(tx).tags.map((tag) => tag.toString('hex'));
}

function userTxs(tpl) {
  return (tpl.txs || []).filter((tx) => tx && !tx.coinbase);
}

describe('v12 spend tags come from the proof bytes', () => {
  it('reads every proof, rejects a lying field, and keeps a shape proof', () => {
    for (const ver of [2, 3]) {
      for (const count of [1, 3]) {
        const proofs = [];
        for (let i = 0; i < count; i += 1) {
          const tag = Buffer.alloc(32, i + 1);
          proofs.push({ blob: versionedBlob(ver, tag), cTilde: Buffer.alloc(32, i + 9) });
        }
        const tx = count === 1 ? { admit_proof: proofs[0] } : { admit_proofs: proofs };
        const parsed = txSpendTags(tx);
        assert.equal(parsed.ok, true, `v${ver} n=${count} ${parsed.reason}`);
        assert.equal(parsed.tags.length, count);
        for (let i = 0; i < count; i += 1) {
          assert.ok(parsed.tags[i].equals(Buffer.alloc(32, i + 1)));
        }
      }
    }
    const tag = Buffer.alloc(32, 4);
    const blob = versionedBlob(2, tag);
    const lie = Buffer.alloc(32, 9);
    const mismatch = txSpendTags({
      spendTag: lie,
      admit_proof: { blob, spendTag: lie, cTilde: Buffer.alloc(32, 1) },
    });
    assert.equal(mismatch.ok, false);
    assert.equal(mismatch.reason, 'admit_tag');
    assert.ok(mismatch.tags[0].equals(tag));
    const absorbed = applyBlockToFluxset(emptyFluxset(), {
      txs: [{ admit_proof: { blob, spendTag: lie } }],
    });
    assert.equal(absorbed.spendTags.has(tag.toString('hex')), true);
    const again = fluxsetFromBlocks([{ txs: [{ admit_proof: { blob } }] }]);
    assert.equal(again.spendTags.has(tag.toString('hex')), true);
    const dup = txSpendTags({
      admit_proofs: [
        { blob: versionedBlob(3, tag) },
        { blob: versionedBlob(3, tag) },
      ],
    });
    assert.equal(dup.reason, 'admit_link_tag');
    const commit = Buffer.alloc(32, 8);
    const other = versionedBlob(2, Buffer.alloc(32, 5));
    const alias = txSpendTags({
      admit_proof: { blob, cTilde: commit },
      admit_proofs: [
        { blob, cTilde: commit },
        { blob: other, cTilde: Buffer.alloc(32, 2) },
      ],
    });
    assert.equal(alias.ok, true, alias.reason);
    assert.equal(alias.tags.length, 2);
    const extraProof = txSpendTags({
      admit_proof: { blob: versionedBlob(2, Buffer.alloc(32, 6)) },
      admit_proofs: [{ blob, cTilde: commit }],
    });
    assert.equal(extraProof.ok, true, extraProof.reason);
    assert.equal(extraProof.tags.length, 2);
    assert.equal(txSpendTags({ coinbase: true }).ok, true);
    assert.equal(txSpendTags({ coinbase: true }).tags.length, 0);
    assert.equal(txSpendTags({ spendTag: tag }).tags.length, 0);
    const shaped = { cTilde: commit, spendTag: tag };
    assert.equal(flowInputsBound({
      vin: [{ commit }],
      admit_proof: shaped,
    }).ok, true);
    const boundBlob = flowInputsBound({
      vin: [{ commit }],
      admit_proof: { blob, cTilde: commit },
    });
    assert.equal(boundBlob.ok, true, boundBlob.reason);
    assert.equal(flowInputsBound({
      vin: [{ commit }],
      spendTag: lie,
      admit_proof: { blob, cTilde: commit },
    }).reason, 'admit_tag');
    const sealed = compactTx({
      kind: 'send',
      spendTag: lie,
      admit_proof: { blob, spendTag: lie, cTilde: commit },
      admit_proofs: [{ blob, spendTag: lie, cTilde: commit }],
    });
    assert.ok(Buffer.from(sealed.admit_proof.spendTag).equals(tag));
    assert.ok(Buffer.from(sealed.spendTag).equals(tag));
    assert.ok(Buffer.from(sealed.admit_proofs[0].spendTag).equals(tag));
    assert.ok(Buffer.from(sealed.admit_proof.blob).equals(blob));
  });

  it('rejects a v3 field that disagrees and a blob tag that is already spent', () => {
    const tag = Buffer.alloc(32, 0xab);
    const blob = Buffer.alloc(129, 0);
    blob[0] = 3;
    tag.copy(blob, 1);
    const root = Buffer.from(anchorRootHash(blob.subarray(65, 97), blob.subarray(97, 129)));
    const commit = Buffer.alloc(32, 4);
    const base = {
      kind: 'lock',
      anchor: 8,
      vin: [{ commit, anchor: 8 }],
    };
    const opts = {
      height: 24,
      magic: MAGIC_TESTNET,
      noteAtAnchor: () => ({ jroot: root, n: 1 }),
    };
    const omitted = verifyTypedAdmitFunding({
      ...base,
      admit_proofs: [{ blob, cTilde: commit }],
    }, { ...opts, spentTags: new Set([tag.toString('hex')]) });
    assert.equal(omitted.ok, false);
    assert.equal(omitted.reason, 'admit_link_tag');
    assert.equal(omitted.proofChecked, true);
    const lying = verifyTypedAdmitFunding({
      ...base,
      spendTag: Buffer.alloc(32, 1),
      admit_proofs: [{ blob, cTilde: commit, spendTag: Buffer.alloc(32, 1) }],
    }, { ...opts, spentTags: new Set() });
    assert.equal(lying.ok, false);
    assert.equal(lying.reason, 'admit_tag');
    assert.equal(lying.proofChecked, true);
  });

  it('a field-less spend cannot be queued twice, reorged back in, or reloaded as unspent', async () => {
    const { dest, spendSeed, key } = identityDest();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-tags-'));
    const store = createStore(dir);
    const genesis = await appendBuilt(store, dest);
    assert.equal(genesis.got.ok, true, genesis.got.reason);
    const pot = potOf(genesis.tpl);
    const { pay, fee, change } = payOf(pot);
    const live = store.fluxset();
    const spend = sendBody({ id: 'omit', dest, notes: [pot], pay, fee, change });
    proveFlowSpend(spend, { spendSeed, spentNote: pot, pubs: live.pubs, commits: live.commits });
    assert.ok(spend.admit_proof?.blob, 'prove');
    signSpendTx(spend, key);
    const real = blobTag(spend.admit_proof);
    omitTags(spend);
    const queued = store.queueTx(spend);
    assert.equal(queued.ok, true, queued.reason);
    const parked = store.mempool.find((m) => m.id === 'omit');
    assert.ok(parked);
    assert.equal(parked.spendTag, undefined);
    assert.equal(parked.admit_proof.spendTag, undefined);
    assert.deepEqual(tagHex(parked), [real.toString('hex')]);

    for (const [id, field] of [
      ['omit-again', null],
      ['with-field', real],
    ]) {
      const again = cloneSpend(spend, id);
      if (field) {
        again.admit_proof.spendTag = Buffer.from(field);
        again.spendTag = Buffer.from(field);
      }
      const rejected = store.queueTx(again);
      assert.equal(rejected.ok, false, id);
      assert.equal(rejected.reason, 'admit_link_tag', `${id} ${rejected.reason}`);
      assert.equal(store.mempool.some((m) => m.id === id), false);
    }
    const lie = cloneSpend(spend, 'lie');
    lie.admit_proof.spendTag = Buffer.alloc(32, 9);
    lie.spendTag = Buffer.alloc(32, 9);
    const lied = store.queueTx(lie);
    assert.equal(lied.reason, 'admit_tag', lied.reason);
    assert.equal(store.mempool.some((m) => m.id === 'lie'), false);

    const tip = store.tip();
    const now = Number(decodeHeader(Buffer.from(tip.header)).timestamp) + 90_000;
    const open = store.template({ miner: dest, now });
    assert.equal(userTxs(open.tpl).length, 1);
    assert.equal(userTxs(open.tpl)[0].id, 'omit');
    const probed = await store.probeBlock(blockFrom(open.tpl));
    assert.equal(probed.ok, true, probed.reason);

    const twin = cloneSpend(spend, 'twin');
    const bits = retarget(store.blocks, now);
    const doubled = buildTemplate({
      prev: tip.hash,
      prevHeader: tip.header,
      prevBlock: tip,
      parentWeight: tip.weight,
      height: tip.height + 1,
      miner: dest,
      now,
      bits,
      parentBlocks: store.blocks,
      txs: [spend, twin],
    });
    const both = await store.probeBlock(blockFrom(doubled));
    assert.equal(both.ok, false);
    assert.equal(both.reason, 'admit_link_tag', both.reason);
    assert.equal(store.mempool.some((m) => m.id === 'omit'), true);

    const poisoned = cloneSpend(spend, 'poison');
    store.mempool.push(poisoned);
    const tipped = store.tip();
    const poisonNow = Number(decodeHeader(Buffer.from(tipped.header)).timestamp) + 90_000;
    const cleaned = store.template({ miner: dest, now: poisonNow });
    assert.equal(store.mempool.some((m) => m.id === 'poison'), false);
    assert.equal(store.mempool.some((m) => m.id === 'omit'), true);
    assert.equal(userTxs(cleaned.tpl).length, 1);
    const quiet = await store.probeBlock(blockFrom(cleaned.tpl));
    assert.equal(quiet.ok, true, quiet.reason);

    const sealed = cloneSpend(spend, 'sealed-omit');
    const mined = await appendBuilt(store, dest, [sealed]);
    assert.equal(mined.got.ok, true, mined.got.reason);
    assert.equal(store.fluxset().spendTags.has(real.toString('hex')), true);

    const stripped = store.blocks.map((b) => ({
      ...b,
      txs: (b.txs || []).map((tx) => {
        const copy = { ...tx, admit_proof: tx.admit_proof ? { ...tx.admit_proof } : undefined };
        delete copy.spendTag;
        if (copy.admit_proof) delete copy.admit_proof.spendTag;
        if (Array.isArray(tx.admit_proofs)) {
          copy.admit_proofs = tx.admit_proofs.map((p) => {
            const row = { ...p };
            delete row.spendTag;
            return row;
          });
        }
        return copy;
      }),
    }));
    const rebuilt = fluxsetFromBlocks(stripped);
    assert.equal(rebuilt.spendTags.has(real.toString('hex')), true);
    const second = fluxsetFromBlocks(stripped);
    assert.equal(second.spendTags.has(real.toString('hex')), true);

    const replayDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-tags-replay-'));
    fs.cpSync(dir, replayDir, { recursive: true });
    fs.copyFileSync(bookSealKeyPath(dir), bookSealKeyPath(replayDir));
    fs.rmSync(path.join(replayDir, 'book.snap'), { force: true });
    const loaded = createStore(replayDir);
    assert.equal(loaded.fluxset().spendTags.has(real.toString('hex')), true);
    const againLive = loaded.fluxset();
    const respent = sendBody({ id: 'respent', dest, notes: [pot], pay, fee, change });
    proveFlowSpend(respent, {
      spendSeed,
      spentNote: pot,
      pubs: againLive.pubs,
      commits: againLive.commits,
    });
    signSpendTx(respent, key);
    omitTags(respent);
    const againQ = loaded.queueTx(respent);
    assert.equal(againQ.ok, false);
    assert.equal(againQ.reason, 'admit_link_tag', againQ.reason);

    const parent = store.blocks[0];
    const sidePow = easyPow();
    const sideTpl = buildTemplate({
      prev: parent.hash,
      prevHeader: parent.header,
      prevBlock: parent,
      height: parent.height + 1,
      miner: dest,
      now: Number(decodeHeader(Buffer.from(parent.header)).timestamp) + 90_000,
      bits: retarget([parent], Number(decodeHeader(Buffer.from(parent.header)).timestamp) + 90_000),
      parentBlocks: [parent],
    });
    const side = blockFrom(sideTpl, sidePow);
    side.height = parent.height + 1;
    const held = await store.ingest([side], { trustBlockHash: true });
    assert.equal(held.ok, false, held.reason);
    assert.equal(held.reason, 'side_hold', held.reason);
    assert.equal(store.tip().height, 2);
    assert.equal(store.fluxset().spendTags.has(real.toString('hex')), true);

    const fork = [];
    let prev = parent;
    let stamp = Number(decodeHeader(Buffer.from(parent.header)).timestamp) + 90_000;
    for (let i = 0; i < 2; i += 1) {
      const chain = [parent].concat(fork);
      const tpl = buildTemplate({
        prev: prev.hash,
        prevHeader: prev.header,
        prevBlock: prev,
        height: prev.height + 1,
        miner: dest,
        now: stamp,
        bits: retarget(chain, stamp),
        parentBlocks: chain,
      });
      const pow = easyPow();
      const block = blockFrom(tpl, pow);
      block.height = prev.height + 1;
      fork.push(block);
      prev = block;
      stamp += 90_000;
    }
    const candidate = [parent].concat(fork);
    assert.equal(shouldAdopt(store.blocks, candidate), true);
    const won = await store.ingest(fork, { trustBlockHash: true });
    assert.equal(won.ok, true, won.reason);
    assert.equal(store.fluxset().spendTags.has(real.toString('hex')), false);
    const fresh = store.fluxset();
    const restored = sendBody({ id: 'restored', dest, notes: [pot], pay, fee, change });
    proveFlowSpend(restored, {
      spendSeed,
      spentNote: pot,
      pubs: fresh.pubs,
      commits: fresh.commits,
    });
    signSpendTx(restored, key);
    omitTags(restored);
    const restoredQ = store.queueTx(restored);
    assert.equal(restoredQ.ok, true, restoredQ.reason);
  });

  it('a multi-input spend records every tag, with or without the field', async () => {
    const { dest, spendSeed, key } = identityDest();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-tags-multi-'));
    const store = createStore(dir);
    const pots = [];
    for (let i = 0; i < 2; i += 1) {
      const mined = await appendBuilt(store, dest);
      assert.equal(mined.got.ok, true, mined.got.reason);
      pots.push(potOf(mined.tpl));
    }
    const opened = pots.map((note) => openedCoinbaseNanos(note));
    const pay = Math.max(1, Math.floor(Math.min(...opened) / 5));
    const live = store.fluxset();
    let fee = levyNanos(0);
    let tx = null;
    let proofs = [];
    // The levy is the weight of the tx that is actually queued. Proof bytes
    // dominate that weight, so price the body after it is built and repeat
    // until the paid fee covers it. Any input count, not one sample size.
    for (let pass = 0; pass < 8; pass += 1) {
      const change = opened[0] + opened[1] - pay - fee;
      assert.ok(change > 0, `change ${change} fee ${fee}`);
      tx = sendBody({ id: 'two', dest, notes: pots, pay, fee, change });
      proofs = [];
      for (let i = 0; i < pots.length; i += 1) {
        const index = fluxsetIndexOf(live.pubs, spendSeed, pots[i]);
        assert.ok(index >= 0, `index ${i}`);
        const proof = admitProve({
          x: admitScalarFromSeed(spendSeed, pots[i]),
          index,
          pubs: live.pubs,
          commits: live.commits,
          c: pots[i].commit,
          t: tx.vin[i]?.t != null ? scalarFrom(tx.vin[i].t) : undefined,
        });
        assert.ok(proof, `proof ${i}`);
        proofs.push(proof);
        tx.vin[i] = { commit: proof.cTilde, t: proof.t, r: pots[i].r };
      }
      tx.admit_proof = proofs[0];
      tx.admit_proofs = proofs;
      tx.excess = kernelExcess(tx.vout, tx.vin);
      assert.ok(tx.excess);
      signSpendTx(tx, key);
      omitTags(tx);
      const need = levyNanos(0, { tx });
      if (fee >= need) break;
      fee = need;
    }
    assert.ok(fee >= levyNanos(0, { tx }));
    const tags = proofs.map((proof) => blobTag(proof).toString('hex'));
    assert.equal(new Set(tags).size, tags.length);
    omitTags(tx);
    const queued = store.queueTx(tx);
    assert.equal(queued.ok, true, queued.reason);
    assert.deepEqual(tagHex(store.mempool.find((m) => m.id === 'two')), tags);
    const again = cloneSpend(tx, 'two-again');
    const rejected = store.queueTx(again);
    assert.equal(rejected.reason, 'admit_link_tag', rejected.reason);
    assert.equal(store.mempool.some((m) => m.id === 'two-again'), false);
    const tip = store.tip();
    const now = Number(decodeHeader(Buffer.from(tip.header)).timestamp) + 90_000;
    const open = store.template({ miner: dest, now });
    assert.equal(userTxs(open.tpl).length, 1);
    const probed = await store.probeBlock(blockFrom(open.tpl));
    assert.equal(probed.ok, true, probed.reason);
    const mined = await appendBuilt(store, dest, [cloneSpend(tx, 'two-sealed')]);
    assert.equal(mined.got.ok, true, mined.got.reason);
    for (const hex of tags) assert.equal(store.fluxset().spendTags.has(hex), true);
  });
});
