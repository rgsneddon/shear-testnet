import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRegtestStore } from './regtest_store.js';
import { setHashBackend } from '../../crypto/shear_hash.js';
import { consensusFingerprint, mainnetFingerprint, MAGIC_MAINNET } from '../../crypto/asert.js';
import {
  keptChain,
  pinnedCheckpoint,
  replayToCheckpoint,
  REGTEST_CHECKPOINT_HEIGHT,
  REGTEST_CHECKPOINT_NETWORK,
} from './support/regtest_checkpoint.js';

// Russell, 28 Oct (R01b): the regtest checkpoint is built from a real mined
// regtest chain, never hand-written, and pinned in the regtest config
// (node/tests/regtest_checkpoint.json, the chain in
// node/tests/fixtures/regtest_checkpoint_chain.json). The wallet takes it only
// under the regtest book (wallet/test/book_magic_test.dart); no release pack
// carries it (node/pack/test_regtest_checkpoint_pack.py).

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const sha256 = (b) => createHash('sha256').update(b).digest('hex');

try { setHashBackend('jit'); } catch { /* interpreter */ }

async function inStore(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-regtest-ckpt-'));
  try {
    return await fn(createRegtestStore(dir, { bits: 4 }));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('regtest checkpoint', () => {
  it('the pin is the tip of the kept mined chain, replayed by the node\'s own append', async () => {
    const pin = pinnedCheckpoint();
    assert.equal(pin.network, REGTEST_CHECKPOINT_NETWORK);
    assert.equal(pin.height, REGTEST_CHECKPOINT_HEIGHT);
    await inStore(async (store) => {
      assert.deepEqual(await replayToCheckpoint(store), pin);
      assert.equal(store.tip().height, pin.height);
      // Every header links: each block's prev is its parent's ShearHash.
      for (let h = 2; h <= store.tip().height; h += 1) {
        const prev = Buffer.from(store.blocks[h - 1].header).subarray(4, 36);
        assert.ok(prev.equals(Buffer.from(store.blocks[h - 2].hash)), `h=${h} links`);
      }
    });
  });

  it('a kept block whose header was bent is refused', async () => {
    const blocks = keptChain();
    const bent = Buffer.from(blocks[5].header);
    bent[40] ^= 1;
    blocks[5] = { ...blocks[5], header: bent };
    await inStore(async (store) => {
      await assert.rejects(() => replayToCheckpoint(store, { blocks }));
      assert.ok(store.tip().height < REGTEST_CHECKPOINT_HEIGHT, 'the replay stopped at the bent block');
    });
  });

  it('a pin the kept chain does not reach is refused', async () => {
    const pin = pinnedCheckpoint();
    const flip = pin.hashHex.endsWith('0') ? '1' : '0';
    const bent = { ...pin, hashHex: `${pin.hashHex.slice(0, 63)}${flip}` };
    await inStore(async (store) => {
      await assert.rejects(() => replayToCheckpoint(store, { pin: bent }), /regtest checkpoint mismatch/);
    });
  });

  it('the checkpoint is no input to the testnet or mainnet pins: they are unchanged', () => {
    // Values on feat/shear-testnet-v12 b3efdc26 (28 Oct). A pin move updates
    // them only with Russell's sign-off.
    assert.equal(sha256(consensusFingerprint()), 'cc9a56995d07165e5d0b4a959ff89063b3fc2b52a4d527903f2a779b2d647274');
    assert.equal(sha256(consensusFingerprint(MAGIC_MAINNET)), 'bebbf8518846efb0c208cec5df83a3534a0c7fdb364eb36d505e60414484d7a5');
    assert.equal(sha256(mainnetFingerprint()), 'ddb6fd35434da12de187caa139bc7ae5edef3c1e869c965db846c922112443a1');
    const reserve = fs.readFileSync(path.join(ROOT, 'contracts', 'Reserve.json'), 'utf8').replace(/\r\n/g, '\n');
    assert.equal(sha256(reserve), '33f0a68c26d42e4fc8924b4740e36cd7f0ece4ce88a241fe048c3c51aee1a8ab');
    assert.equal(sha256(String(JSON.parse(reserve).deployedBytecode)), '17adc0aace8ab4a07283ad70f7f090b338ac8fb62f7b44d71b64b9568a9dee6b');
    const pin = pinnedCheckpoint();
    for (const fp of [consensusFingerprint(), consensusFingerprint(MAGIC_MAINNET), mainnetFingerprint()]) {
      assert.ok(!fp.includes(pin.hashHex), 'no pin names the regtest checkpoint');
    }
  });
});
