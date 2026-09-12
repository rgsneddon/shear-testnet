import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newIdentity, freshStealthDest, ed25519SeedOf, stealthKey } from '../../crypto/address.js';
import { attachDummyOuts } from '../../crypto/dummy.js';
import { sealNote } from '../../crypto/note.js';
import { compactTx } from '../../crypto/chronoflux.js';
import { BLOCK_SUBSIDY_NANOS } from '../../crypto/asert.js';
import { levyNanos } from '../../crypto/levy.js';
import { admitProve, admitScalarFromSeed, fluxsetFromBlocks, proveFlowSpend } from '../../crypto/admit.js';
import { signSpendTx } from '../../crypto/spend.js';
import { decodeHeader } from '../../crypto/header.js';
import { createStore } from '../src/store.js';
import {
  buildTemplate,
  mineTemplate,
  verifyBlock,
  GENESIS_PREV,
} from '../src/chain.js';

function mine(tpl) {
  const found = mineTemplate(tpl, { maxTries: 3_000_000, shareBits: tpl.bits });
  assert.ok(found && found.block, 'pow');
  return {
    header: found.header,
    txs: tpl.txs,
    samples: tpl.samples,
    miner: tpl.miner,
    aLeaves: tpl.aLeaves,
    bLeaves: tpl.bLeaves,
    rootA: tpl.rootA,
    rootB: tpl.rootB,
    weight: tpl.weight,
    hash: found.hash,
  };
}

function identityDest() {
  const id = newIdentity();
  const pay = freshStealthDest(id.paymentCode);
  const spendSeed = id.spendSeed || ed25519SeedOf(id.privateKey);
  return {
    id,
    dest: pay.dest,
    spendSeed,
    key: stealthKey(pay.shared, spendSeed),
  };
}

describe('AdmitV1 is consensus on Flow spends (verifyBlock + queueTx)', () => {
  it('honest spent-note send with admit_proof against the real fluxset is ok; sampled / missing / reused tag fail; compact self-minted C_in is confidential', () => {
    const { dest, spendSeed, key } = identityDest();
    const genesis = mine(buildTemplate({
      prev: GENESIS_PREV,
      height: 1,
      miner: dest,
      bits: 4,
      now: 1_700_000_000_000,
    }));
    const okG = verifyBlock(genesis, null);
    assert.equal(okG.ok, true, okG.reason);
    genesis.hash = okG.hash;
    const parent = mine(buildTemplate({
      prev: okG.hash,
      prevHeader: genesis.header,
      height: 2,
      miner: dest,
      bits: 4,
      now: 1_700_000_090_000,
      prevBlock: genesis,
      parentFluxset: fluxsetFromBlocks([genesis]).pubs,
    }));
    const okP = verifyBlock(parent, genesis);
    assert.equal(okP.ok, true, okP.reason);
    parent.hash = okP.hash;
    const history = [genesis, parent];
    const spent = parent.txs[0].vout.find((o) => o.kind === 'pot');
    assert.ok(spent?.commit && spent.admitPub, 'coinbase note enters J');
    const idx = parent.txs[0].vout.indexOf(spent);
    const live = fluxsetFromBlocks(history);
    assert.ok(live.pubs.length >= 2, 'fluxset has more than a sampled singleton');
    const fee = levyNanos(2);
    const change = BLOCK_SUBSIDY_NANOS - 2 - fee;
    const mkSend = (extra = {}) => {
      const tx = attachDummyOuts({
        id: extra.id || 'honest-send',
        kind: 'send',
        from: dest,
        to: dest,
        nanos: 2,
        fee,
        changeNanos: change,
        vin: [{
          prev: parent.hash,
          index: idx,
          commit: spent.commit,
          noteCommit: spent.noteCommit,
          r: spent.r,
          address: dest,
        }],
        vout: [
          { address: dest, nanos: 2, kind: 'send' },
          { address: dest, nanos: change, kind: 'send' },
        ],
        ...extra.tx,
      }, { spent: extra.spent || spent });
      return tx;
    };

    const honest = proveFlowSpend(mkSend(), { spendSeed, spentNote: spent, pubs: live.pubs });
    signSpendTx(honest, key);
    const honestTpl = buildTemplate({
      prev: okP.hash,
      prevHeader: parent.header,
      height: 3,
      miner: dest,
      bits: 4,
      now: 1_700_000_180_000,
      txs: [compactTx(honest)],
      prevBlock: parent,
      parentBlocks: history,
      parentFluxset: live.pubs,
    });
    const honestBlock = mine(honestTpl);
    const gotOk = verifyBlock(honestBlock, parent, { evmHistory: history });
    assert.equal(gotOk.ok, true, gotOk.reason);

    const missing = mkSend({ id: 'missing-proof' });
    signSpendTx(missing, key);
    const missingTpl = buildTemplate({
      prev: okP.hash,
      prevHeader: parent.header,
      height: 3,
      miner: dest,
      bits: 4,
      now: 1_700_000_270_000,
      txs: [compactTx(missing)],
      prevBlock: parent,
      parentBlocks: history,
      parentFluxset: live.pubs,
    });
    const missingBlock = mine(missingTpl);
    const gotMissing = verifyBlock(missingBlock, parent, { evmHistory: history });
    assert.equal(gotMissing.ok, false);
    assert.equal(gotMissing.reason, 'admit');

    const sampled = mkSend({ id: 'sampled' });
    const subset = live.pubs.slice(0, 1);
    sampled.admit_proof = admitProve({
      x: admitScalarFromSeed(spendSeed, spent),
      index: 0,
      pubs: subset,
    });
    signSpendTx(sampled, key);
    const sampledTpl = buildTemplate({
      prev: okP.hash,
      prevHeader: parent.header,
      height: 3,
      miner: dest,
      bits: 4,
      now: 1_700_000_360_000,
      txs: [compactTx(sampled)],
      prevBlock: parent,
      parentBlocks: history,
      parentFluxset: live.pubs,
    });
    const sampledBlock = mine(sampledTpl);
    const gotSampled = verifyBlock(sampledBlock, parent, { evmHistory: history });
    assert.equal(gotSampled.ok, false);
    assert.equal(gotSampled.reason, 'admit');

    const fakeIn = sealNote(2 + change + fee, { dest20: Buffer.alloc(20, 9), kind: 'spend-in' });
    const attack = attachDummyOuts({
      id: 'fake-in',
      kind: 'send',
      from: dest,
      to: dest,
      nanos: 2,
      fee,
      changeNanos: change,
      vin: [{
        prev: parent.hash,
        index: idx,
        commit: fakeIn.commit,
        noteCommit: fakeIn.noteCommit,
        r: fakeIn.r,
        address: dest,
      }],
      vout: [
        { address: dest, nanos: 2, kind: 'send' },
        { address: dest, nanos: change, kind: 'send' },
      ],
    }, { spent: fakeIn });
    proveFlowSpend(attack, { spendSeed, spentNote: spent, pubs: live.pubs });
    signSpendTx(attack, key);
    const attackTpl = buildTemplate({
      prev: okP.hash,
      prevHeader: parent.header,
      height: 3,
      miner: dest,
      bits: 4,
      now: 1_700_000_450_000,
      txs: [compactTx(attack)],
      prevBlock: parent,
      parentBlocks: history,
      parentFluxset: live.pubs,
    });
    const attackBlock = mine(attackTpl);
    const gotBad = verifyBlock(attackBlock, parent, { evmHistory: history });
    assert.equal(gotBad.ok, false);
    assert.equal(gotBad.reason, 'confidential');
  });

  it('queueTx admits an honest spent-note send and rejects missing proof, sampled subset, and reused spendTag', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-admit-'));
    const store = createStore(dir);
    const { dest, spendSeed, key } = identityDest();
    const parent = mine(buildTemplate({
      prev: GENESIS_PREV,
      height: 1,
      miner: dest,
      bits: 4,
      now: 1_700_001_000_000,
    }));
    const appended = store.append({
      header: parent.header,
      txs: parent.txs,
      samples: parent.samples,
      miner: dest,
    });
    assert.equal(appended.ok, true, appended.reason);
    const rebuilt = fluxsetFromBlocks(store.blocks);
    assert.equal(Buffer.from(store.jroot()).equals(Buffer.from(rebuilt.jroot)), true);
    assert.equal(store.fluxset().pubs.length, rebuilt.pubs.length);
    assert.ok(store.fluxset().pubs.length >= 1, 'coinbase notes enter live J');
    const spent = parent.txs[0].vout.find((o) => o.kind === 'pot');
    const idx = parent.txs[0].vout.indexOf(spent);
    const live = store.fluxset();
    const fee = levyNanos(2);
    const change = BLOCK_SUBSIDY_NANOS - 2 - fee;
    const body = () => attachDummyOuts({
      id: `send-${Math.random()}`,
      kind: 'send',
      from: dest,
      to: dest,
      nanos: 2,
      fee,
      changeNanos: change,
      vin: [{
        prev: appended.block.hash,
        index: idx,
        commit: spent.commit,
        noteCommit: spent.noteCommit,
        r: spent.r,
        address: dest,
      }],
      vout: [
        { address: dest, nanos: 2, kind: 'send' },
        { address: dest, nanos: change, kind: 'send' },
      ],
    }, { spent });

    const missing = signSpendTx(body(), key);
    const missQ = store.queueTx(missing);
    assert.equal(missQ.ok, false);
    assert.equal(missQ.reason, 'admit');

    const honest = proveFlowSpend(body(), { spendSeed, spentNote: spent, pubs: live.pubs });
    signSpendTx(honest, key);
    const okQ = store.queueTx(honest);
    assert.equal(okQ.ok, true, okQ.reason);

    const reuse = proveFlowSpend(body(), { spendSeed, spentNote: spent, pubs: live.pubs });
    reuse.admit_proof.spendTag = honest.admit_proof.spendTag;
    reuse.spendTag = honest.spendTag;
    signSpendTx(reuse, key);
    const reuseQ = store.queueTx(reuse);
    assert.equal(reuseQ.ok, false);
    assert.equal(reuseQ.reason, 'admit');

    const sampled = body();
    const subset = live.pubs.slice(0, 1);
    sampled.admit_proof = admitProve({
      x: admitScalarFromSeed(spendSeed, spent),
      index: 0,
      pubs: subset,
    });
    signSpendTx(sampled, key);
    const sampQ = store.queueTx(sampled);
    assert.equal(sampQ.ok, false);
    assert.equal(sampQ.reason, 'admit');
  });

  it('hex-posted Flow send is in the next template and mined header with admit_proof', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-admit-job-'));
    const store = createStore(dir);
    const { dest, spendSeed, key } = identityDest();
    let now = 1_700_002_000_000;
    const parent = mine(buildTemplate({
      prev: GENESIS_PREV,
      height: 1,
      miner: dest,
      bits: 4,
      now,
    }));
    let appended = store.append({
      header: parent.header,
      txs: parent.txs,
      samples: parent.samples,
      miner: dest,
    });
    assert.equal(appended.ok, true, appended.reason);
    const genesisHash = appended.block.hash;
    const spent = parent.txs[0].vout.find((o) => o.kind === 'pot');
    const idx = parent.txs[0].vout.indexOf(spent);
    for (let h = 2; h <= 6; h += 1) {
      now += 90_000;
      const { tpl } = store.template({ miner: dest, bits: 4, now });
      const found = mine(tpl);
      appended = store.append({
        header: found.header,
        txs: tpl.txs,
        samples: tpl.samples,
        shareBatch: tpl.shareBatch || [],
        miner: dest,
        aLeaves: tpl.aLeaves,
        bLeaves: tpl.bLeaves,
        rootA: tpl.rootA,
        rootB: tpl.rootB,
      });
      assert.equal(appended.ok, true, appended.reason);
    }
    const live = store.fluxset();
    const fee = levyNanos(2);
    const change = BLOCK_SUBSIDY_NANOS - 2 - fee;
    const honest = attachDummyOuts({
      id: 'job-send',
      kind: 'send',
      from: dest,
      to: dest,
      nanos: 2,
      fee,
      changeNanos: change,
      vin: [{
        prev: genesisHash,
        index: idx,
        commit: spent.commit,
        noteCommit: spent.noteCommit,
        r: spent.r,
        address: dest,
      }],
      vout: [
        { address: dest, nanos: 2, kind: 'send' },
        { address: dest, nanos: change, kind: 'send' },
      ],
    }, { spent });
    proveFlowSpend(honest, { spendSeed, spentNote: spent, pubs: live.pubs });
    signSpendTx(honest, key);
    const hexed = JSON.parse(JSON.stringify(honest, (_, v) => (
      Buffer.isBuffer(v) || v instanceof Uint8Array ? Buffer.from(v).toString('hex') : v
    )));
    const queued = store.queueTx(hexed);
    assert.equal(queued.ok, true, queued.reason);
    const parentH = decodeHeader(Buffer.from(store.tip().header));
    const { tpl } = store.template({
      miner: dest,
      bits: 4,
      now: Number(parentH.timestamp) + 90_000,
    });
    const user = (tpl.txs || []).slice(1);
    assert.equal(user.length, 1, 'mempool send must be in the next job');
    assert.equal(user[0].id, 'job-send');
    assert.ok(user[0].admit_proof);
    const found = mine(tpl);
    const got = store.append({
      header: found.header,
      txs: tpl.txs,
      samples: tpl.samples,
      shareBatch: tpl.shareBatch || [],
      miner: dest,
      aLeaves: tpl.aLeaves,
      bLeaves: tpl.bLeaves,
      rootA: tpl.rootA,
      rootB: tpl.rootB,
    });
    assert.equal(got.ok, true, got.reason);
    const onchain = store.blocks.at(-1).txs.find((t) => !t.coinbase);
    assert.ok(onchain, 'user send on chain');
    assert.ok(onchain.admit_proof, 'admit_proof persisted');
    assert.equal(store.mempool.length, 0);
  });
});
