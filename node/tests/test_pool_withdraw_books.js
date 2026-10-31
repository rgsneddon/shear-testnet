/**
 * A pool-withdraw block is refused on every book, at chain verify and at
 * store replay. shear-v1 and shear-regtest here; the live testnet book is
 * covered by node/tests/test_pull_withdraw.js. The transaction is signed by
 * its own input, so the refusal is the kind, not the signature.
 *
 * Verify checks the coinbase pot before the per-transaction gate, and the pot
 * check opens the coinbase rows through the range verifier. So the gate is
 * also tested directly, and each block leg first shows a block on the same
 * book with no withdraw clears the coinbase checks (a sanity probe of the pot
 * path; its coinbase has no withdraw fee). Only the gate emits custodial_pull,
 * so that verdict on the withdraw block is the gate's.
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
import { custodialPullRejected } from '../../crypto/levy.js';
import { nativeLoaded } from '../../crypto/native_admit.js';
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

  function signedWithdraw(dest, id) {
    const poolBox = spendBox(newIdentity());
    const tx = handPoolWithdrawTx({ from: poolBox.dest, to: dest, nanos: PI_SHE_NANOS, fee: 100, id });
    signSpendTx(tx, poolBox.key);
    return tx;
  }

  it('the gate itself refuses a pool-withdraw, by its kind or its first output, with custodial_pull', () => {
    const tx = signedWithdraw(minerDest(), 'pull-gate');
    assert.deepEqual(custodialPullRejected(tx), { ok: false, reason: 'custodial_pull' });
    const byOutput = { ...tx, kind: 'send' };
    assert.deepEqual(custodialPullRejected(byOutput), { ok: false, reason: 'custodial_pull' });
    assert.equal(custodialPullRejected({ ...tx, kind: 'send', vout: [{ ...tx.vout[0], kind: 'send' }] }), null);
  });

  for (const book of books) {
    it(`${book.name}: chain verify and store replay both return custodial_pull`, () => {
      assert.equal(nativeLoaded(), true, 'the coinbase pot check needs shearadmit.node to open the coinbase rows');
      const dest = minerDest();
      const tx = signedWithdraw(dest, `pull-${book.name}`);
      const bits = book.bits();
      const template = (txs) => buildTemplate({ prev: GENESIS_PREV, height: 1, miner: dest, bits, now: NOW, txs });

      // A block on this book with no withdraw clears the coinbase and pot checks.
      const control = verifyBlock(blockOf(template([])), null, { probeBody: true, magic: book.magic });
      assert.equal(control.ok, true, `${book.name} control: ${control.reason}`);

      const block = blockOf(template([tx]));
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
