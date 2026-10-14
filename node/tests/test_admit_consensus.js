import { spawn } from 'node:child_process';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { newIdentity, freshStealthDest, ed25519SeedOf, stealthKey } from '../../crypto/address.js';
import { attachDummyOuts } from '../../crypto/dummy.js';
import { sealNote } from '../../crypto/note.js';
import { compactTx } from '../../crypto/chronoflux.js';
import { BLOCK_SUBSIDY_NANOS, GENESIS_BITS_PACKED } from '../../crypto/asert.js';
import { levyNanos } from '../../crypto/levy.js';
import { fluxsetFromBlocks } from '../../crypto/admit.js';
import { attachStubAdmitV2 } from './stub_admit_v2.js';
import { signSpendTx } from '../../crypto/spend.js';
import { setHashBackend } from '../../crypto/shear_hash.js';
import { decodeHeader } from '../../crypto/header.js';
import { createStore } from '../src/store.js';
import {
  buildTemplate,
  verifyBlock,
  GENESIS_PREV,
} from '../src/chain.js';

// Genesis is 17 bits, so a hit is expected after 2^17 hashes. The old 32_768
// cap was sized for a 12-bit header and misses about three searches in four.
// Sixteen times the expectation, striped across every CPU, makes a miss rare.
// The jit check below stays. Verify goes back to the interpreter before return.
const MINE_TRIES = 2_097_152;

function mine(tpl) {
  const backend = setHashBackend('jit');
  if (backend !== 'jit') {
    setHashBackend('interpreter');
    assert.fail(`admit miner needs jit, got ${backend}`);
  }
  try {
    const found = mineAcrossCpus(tpl);
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
  } finally {
    setHashBackend('interpreter');
  }
}

const sleepFlag = new Int32Array(new SharedArrayBuffer(4));

function sleepMs(ms) {
  Atomics.wait(sleepFlag, 0, 0, ms);
}

function mineAcrossCpus(tpl) {
  const cpus = Math.max(1, os.availableParallelism());
  const perWorker = Math.ceil(MINE_TRIES / cpus);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-admit-mine-'));
  const outPath = path.join(dir, 'hit.json');
  const stopPath = path.join(dir, 'stop');
  const workerPath = fileURLToPath(new URL('./admit_mine_worker.js', import.meta.url));
  const headerHex = Buffer.from(tpl.header).toString('hex');
  const children = [];
  try {
    for (let cpu = 0; cpu < cpus; cpu += 1) {
      children.push(spawn(process.execPath, [
        workerPath,
        headerHex,
        String(tpl.bits),
        String(cpu),
        String(cpus),
        String(perWorker),
        outPath,
        stopPath,
        path.join(dir, `done-${cpu}`),
      ], { stdio: 'ignore' }));
    }
    const hitFile = () => fs.readdirSync(dir).find((name) => name.startsWith('hit.json.'));
    while (!hitFile()) {
      const finished = fs.readdirSync(dir).filter((name) => name.startsWith('done-')).length;
      if (finished >= cpus) break;
      sleepMs(200);
    }
    fs.writeFileSync(stopPath, '1');
    for (const child of children) {
      if (child.exitCode == null) child.kill('SIGTERM');
    }
    const name = hitFile();
    if (!name) return null;
    const hit = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
    if (hit.error) assert.fail(hit.error);
    return {
      header: Buffer.from(hit.header, 'hex'),
      hash: Buffer.from(hit.hash, 'hex'),
      block: true,
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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

describe('AdmitV1 is consensus on Flow spends (verifyBlock + queueTx)', () => {
  it('honest spent-note send with admit_proof against the real fluxset is ok; sampled / missing / reused tag fail; compact self-minted C_in is confidential', () => {
    const { dest, spendSeed, key } = identityDest();
    const genesis = mine(buildTemplate({
      prev: GENESIS_PREV,
      height: 1,
      miner: dest,
      bits: GENESIS_BITS_PACKED,
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
      bits: GENESIS_BITS_PACKED,
      now: 1_700_000_090_000,
      prevBlock: genesis,
      parentFluxset: fluxsetFromBlocks([genesis]).pubs,
    }));
    const okP = verifyBlock(parent, genesis);
    assert.equal(okP.ok, true, okP.reason);
    parent.hash = okP.hash;
    const history = [genesis, parent];
    // A grandchild is not its own anchor. Pass the genesis stamp, and keep
    // the height-3 time on the 90s grid so ASERT still accepts GENESIS_BITS_PACKED.
    const genesisMs = Number(decodeHeader(Buffer.from(genesis.header)).timestamp);
    const height3Now = genesisMs + 180_000;
    const height3Opts = { evmHistory: history, genesisMs };
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
      bits: GENESIS_BITS_PACKED,
      now: height3Now,
      txs: [compactTx(honest)],
      prevBlock: parent,
      parentBlocks: history,
      parentFluxset: live.pubs,
    });
    const honestBlock = mine(honestTpl);
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
      bits: GENESIS_BITS_PACKED,
      now: height3Now,
      txs: [compactTx(missing)],
      prevBlock: parent,
      parentBlocks: history,
      parentFluxset: live.pubs,
    });
    const missingBlock = mine(missingTpl);
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
      bits: GENESIS_BITS_PACKED,
      now: height3Now,
      txs: [compactTx(sampled)],
      prevBlock: parent,
      parentBlocks: history,
      parentFluxset: live.pubs,
    });
    const sampledBlock = mine(sampledTpl);
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
      bits: GENESIS_BITS_PACKED,
      now: height3Now,
      txs: [compactTx(attack)],
      prevBlock: parent,
      parentBlocks: history,
      parentFluxset: live.pubs,
    });
    const attackBlock = mine(attackTpl);
    const gotBad = verifyBlock(attackBlock, parent, height3Opts);
    assert.equal(gotBad.ok, false);
    assert.equal(gotBad.reason, 'admit_version');
  });

  it('queueTx admits an honest spent-note send and rejects missing proof, sampled subset, and reused spendTag', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-admit-'));
    const store = createStore(dir);
    const { dest, spendSeed, key } = identityDest();
    const parent = mine(buildTemplate({
      prev: GENESIS_PREV,
      height: 1,
      miner: dest,
      bits: GENESIS_BITS_PACKED,
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

  it('hex-posted Flow send is in the next template and mined header with admit_proof', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-admit-job-'));
    const store = createStore(dir);
    const { dest, spendSeed, key } = identityDest();
    let now = 1_700_002_000_000;
    const parent = mine(buildTemplate({
      prev: GENESIS_PREV,
      height: 1,
      miner: dest,
      bits: GENESIS_BITS_PACKED,
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
      const { tpl } = store.template({ miner: dest, bits: GENESIS_BITS_PACKED, now });
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
      bits: GENESIS_BITS_PACKED,
      now: Number(parentH.timestamp) + 90_000,
    });
    const user = (tpl.txs || []).slice(1);
    assert.equal(user.length, 0);
    const tag = Buffer.from(honest.spendTag).toString('hex');
    assert.equal(store.fluxset().spendTags.has(tag), false);
  });

  it('named reject reasons: range stub, no members list, she1 silent_id', () => {
    const { dest, spendSeed, key } = identityDest();
    const parent = mine(buildTemplate({
      prev: GENESIS_PREV,
      height: 1,
      miner: dest,
      bits: GENESIS_BITS_PACKED,
      now: 1_700_003_000_000,
    }));
    const okP = verifyBlock(parent, null);
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
      bits: GENESIS_BITS_PACKED,
      now: 1_700_003_090_000,
      txs: [compactTx(body)],
      prevBlock: parent,
      parentBlocks: [parent],
      parentFluxset: live.pubs,
    });
    const stubBlock = mine(stubTpl);
    const gotStub = verifyBlock(stubBlock, parent, { evmHistory: [parent] });
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
      bits: GENESIS_BITS_PACKED,
      now: 1_700_003_180_000,
      txs: [she],
    });
    const sheBlock = mine(sheTpl);
    const gotShe = verifyBlock(sheBlock, null);
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
    const parent = mine(buildTemplate({
      prev: GENESIS_PREV,
      height: 1,
      miner: dest,
      bits: GENESIS_BITS_PACKED,
      now: 1_700_004_000_000,
    }));
    const okP = verifyBlock(parent, null);
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
      bits: GENESIS_BITS_PACKED,
      now: 1_700_004_090_000,
      txs: [plain],
      prevBlock: parent,
      parentBlocks: [parent],
    });
    const plainBlock = mine(plainTpl);
    const gotPlain = verifyBlock(plainBlock, parent, { evmHistory: [parent] });
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
      bits: GENESIS_BITS_PACKED,
      now: 1_700_004_090_000,
      txs: [openSealed],
      prevBlock: parent,
      parentBlocks: [parent],
    });
    const openBlock = mine(openTpl);
    const gotOpen = await Promise.resolve(verifyBlock(openBlock, parent, { evmHistory: [parent] }));
    assert.equal(gotOpen.ok, true, gotOpen.reason);

    const stub = lockTx({ from: dest, to: vault, nanos: PI_SHE_NANOS, id: 'lock-stub' });
    stub.vout[0].rangeProof = true;
    const stubTpl = buildTemplate({
      prev: parent.hash,
      prevHeader: parent.header,
      height: 2,
      miner: dest,
      bits: GENESIS_BITS_PACKED,
      now: 1_700_004_090_000,
      txs: [stub],
      prevBlock: parent,
      parentBlocks: [parent],
    });
    const stubBlock = mine(stubTpl);
    const gotStubLock = verifyBlock(stubBlock, parent, { evmHistory: [parent] });
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
