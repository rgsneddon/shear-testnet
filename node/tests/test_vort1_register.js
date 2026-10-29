import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newIdentity, destOpeningFromView, freshStealthDest, ed25519SeedOf } from '../../crypto/address.js';
import { levyNanos, containsShe1 } from '../../crypto/levy.js';
import { gateVorticeRegister, vorticeRegisterTx } from '../../crypto/vortex.js';
import { signSpendTx, v12KindRejected, unsignedBodyField } from '../../crypto/spend.js';
import { SPENDABLE_CONFIRMATIONS } from '../../crypto/asert.js';
import { decodeHeader, encodeHeader } from '../../crypto/header.js';
import { merkleRoot } from '../../crypto/merkle.js';
import { MAGIC_REGTEST, regtestBitsOverride } from '../../crypto/regtest_bits.js';
import { digestTx, verifyBlock } from '../src/chain.js';
import { createRegtestStore } from './regtest_store.js';
import { closeMineWorkers, mineHeaderParallel } from './mine_worker.mjs';

// Regtest work (bits 4, about 16 hashes). Every header carries a real nonce
// and its own ShearHash, mined off the main thread by mine_worker.mjs, so the
// file's own timeout can fire. It used to mine height 1 at testnet genesis
// bits (2^17 ShearHash light hashes) in a synchronous mineTemplate loop.
const MAX_TRIES = 8_192;
const T0 = 1_700_000_000_000;

after(() => closeMineWorkers());

function regtestStore(tag) {
  return createRegtestStore(fs.mkdtempSync(path.join(os.tmpdir(), tag)), { bits: 4 });
}

function honestTemplate(store, dest) {
  const parent = store.tip();
  const now = parent
    ? Number(decodeHeader(Buffer.from(parent.header)).timestamp) + 90_000
    : T0;
  const want = regtestBitsOverride(MAGIC_REGTEST);
  const { tpl } = store.template({ miner: dest, bits: want, shareBits: 4, now });
  assert.equal(tpl.bits, want, 'template must seal the regtest bits');
  return tpl;
}

async function sealBlock(tpl, txs = tpl.txs) {
  const decoded = decodeHeader(Buffer.from(tpl.header));
  decoded.merkleRoot = merkleRoot(txs.map((tx) => digestTx(tx)));
  const found = await mineHeaderParallel(encodeHeader(decoded), tpl.bits, MAX_TRIES, 1);
  assert.ok(found && found.block, 'need pow');
  return {
    header: found.header,
    txs,
    samples: tpl.samples,
    shareBatch: tpl.shareBatch || [],
    miner: tpl.miner,
    aLeaves: tpl.aLeaves,
    bLeaves: tpl.bLeaves,
    rootA: tpl.rootA,
    rootB: tpl.rootB,
    weight: tpl.weight,
  };
}

function issuedIds(store) {
  return Object.keys(store.vortice.issued || {});
}

// v12 (c990b120) refuses vortice-register as a value kind: it is not in
// V12_VALUE_KINDS. Since e6c1034a its bytesHash, vort1 and ticker fields are
// not signed body fields, so the mempool names it unsigned. A block also
// fails a final check (its register output has no range proof), and a final
// fault is the verdict over an upgradeable one (Russell 26 Oct), so the block
// is range_proof: a peer never notes it as soft.
// The pure gate still judges ticker, mint and she1. No register is issued.
describe('vort1 register consensus tx', () => {
  it('bad ticker or mint-not-Reserve fails with no id; v12 refuses every register on chain and issues no id', async () => {
    const id = newIdentity();
    const box = (() => {
      const pay = freshStealthDest(id);
      return { dest: pay.dest, key: { type: 'ed25519-stealth', seed: ed25519SeedOf(id.privateKey), shared: pay.shared } };
    })();
    const dest = box.dest;
    const bytesHash = 'ab'.repeat(32);
    const L = levyNanos(0);
    const she = vorticeRegisterTx({
      from: dest, bytesHash, vort1: 'vort1.ok-dapp', ticker: 'SHE', fee: L,
    });
    assert.equal(gateVorticeRegister(she).ok, false);
    assert.equal(gateVorticeRegister(she).issued, false);
    assert.equal(gateVorticeRegister(she).reason, 'ticker');

    const wrap = vorticeRegisterTx({
      from: dest, bytesHash, vort1: 'vort1.wrap-dapp', ticker: 'wSHE', fee: L,
    });
    assert.equal(gateVorticeRegister(wrap).reason, 'ticker');

    const mint = vorticeRegisterTx({
      from: dest, bytesHash, vort1: 'vort1.printer', ticker: 'ABC', fee: L, mint: true,
    });
    mint.programId = 'vort1.printer';
    assert.equal(gateVorticeRegister(mint).reason, 'mint');

    const leak = vorticeRegisterTx({
      from: dest, bytesHash, vort1: 'vort1.ok-dapp', ticker: 'ABC', fee: L,
    });
    leak.she1 = id.paymentCode;
    assert.equal(gateVorticeRegister(leak).reason, 'she1');

    const okTx = vorticeRegisterTx({
      from: dest, bytesHash, vort1: 'vort1.ok-dapp', ticker: 'ABC', fee: L,
    });
    assert.equal(gateVorticeRegister(okTx).ok, true);
    assert.equal(containsShe1(okTx), false);
    assert.equal(v12KindRejected(okTx)?.reason, 'kind');
    assert.equal(unsignedBodyField(okTx)?.reason, 'unsigned');

    // Genesis on a fresh regtest book. The honest block verifies, so each
    // refusal below is the register tx alone.
    const genesis = regtestStore('shear-vort1a-');
    const tpl = honestTemplate(genesis, dest);
    const honest = await sealBlock(tpl);
    const clean = await Promise.resolve(verifyBlock(honest, null, { magic: MAGIC_REGTEST }));
    assert.equal(clean.ok, true, clean.reason);
    for (const tx of [she, okTx]) {
      const block = await sealBlock(tpl, [...tpl.txs, tx]);
      const check = await Promise.resolve(verifyBlock(block, null, { magic: MAGIC_REGTEST }));
      assert.equal(check.ok, false, tx.ticker);
      assert.equal(check.reason, 'range_proof', tx.ticker);
      const got = await Promise.resolve(genesis.append(block));
      assert.equal(got.ok, false, tx.ticker);
      assert.equal(got.reason, 'range_proof', tx.ticker);
      assert.equal(genesis.tip(), null);
    }
    assert.deepEqual(issuedIds(genesis), []);

    // A signed register from a dest whose coinbase has matured is refused too.
    const pay = dest;
    const fundedTx = vorticeRegisterTx({
      from: pay, bytesHash, vort1: 'vort1.ok-dapp', ticker: 'ABC', fee: L,
    });
    fundedTx.open = destOpeningFromView(id.viewKey, id.spendPub, 0);
    signSpendTx(fundedTx, box.key, { magic: 'shear-testnet-v12' });
    assert.equal(JSON.stringify(fundedTx).includes('she1'), false);
    const store2 = regtestStore('shear-vort1b-');
    for (let i = 0; i < SPENDABLE_CONFIRMATIONS + 1; i += 1) {
      const funded = await Promise.resolve(store2.append(await sealBlock(honestTemplate(store2, pay))));
      assert.equal(funded.ok, true, funded.reason);
    }
    const queued = await Promise.resolve(store2.queueTx(fundedTx));
    assert.equal(queued.ok, false);
    assert.equal(queued.reason, 'unsigned');
    const before = store2.tip().height;
    const tpl2 = honestTemplate(store2, pay);
    assert.equal(tpl2.txs.some((tx) => String(tx?.kind || '') === 'vortice-register'), false);
    const carried = await sealBlock(tpl2, [...tpl2.txs, fundedTx]);
    const appended = await Promise.resolve(store2.append(carried));
    assert.equal(appended.ok, false);
    // The mempool names it unsigned; the block also fails range_proof, the verdict.
    assert.equal(appended.reason, 'range_proof');
    assert.equal(store2.tip().height, before);
    assert.deepEqual(issuedIds(store2), []);
  });

  it('soak_vps mines genesis at packed GENESIS_BITS, not unpacked 4', () => {
    const src = fs.readFileSync(new URL('../soak_vps.js', import.meta.url), 'utf8');
    assert.match(src, /GENESIS_BITS_PACKED/);
    // 40c917b9 replaced the retired single-gap bitsForBlock with the
    // consensus aserti3-2d quote from the sealed chain.
    assert.match(src, /retarget\(store\.blocks, stamp\)/);
    assert.equal(/bitsForBlock/.test(src), false);
    assert.equal(/packBits\(4\)/.test(src), false);
    assert.equal(/shareBits: shareBitsOf(GENESIS_BITS_PACKED)/.test(src), false);
  });
});
