/**
 * A pool-withdraw block is refused on every book, at chain verify and at
 * store replay. shear-v1 and shear-regtest here; the live testnet book is
 * covered by node/tests/test_pull_withdraw.js. The transaction is signed by
 * its own input, so the refusal is the kind, not the signature.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newIdentity } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { GENESIS_BITS_PACKED, MAGIC_MAINNET, PI_SHE_NANOS } from '../../crypto/asert.js';
import { MAGIC_REGTEST, regtestBitsOverride } from '../../crypto/regtest_bits.js';
import { signSpendTx } from '../../crypto/spend.js';
import { meetsTarget } from '../../crypto/shear_hash.js';
import { buildTemplate, verifyBlock, verifyLoadedChain, GENESIS_PREV } from '../src/chain.js';
import { createRegtestStore } from './regtest_store.js';
import { spendBox } from '../../tests/spend_box.js';
import { handPoolWithdrawTx } from '../../tests/hand_pool_withdraw.js';

const NOW = 1_700_000_000_000;

function minerDest() {
  const id = newIdentity();
  return destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
}

function blockOf(tpl) {
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
    height: tpl.height,
  };
}

let powTag = 9_000;
/** A stored hash that meets the book's genesis bits: the replay trusts it and judges the body. */
function storedHash(bits) {
  const h = Buffer.alloc(32);
  h.writeUInt32LE(powTag, 4);
  powTag += 1;
  assert.equal(meetsTarget(h, bits), true, 'stored hash meets the bits');
  return h;
}

describe('a pool-withdraw block is refused on the mainnet and regtest books', () => {
  const sealDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-pull-books-'));
  let regtestBits = null;
  before(() => {
    createRegtestStore(sealDir, { bits: 4 });
    regtestBits = regtestBitsOverride(MAGIC_REGTEST);
    assert.ok(regtestBits != null, 'regtest bits sealed');
  });
  after(() => {
    fs.rmSync(sealDir, { recursive: true, force: true });
  });

  const books = [
    { name: 'shear-v1', magic: MAGIC_MAINNET, bits: () => GENESIS_BITS_PACKED },
    { name: 'shear-regtest', magic: MAGIC_REGTEST, bits: () => regtestBits },
  ];

  for (const book of books) {
    it(`${book.name}: chain verify and store replay both return custodial_pull`, () => {
      const poolBox = spendBox(newIdentity());
      const dest = minerDest();
      const tx = handPoolWithdrawTx({ from: poolBox.dest, to: dest, nanos: PI_SHE_NANOS, fee: 100, id: `pull-${book.name}` });
      signSpendTx(tx, poolBox.key);
      const bits = book.bits();
      const tpl = buildTemplate({
        prev: GENESIS_PREV,
        height: 1,
        miner: dest,
        bits,
        now: NOW,
        txs: [tx],
      });
      const block = blockOf(tpl);
      assert.equal(block.txs.some((row) => row && row.id === tx.id), true, 'the template carried the withdraw');

      const verified = verifyBlock(block, null, { probeBody: true, magic: book.magic });
      assert.equal(verified.ok, false, book.name);
      assert.equal(verified.reason, 'custodial_pull', `${book.name} verify: ${verified.reason}`);

      const replayed = verifyLoadedChain([{ ...block, hash: storedHash(bits) }], {
        trustStoredHash: true,
        nowMs: NOW + 1,
        magic: book.magic,
      });
      assert.equal(replayed.ok, false, book.name);
      assert.equal(replayed.reason, 'custodial_pull', `${book.name} replay: ${replayed.reason}`);
    });
  }
});
