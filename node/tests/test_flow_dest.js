import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newIdentity, isDestAddress, isShearAddress, encodeHrp, freshStealthDest, hash20FromAddress } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { EMPTY_ROOT } from '../../crypto/merkle.js';
import { buildTemplate, GENESIS_PREV, coinbaseTx, verifyBlock } from '../src/chain.js';
import { noteCommitOfDest20 } from '../../crypto/note.js';
import { decodeHeader } from '../../crypto/header.js';
import { MAGIC_REGTEST, regtestBitsOverride } from '../../crypto/regtest_bits.js';
import { createRegtestStore } from './regtest_store.js';
import { closeMineWorkers, mineHeaderParallel } from './mine_worker.mjs';

// A genesis header must carry the book's seed bits (chain.js genesis branch):
// GENESIS_BITS_PACKED on testnet, the sealed regtest seed on shear-regtest.
// The old raw `bits: 8` is neither, so verifyBlock said 'bits' before it ever
// read a vout. These blocks are mined for real at regtest bits 4 and verified
// under the regtest book. Nothing passes a trusted hash.
let RT_BITS = null;

async function mineGenesis(miner) {
  const tpl = buildTemplate({ prev: GENESIS_PREV, height: 1, miner, bits: RT_BITS, now: Date.now() });
  assert.equal(decodeHeader(Buffer.from(tpl.header)).bits, RT_BITS);
  const found = await mineHeaderParallel(tpl.header, tpl.bits, 8_192, 1);
  assert.ok(found && found.block, 'need pow');
  return { tpl, block: { header: found.header, txs: tpl.txs, samples: tpl.samples, height: 1 } };
}

function noteOf(dest) {
  return noteCommitOfDest20(hash20FromAddress(dest));
}

describe('flow dest coinbase', { timeout: 600_000 }, () => {
  const sealDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-flow-dest-seal-'));
  before(() => {
    createRegtestStore(sealDir, { bits: 4 });
    RT_BITS = regtestBitsOverride(MAGIC_REGTEST);
    assert.ok(RT_BITS != null, 'regtest bits sealed');
  });
  after(async () => {
    await closeMineWorkers();
    fs.rmSync(sealDir, { recursive: true, force: true });
  });

  it('pays miner login as dest; shear1 never on coinbase', () => {
    const id = newIdentity();
    const dest = freshStealthDest(id).dest;
    assert.equal(isDestAddress(dest), true);
    const tpl = buildTemplate({
      prev: GENESIS_PREV,
      height: 1,
      miner: dest,
      bits: 8,
      now: Date.now(),
    });
    assert.ok(tpl.txs[0].vout[0].commit);
    assert.equal(Buffer.from(tpl.txs[0].vout[0].noteCommit).equals(noteOf(dest)), true);
    const plain = coinbaseTx({ height: 1, miner: dest });
    assert.ok(plain.vout[0].commit);
    assert.equal(Buffer.from(plain.vout[0].noteCommit).equals(noteOf(dest)), true);
    assert.throws(() => coinbaseTx({ height: 1, miner: id.address }), /coinbase_needs_dest/);
    assert.throws(() => buildTemplate({
      prev: GENESIS_PREV,
      height: 1,
      miner: id.paymentCode,
      bits: 8,
      now: Date.now(),
    }), /coinbase_needs_dest/);
  });

  it('verifyBlock rejects rest-frame shear1 on vout', async () => {
    const id = newIdentity();
    const dest = freshStealthDest(id).dest;
    const { tpl, block } = await mineGenesis(dest);
    const ok = verifyBlock(block, null, { magic: MAGIC_REGTEST });
    assert.equal(ok.ok, true, ok.reason);
    const bad = {
      ...block,
      txs: [{
        ...tpl.txs[0],
        vout: tpl.txs[0].vout.map((o) => ({ ...o, address: id.address })),
      }],
    };
    const rej = verifyBlock(bad, null, { magic: MAGIC_REGTEST });
    assert.equal(rej.ok, false);
  });

  it('verifyBlock accepts ssa1 dest and still rejects shear1', async () => {
    const shp = encodeHrp('ssa', Buffer.alloc(20, 9));
    assert.equal(isDestAddress(shp), true);
    assert.equal(isShearAddress(shp), false);
    const { tpl, block } = await mineGenesis(shp);
    assert.ok(tpl.txs[0].vout[0].commit);
    assert.equal(Buffer.from(tpl.txs[0].vout[0].noteCommit).equals(noteOf(shp)), true);
    const ok = verifyBlock(block, null, { magic: MAGIC_REGTEST });
    assert.equal(ok.ok, true, ok.reason);
    const id = newIdentity();
    const bad = {
      ...block,
      txs: [{
        ...tpl.txs[0],
        vout: tpl.txs[0].vout.map((o) => ({ ...o, address: id.address })),
      }],
    };
    assert.equal(verifyBlock(bad, null, { magic: MAGIC_REGTEST }).ok, false);
  });
});
