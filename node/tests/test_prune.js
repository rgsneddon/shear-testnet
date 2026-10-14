import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newIdentity, destOpeningFromView, freshStealthDest } from '../../crypto/address.js';
import { spendBox, admitSend } from '../../tests/spend_box.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { HASH_BONUS_NANOS, SPENDABLE_CONFIRMATIONS, SAMPLE_PRUNE_CONFIRMATIONS, BLOCK_SUBSIDY_NANOS, GENESIS_BITS_PACKED } from '../../crypto/asert.js';
import { levyNanos } from '../../crypto/levy.js';
import { attachDummyOuts } from '../../crypto/dummy.js';
import { signSpendTx } from '../../crypto/spend.js';
import { buildTemplate, verifyBlock, GENESIS_PREV } from '../src/chain.js';
import { createStore } from '../src/store.js';
import { reconstructOwner } from '../../pool/src/wallet_api.js';
import { readChainSegments } from '../../crypto/chainbin.js';
import { decodeHeader } from '../../crypto/header.js';

let powTag = 1;
function mine(tpl) {
  const pow = Buffer.alloc(32, 0);
  pow[31] = powTag;
  powTag += 1;
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
    trustedPowHash: pow,
  };
}
function trust(block) {
  return { trustedPowHash: block.trustedPowHash || block.hash, skipSharePow: true };
}

describe('node chain is lean, light, scalable, prunable', { timeout: 600_000 }, () => {
  it('collates hashes, prunes sample bodies, keeps sealed txs for explorer', async () => {
    const alice = newIdentity();
    const bob = newIdentity();
    const aliceBox = spendBox(alice);
    const destA = aliceBox.dest;
    const destB = freshStealthDest(bob).dest;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-prune-'));
    const store = createStore(dir, { pruneAfter: 2 });
    const fat = Array.from({ length: 250 }, (_, i) => ({
      miner: destA,
      nonce: String(i),
      tag: 'a',
      count: 1,
    }));
    const t0 = 1_700_000_000_000;

    const b1 = mine(buildTemplate({
      prev: GENESIS_PREV,
      height: 1,
      miner: destA,
      bits: GENESIS_BITS_PACKED,
      now: t0,
      samples: fat,
    }));
    const a1 = await Promise.resolve(store.append(b1, trust(b1)));
    assert.equal(a1.ok, true, a1.reason);
    assert.equal(store.blocks[0].samples.length, 1);
    assert.equal(store.blocks[0].samples[0].count, 250);
    assert.equal(store.blocks[0].txs[0].samples, undefined);

    let lastPot = null;
    for (let i = 1; i < SPENDABLE_CONFIRMATIONS + 1; i += 1) {
      const parent = store.tip();
      const parentH = decodeHeader(Buffer.from(parent.header));
      const nxt = mine(buildTemplate({
        prev: parent.hash,
        prevHeader: parent.header,
        height: parent.height + 1,
        miner: destA,
        bits: GENESIS_BITS_PACKED,
        now: Number(parentH.timestamp) + 90_000,
      }));
      const pot = (nxt.txs[0].vout || []).find((o) => o.kind === 'pot');
      lastPot = {
        commit: pot.commit,
        noteCommit: pot.noteCommit,
        r: pot.r,
        index: nxt.txs[0].vout.indexOf(pot),
      };
      assert.equal((await Promise.resolve(store.append(nxt, trust(nxt)))).ok, true);
    }
    const fee = levyNanos(3);
    const change = BLOCK_SUBSIDY_NANOS - 3 - fee;
    const send = attachDummyOuts({
      id: 'send-forever',
      kind: 'send',
      from: destA,
      to: destB,
      nanos: 3,
      fee,
      changeNanos: change,
      open: destOpeningFromView(alice.viewKey, alice.spendPub, 0),
      vin: [{
        commit: lastPot.commit,
        address: destA,
      }],
      vout: [
        { address: destB, nanos: 3, kind: 'send' },
        { address: destA, nanos: change, kind: 'send' },
      ],
    }, { spent: lastPot });
    admitSend(send, { id: alice, spent: { ...lastPot, kind: 'pot' }, blocks: store.blocks });
    signSpendTx(send, aliceBox.key);
    const parentSend = store.tip();
    const parentSendH = decodeHeader(Buffer.from(parentSend.header));
    const sendBlock = mine(buildTemplate({
      prev: parentSend.hash,
      prevHeader: parentSend.header,
      prevBlock: parentSend,
      parentBlocks: store.blocks,
      height: parentSend.height + 1,
      miner: destA,
      bits: GENESIS_BITS_PACKED,
      now: Number(parentSendH.timestamp) + 90_000,
      txs: [send],
    }));
    const sendOk = await Promise.resolve(store.append(sendBlock, trust(sendBlock)));
    assert.equal(sendOk.ok, true, sendOk.reason);
    const sendHeight = store.tip().height;

    for (let i = 0; i < 2; i += 1) {
      const parent = store.tip();
      const parentH = decodeHeader(Buffer.from(parent.header));
      const nxt = mine(buildTemplate({
        prev: parent.hash,
        prevHeader: parent.header,
        height: parent.height + 1,
        miner: destA,
        bits: GENESIS_BITS_PACKED,
        now: Number(parentH.timestamp) + 90_000,
      }));
      assert.equal((await Promise.resolve(store.append(nxt, trust(nxt)))).ok, true);
    }

    const buried = store.blocks.find((b) => Number(b.height) === sendHeight) || store.blocks[0];
    const genesis = store.blocks[0];
    assert.notEqual(genesis.samplesPruned, true);
    assert.ok((genesis.samples || []).length > 0);
    assert.ok(genesis.txs[0].vout.some((o) => o.kind === 'pot'));
    assert.equal(HASH_BONUS_NANOS, 1);
    assert.ok(buried.txs.slice(1).some((t) => t.id === 'send-forever'));

    const segDir = path.join(dir, 'segments');
    assert.equal(fs.existsSync(path.join(segDir, 'seg-000000.bin')), true);
    const epochs = readChainSegments(segDir);
    assert.ok(epochs.length >= 1);
    assert.equal(epochs[0].samplesPruned, false);
    assert.ok(epochs[0].txs[0].vout.some((o) => o.kind === 'pot'));
    const sendEpoch = epochs.find((e) => (e.txs || []).some((t) => t.id === 'send-forever'));
    assert.ok(sendEpoch, 'send-forever stays in the pruned chainbin');
    assert.ok(sendEpoch.txs.slice(1).some((t) => t.id === 'send-forever'));
    const buriedBin = verifyBlock({
      ...epochs[0],
      samples: [],
      shareBatch: [],
      samplesPruned: true,
      height: epochs[0].height || 1,
    }, null, { tipHeight: SAMPLE_PRUNE_CONFIRMATIONS + 1, trustedPowHash: epochs[0].hash, skipSharePow: true });
    assert.equal(buriedBin.ok, false);
    assert.equal(buriedBin.reason, 'samples_pruned');

    const histAlice = reconstructOwner(store, destA);
    const histBob = reconstructOwner(store, destB);
    assert.ok(histAlice.txs.some((t) => String(t.id).startsWith('send-forever')));
    assert.ok(histBob.txs.some((t) => String(t.id).startsWith('send-forever')));
    assert.ok(histAlice.txs.some((t) => t.kind === 'hash' || t.kind === 'coinbase'));

    const buriedCheck = verifyBlock(genesis, null, {
      tipHeight: SAMPLE_PRUNE_CONFIRMATIONS + Number(genesis.height || 1),
      ...trust(genesis),
    });
    assert.equal(buriedCheck.ok, true, buriedCheck.reason);

    const reopened = createStore(dir, { pruneAfter: 2 });
    const again = reconstructOwner(reopened, destB);
    assert.ok(again.txs.some((t) => String(t.id).startsWith('send-forever')));
  });
});
