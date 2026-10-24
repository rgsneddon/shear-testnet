import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { printConfig } from '../src/node.js';
import { createRegtestStore } from './regtest_store.js';
import { closeMineWorkers, mineHeaderParallel } from './mine_worker.mjs';
import { JOIN_PROGRAM, JOIN_KIND_GENESIS, extraMintAllowed } from '../../crypto/asert.js';
import { encodeDest } from '../../crypto/address.js';
import { decodeHeader, encodeHeader } from '../../crypto/header.js';
import { merkleRoot } from '../../crypto/merkle.js';
import { sealHiddenNote, verifyRange } from '../../crypto/note.js';
import { MAGIC_REGTEST, regtestBitsOverride } from '../../crypto/regtest_bits.js';
import { digestTx, verifyBlock } from '../src/chain.js';

// Regtest work (bits 4, about 16 hashes). Every header carries a real nonce
// and its own ShearHash. The genesis seal is the regtest seed, so no
// testnet bits check is skipped and no hash is trusted.
const MAX_TRIES = 8_192;
const T0 = 1_700_000_000_000;
let genesisStamp = T0;

after(() => closeMineWorkers());

function destMiner() {
  return encodeDest(Buffer.alloc(20, 9));
}

function regtestStore(tag) {
  return createRegtestStore(fs.mkdtempSync(path.join(os.tmpdir(), tag)), { bits: 4 });
}

function honestTemplate(store, dest) {
  const parent = store.tip();
  const now = parent
    ? Number(decodeHeader(Buffer.from(parent.header)).timestamp) + 90_000
    : genesisStamp;
  if (!parent) genesisStamp += 7_000;
  const want = regtestBitsOverride(MAGIC_REGTEST);
  const { tpl } = store.template({ miner: dest, bits: want, shareBits: 4, now });
  assert.equal(tpl.bits, want, 'template must seal the regtest bits');
  assert.equal(decodeHeader(tpl.header).bits, want);
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

async function mineOne(store, dest) {
  const block = await sealBlock(honestTemplate(store, dest));
  return Promise.resolve(store.append(block));
}

function joinGenesis(vout) {
  // fee 0: the honest coinbase owes no levy, so the pot checks match an
  // empty block and the body gates are what judge the extra-mint.
  return {
    id: 'join-genesis-forbidden',
    programId: JOIN_PROGRAM,
    kind: JOIN_KIND_GENESIS,
    mint: true,
    fee: 0,
    vout,
  };
}

describe('node extra-mint snapshot path is gone', () => {
  it('printConfig does not advertise a claim window; extraMintAllowed is false', () => {
    const c = printConfig();
    assert.equal(c.joinRemoved, undefined);
    assert.equal(c.extraMintJoinGenesis, false);
    assert.equal(c.joinProgram, undefined);
    assert.equal(c.joinWindowDays, undefined);
    assert.equal(c.mainnet, false);
    assert.equal(extraMintAllowed(JOIN_PROGRAM, { kind: JOIN_KIND_GENESIS }), false);
  });

  it('verifyBlock and append refuse a mined join-genesis extra-mint', async () => {
    const dest = destMiner();
    const store = regtestStore('shear-join-gone-');
    assert.equal(store.joinVault, undefined);
    const tpl = honestTemplate(store, dest);
    // The honest block verifies, so the refusal below is the join tx alone.
    const honest = await sealBlock(tpl);
    const clean = await Promise.resolve(verifyBlock(honest, null, { magic: MAGIC_REGTEST }));
    assert.equal(clean.ok, true, clean.reason);
    // A plaintext extra-mint output has no range proof. v12 checks range
    // before the kind gate, so a non-v12 kind with an open amount is range_proof.
    const plain = await sealBlock(tpl, [...tpl.txs, joinGenesis([{ address: dest, nanos: 1, kind: JOIN_KIND_GENESIS }])]);
    const plainCheck = await Promise.resolve(verifyBlock(plain, null, { magic: MAGIC_REGTEST }));
    assert.equal(plainCheck.ok, false);
    assert.equal(plainCheck.reason, 'range_proof');
    const plainGot = await Promise.resolve(store.append(plain));
    assert.equal(plainGot.ok, false);
    assert.equal(plainGot.reason, 'range_proof');
    // A range-proven join-genesis output still mints nothing: join-genesis is
    // not a v12 value kind.
    const { r: _r, ...row } = sealHiddenNote(1, { dest20: Buffer.alloc(20, 9), kind: JOIN_KIND_GENESIS });
    assert.equal(verifyRange(row.commit, row.rangeProof), true);
    const proven = await sealBlock(tpl, [...tpl.txs, joinGenesis([row])]);
    const check = await Promise.resolve(verifyBlock(proven, null, { magic: MAGIC_REGTEST }));
    assert.equal(check.ok, false);
    assert.equal(check.reason, 'kind');
    const got = await Promise.resolve(store.append(proven));
    assert.equal(got.ok, false);
    assert.equal(got.reason, 'kind');
    assert.equal(store.tip(), null);
  });

  it('adopt of a valid fork rebuilds without throwing after snapshot vault removal', async () => {
    const dest = destMiner();
    const local = regtestStore('shear-join-reorg-a-');
    const peer = regtestStore('shear-join-reorg-b-');
    const mined = await mineOne(peer, dest);
    assert.equal(mined.ok, true, mined.reason);
    const got = await Promise.resolve(local.adopt(peer.blocks));
    assert.equal(got.ok, true, got.reason);
    assert.equal(got.reorg, true);
    assert.equal(local.tip().height, 1);
    assert.equal(
      Buffer.from(local.tip().hash).equals(Buffer.from(peer.tip().hash)),
      true,
    );
  });
});
