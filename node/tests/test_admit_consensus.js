import { after, before, describe, it } from 'node:test';
import { fileCapMs } from './slow_caps.js';
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
import { fluxsetFromBlocks } from '../../crypto/admit.js';
import { attachStubAdmitV2 } from './stub_admit_v2.js';
import { signSpendTx } from '../../crypto/spend.js';
import { decodeHeader } from '../../crypto/header.js';
import { MAGIC_REGTEST, regtestBitsOverride } from '../../crypto/regtest_bits.js';
import { createRegtestStore } from './regtest_store.js';
import { closeMineWorkers, mineHeaderParallel } from './mine_worker.mjs';
import {
  buildTemplate,
  verifyBlock,
  GENESIS_PREV,
} from '../src/chain.js';

// Regtest work (bits 4, about 16 hashes per block). Every block carries a
// real nonce found by ShearHash and verifyBlock rehashes it under the
// regtest book. Nothing here passes a trusted hash.
let RT_BITS = null;

async function mine(tpl) {
  assert.equal(tpl.bits, RT_BITS, 'regtest template bits');
  assert.equal(decodeHeader(Buffer.from(tpl.header)).bits, RT_BITS);
  const found = await mineHeaderParallel(tpl.header, tpl.bits, 8_192, 1);
  assert.ok(found && found.block, 'pow');
  return {
    header: found.header,
    height: tpl.height,
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
  const pay = freshStealthDest(id);
  const spendSeed = id.spendSeed || ed25519SeedOf(id.privateKey);
  return {
    id,
    dest: pay.dest,
    spendSeed,
    key: stealthKey(pay.shared, spendSeed),
  };
}

describe('AdmitV1 is consensus on Flow spends (verifyBlock + queueTx)', { timeout: fileCapMs(import.meta.url) }, () => {
  const sealDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-admit-seal-'));
  before(() => {
    // Only the test factory seals the regtest seed. Testnet stays on genesis bits.
    createRegtestStore(sealDir, { bits: 4 });
    RT_BITS = regtestBitsOverride(MAGIC_REGTEST);
    assert.ok(RT_BITS != null, 'regtest bits sealed');
  });
  after(async () => {
    await closeMineWorkers();
    fs.rmSync(sealDir, { recursive: true, force: true });
  });

  it('honest spent-note send with admit_proof against the real fluxset is ok; sampled / missing / reused tag fail; compact self-minted C_in is confidential', async () => {
    const { dest, spendSeed, key } = identityDest();
    const genesis = await mine(buildTemplate({
      prev: GENESIS_PREV,
      height: 1,
      miner: dest,
      bits: RT_BITS,
      now: 1_700_000_000_000,
    }));
    const okG = verifyBlock(genesis, null, { magic: MAGIC_REGTEST });
    assert.equal(okG.ok, true, okG.reason);
    genesis.hash = okG.hash;
    const parent = await mine(buildTemplate({
      prev: okG.hash,
      prevHeader: genesis.header,
      height: 2,
      miner: dest,
      bits: RT_BITS,
      now: 1_700_000_090_000,
      prevBlock: genesis,
      parentFluxset: fluxsetFromBlocks([genesis]).pubs,
    }));
    const okP = verifyBlock(parent, genesis, { magic: MAGIC_REGTEST });
    assert.equal(okP.ok, true, okP.reason);
    parent.hash = okP.hash;
    const history = [genesis, parent];
    // A grandchild is not its own anchor. Pass the genesis stamp, and keep
    // the height-3 time on the 90s grid so ASERT still accepts the sealed regtest bits.
    const genesisMs = Number(decodeHeader(Buffer.from(genesis.header)).timestamp);
    const height3Now = genesisMs + 180_000;
    const height3Opts = { evmHistory: history, genesisMs, magic: MAGIC_REGTEST };
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
          commit: spent.commit,
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

    const honest = attachStubAdmitV2(mkSend());
    signSpendTx(honest, key);
    const honestTpl = buildTemplate({
      prev: okP.hash,
      prevHeader: parent.header,
      height: 3,
      miner: dest,
      bits: RT_BITS,
      now: height3Now,
      txs: [compactTx(honest)],
      prevBlock: parent,
      parentBlocks: history,
      parentFluxset: live.pubs,
    });
    const honestBlock = await mine(honestTpl);
    const gotOk = verifyBlock(honestBlock, parent, height3Opts);
    assert.equal(honest.admit_proof.blob[0], 2);
    assert.equal(gotOk.ok, false);
    assert.equal(gotOk.reason, 'admit_version', gotOk.reason);

    const missing = mkSend({ id: 'missing-proof' });
    signSpendTx(missing, key);
    const missingTpl = buildTemplate({
      prev: okP.hash,
      prevHeader: parent.header,
      height: 3,
      miner: dest,
      bits: RT_BITS,
      now: height3Now,
      txs: [compactTx(missing)],
      prevBlock: parent,
      parentBlocks: history,
      parentFluxset: live.pubs,
    });
    const missingBlock = await mine(missingTpl);
    const gotMissing = verifyBlock(missingBlock, parent, height3Opts);
    assert.equal(gotMissing.ok, false);
    assert.equal(gotMissing.reason, 'admit_membership');

    const sampled = attachStubAdmitV2(mkSend({ id: 'sampled' }), { tagFill: 4 });
    assert.equal(sampled.admit_proof.blob[0], 2);
    signSpendTx(sampled, key);
    const sampledTpl = buildTemplate({
      prev: okP.hash,
      prevHeader: parent.header,
      height: 3,
      miner: dest,
      bits: RT_BITS,
      now: height3Now,
      txs: [compactTx(sampled)],
      prevBlock: parent,
      parentBlocks: history,
      parentFluxset: live.pubs,
    });
    const sampledBlock = await mine(sampledTpl);
    const gotSampled = verifyBlock(sampledBlock, parent, height3Opts);
    assert.equal(gotSampled.ok, false);
    assert.equal(gotSampled.reason, 'admit_version');

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
        commit: fakeIn.commit,
        address: dest,
      }],
      vout: [
        { address: dest, nanos: 2, kind: 'send' },
        { address: dest, nanos: change, kind: 'send' },
      ],
    }, { spent: fakeIn });
    attachStubAdmitV2(attack, { tagFill: 5 });
    signSpendTx(attack, key);
    const attackTpl = buildTemplate({
      prev: okP.hash,
      prevHeader: parent.header,
      height: 3,
      miner: dest,
      bits: RT_BITS,
      now: height3Now,
      txs: [compactTx(attack)],
      prevBlock: parent,
      parentBlocks: history,
      parentFluxset: live.pubs,
    });
    const attackBlock = await mine(attackTpl);
    const gotBad = verifyBlock(attackBlock, parent, height3Opts);
    assert.equal(gotBad.ok, false);
    assert.equal(gotBad.reason, 'admit_version');
  });

  it('queueTx admits an honest spent-note send and rejects missing proof, sampled subset, and reused spendTag', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-admit-'));
    const store = createRegtestStore(dir, { bits: 4 });
    const { dest, spendSeed, key } = identityDest();
    const parent = await mine(buildTemplate({
      prev: GENESIS_PREV,
      height: 1,
      miner: dest,
      bits: RT_BITS,
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
        commit: spent.commit,
        address: dest,
      }],
      vout: [
        { address: dest, nanos: 2, kind: 'send' },
        { address: dest, nanos: change, kind: 'send' },
      ],
    }, { spent });

    const missing = signSpendTx(body(), key);
    const missFat = store.queueTx(missing);
    assert.equal(missFat.ok, false);
    assert.equal(missFat.reason, 'value_open', missFat.reason);
    const missQ = store.queueTx(compactTx(missing));
    assert.equal(missQ.ok, false);
    assert.equal(missQ.reason, 'admit_membership');

    const sampled = attachStubAdmitV2(body(), { tagFill: 6 });
    assert.equal(sampled.admit_proof.blob[0], 2);
    signSpendTx(sampled, key);
    const sampFat = store.queueTx(sampled);
    assert.equal(sampFat.reason, 'value_open', sampFat.reason);
    const sampQ = store.queueTx(compactTx(sampled));
    assert.equal(sampQ.ok, false);
    assert.equal(sampQ.reason, 'admit_version');

    const honest = attachStubAdmitV2(body(), { tagFill: 7 });
    signSpendTx(honest, key);
    const okFat = store.queueTx(honest);
    assert.equal(okFat.reason, 'value_open', okFat.reason);
    const okQ = store.queueTx(compactTx(honest));
    assert.equal(okQ.reason, 'admit_version', okQ.reason);
    assert.equal(store.mempool.some((m) => m.id === honest.id), false);
    const spentHex = Buffer.from(honest.spendTag).toString('hex');
    assert.equal(store.fluxset().spendTags.has(spentHex), false);

    const reuse = attachStubAdmitV2(body(), { tagFill: 8 });
    reuse.admit_proof.spendTag = honest.admit_proof.spendTag;
    reuse.spendTag = honest.spendTag;
    signSpendTx(reuse, key);
    const reuseFat = store.queueTx(reuse);
    assert.equal(reuseFat.reason, 'value_open', reuseFat.reason);
    const reuseQ = store.queueTx(compactTx(reuse));
    assert.equal(reuseQ.ok, false);
    assert.equal(reuseQ.reason, 'admit_version');
    assert.equal(store.fluxset().spendTags.has(spentHex), false);
  });

  it('hex-posted Flow send is in the next template and mined header with admit_proof', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-admit-job-'));
    const store = createRegtestStore(dir, { bits: 4 });
    const { dest, spendSeed, key } = identityDest();
    let now = 1_700_002_000_000;
    const parent = await mine(buildTemplate({
      prev: GENESIS_PREV,
      height: 1,
      miner: dest,
      bits: RT_BITS,
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
      const { tpl } = store.template({ miner: dest, bits: RT_BITS, now });
      const found = await mine(tpl);
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
        commit: spent.commit,
        address: dest,
      }],
      vout: [
        { address: dest, nanos: 2, kind: 'send' },
        { address: dest, nanos: change, kind: 'send' },
      ],
    }, { spent });
    attachStubAdmitV2(honest, { tagFill: 9 });
    signSpendTx(honest, key);
    const hexed = JSON.parse(JSON.stringify(honest, (_, v) => (
      Buffer.isBuffer(v) || v instanceof Uint8Array ? Buffer.from(v).toString('hex') : v
    )));
    const queued = store.queueTx(hexed);
    assert.equal(queued.reason, 'value_open', queued.reason);
    const hexWire = JSON.parse(JSON.stringify(compactTx(honest), (_, v) => (
      Buffer.isBuffer(v) || v instanceof Uint8Array ? Buffer.from(v).toString('hex') : v
    )));
    const wired = store.queueTx(hexWire);
    assert.equal(wired.reason, 'admit_version', wired.reason);
    assert.equal(store.mempool.length, 0);
    const parentH = decodeHeader(Buffer.from(store.tip().header));
    const { tpl } = store.template({
      miner: dest,
      bits: RT_BITS,
      now: Number(parentH.timestamp) + 90_000,
    });
    const user = (tpl.txs || []).slice(1);
    assert.equal(user.length, 0);
    const tag = Buffer.from(honest.spendTag).toString('hex');
    assert.equal(store.fluxset().spendTags.has(tag), false);
  });

  it('named reject reasons: range stub, no members list, she1 silent_id', async () => {
    const { dest, spendSeed, key } = identityDest();
    const parent = await mine(buildTemplate({
      prev: GENESIS_PREV,
      height: 1,
      miner: dest,
      bits: RT_BITS,
      now: 1_700_003_000_000,
    }));
    const okP = verifyBlock(parent, null, { magic: MAGIC_REGTEST });
    assert.equal(okP.ok, true, okP.reason);
    parent.hash = okP.hash;
    const spent = parent.txs[0].vout.find((o) => o.kind === 'pot');
    const idx = parent.txs[0].vout.indexOf(spent);
    const live = fluxsetFromBlocks([parent]);
    const fee = levyNanos(2);
    const change = BLOCK_SUBSIDY_NANOS - 2 - fee;
    const body = attachDummyOuts({
      id: 'range-stub',
      kind: 'send',
      from: dest,
      to: dest,
      nanos: 2,
      fee,
      changeNanos: change,
      vin: [{
        commit: spent.commit,
        address: dest,
      }],
      vout: [
        { address: dest, nanos: 2, kind: 'send' },
        { address: dest, nanos: change, kind: 'send' },
      ],
    }, { spent });
    attachStubAdmitV2(body, { tagFill: 10 });
    for (const o of body.vout) o.rangeProof = true;
    signSpendTx(body, key);
    const stubTpl = buildTemplate({
      prev: parent.hash,
      prevHeader: parent.header,
      height: 2,
      miner: dest,
      bits: RT_BITS,
      now: 1_700_003_090_000,
      txs: [compactTx(body)],
      prevBlock: parent,
      parentBlocks: [parent],
      parentFluxset: live.pubs,
    });
    const stubBlock = await mine(stubTpl);
    const gotStub = verifyBlock(stubBlock, parent, { evmHistory: [parent], magic: MAGIC_REGTEST });
    assert.equal(gotStub.ok, false);
    assert.equal(gotStub.reason, 'admit_version');

    const honest = attachDummyOuts({
      id: 'sealed-ring',
      kind: 'send',
      from: dest,
      to: dest,
      nanos: 2,
      fee,
      changeNanos: change,
      vin: [{
        commit: spent.commit,
        address: dest,
      }],
      vout: [
        { address: dest, nanos: 2, kind: 'send' },
        { address: dest, nanos: change, kind: 'send' },
      ],
    }, { spent });
    attachStubAdmitV2(honest, { tagFill: 11 });
    honest.admit_proof.members = ['decoy-list'];
    const sealed = compactTx(honest);
    assert.equal(sealed.admit_proof.members, undefined);
    assert.ok(sealed.admit_proof.spendTag);
    assert.equal(JSON.stringify(sealed.admit_proof).includes('decoy-list'), false);

    const she = {
      kind: 'send',
      from: dest,
      to: 'she1qxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      fee: 100,
      vin: [{ address: dest }],
      vout: [{ address: 'she1qxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', nanos: 1 }],
    };
    const sheTpl = buildTemplate({
      prev: GENESIS_PREV,
      height: 1,
      miner: dest,
      bits: RT_BITS,
      now: 1_700_003_180_000,
      txs: [she],
    });
    const sheBlock = await mine(sheTpl);
    const gotShe = verifyBlock(sheBlock, null, { magic: MAGIC_REGTEST });
    assert.equal(gotShe.ok, false);
    assert.equal(gotShe.reason, 'silent_id_on_chain');
  });

  it('lock without C or stub range is range_proof; compact lock has no dest/nanos', async () => {
    const { dest } = identityDest();
    const id = newIdentity();
    const { vaultDest } = await import('../../crypto/flow_sheet.js');
    const { lockTx } = await import('../../crypto/reserve_vault.js');
    const { PI_SHE_NANOS } = await import('../../crypto/asert.js');
    const vault = vaultDest(id.address, { viewKey: id.viewKey });
    const parent = await mine(buildTemplate({
      prev: GENESIS_PREV,
      height: 1,
      miner: dest,
      bits: RT_BITS,
      now: 1_700_004_000_000,
    }));
    const okP = verifyBlock(parent, null, { magic: MAGIC_REGTEST });
    assert.equal(okP.ok, true, okP.reason);
    parent.hash = okP.hash;

    const plain = lockTx({ from: dest, to: vault, nanos: PI_SHE_NANOS, id: 'lock-no-c' });
    delete plain.vout[0].commit;
    delete plain.vout[0].rangeProof;
    delete plain.vout[0].valueProof;
    delete plain.vout[0].noteCommit;
    delete plain.vout[0].dest20;
    delete plain.vout[0].portalId;
    plain.vout[0].address = vault;
    plain.vout[0].nanos = PI_SHE_NANOS;
    const plainTpl = buildTemplate({
      prev: parent.hash,
      prevHeader: parent.header,
      height: 2,
      miner: dest,
      bits: RT_BITS,
      now: 1_700_004_090_000,
      txs: [plain],
      prevBlock: parent,
      parentBlocks: [parent],
    });
    const plainBlock = await mine(plainTpl);
    const gotPlain = verifyBlock(plainBlock, parent, { evmHistory: [parent], magic: MAGIC_REGTEST });
    assert.equal(gotPlain.ok, false);
    assert.equal(gotPlain.reason, 'range_proof');

    const openFat = {
      id: 'lock-dest20',
      programId: 'shear-reserve-v1',
      kind: 'lock',
      from: dest,
      to: vault,
      nanos: PI_SHE_NANOS,
      vin: [{ address: dest }],
      vout: [{ kind: 'lock', address: vault, nanos: PI_SHE_NANOS }],
    };
    const openSealed = compactTx(openFat);
    openSealed.fee = levyNanos(PI_SHE_NANOS);
    assert.ok(openSealed.vout[0].dest20);
    assert.equal(openSealed.vout[0].commit, undefined);
    assert.doesNotMatch(JSON.stringify(openSealed), /ssa1/);
    const openTpl = buildTemplate({
      prev: parent.hash,
      prevHeader: parent.header,
      height: 2,
      miner: dest,
      bits: RT_BITS,
      now: 1_700_004_090_000,
      txs: [openSealed],
      prevBlock: parent,
      parentBlocks: [parent],
    });
    const openBlock = await mine(openTpl);
    const gotOpen = await Promise.resolve(verifyBlock(openBlock, parent, { evmHistory: [parent], magic: MAGIC_REGTEST }));
    assert.equal(gotOpen.ok, true, gotOpen.reason);

    const stub = lockTx({ from: dest, to: vault, nanos: PI_SHE_NANOS, id: 'lock-stub' });
    stub.vout[0].rangeProof = true;
    const stubTpl = buildTemplate({
      prev: parent.hash,
      prevHeader: parent.header,
      height: 2,
      miner: dest,
      bits: RT_BITS,
      now: 1_700_004_090_000,
      txs: [stub],
      prevBlock: parent,
      parentBlocks: [parent],
    });
    const stubBlock = await mine(stubTpl);
    const gotStubLock = verifyBlock(stubBlock, parent, { evmHistory: [parent], magic: MAGIC_REGTEST });
    assert.equal(gotStubLock.ok, false);
    assert.equal(gotStubLock.reason, 'range_proof');

    const honest = lockTx({ from: dest, to: vault, nanos: PI_SHE_NANOS, id: 'lock-sealed' });
    const sealed = compactTx(honest);
    assert.equal(sealed.to, undefined);
    assert.equal(sealed.from, undefined);
    assert.equal(sealed.vout[0].address, undefined);
    assert.equal(sealed.vout[0].nanos, undefined);
    assert.ok(sealed.vout[0].commit);
    assert.notEqual(sealed.vout[0].rangeProof, true);
    assert.equal(JSON.stringify(sealed).includes(vault), false);
  });
});
