import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MAGIC_MAINNET, MAGIC_TESTNET } from '../../crypto/reserve_books.js';
import { MAGIC_REGTEST } from '../../crypto/regtest_bits.js';
import { rejectUnprovenTipExtend } from '../src/p2p.js';
import { createStore } from '../src/store.js';
import { createRegtestStore } from './regtest_store.js';

function scratch(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), tag));
}

describe('v12 tip-extend header gate', () => {
  it('the gate uses the book magic, mainnet included', () => {
    const mainnet = createStore(scratch('shear-gate-mainnet-'), { magic: MAGIC_MAINNET });
    assert.equal(mainnet.magic, MAGIC_MAINNET);
    assert.equal(mainnet.tipExtendPowOpts().magic, MAGIC_MAINNET);
    const testnet = createStore(scratch('shear-gate-testnet-'));
    assert.equal(testnet.tipExtendPowOpts().magic, MAGIC_TESTNET);
    const regtest = createRegtestStore(scratch('shear-gate-regtest-'), { bits: 4 });
    assert.equal(regtest.tipExtendPowOpts().magic, MAGIC_REGTEST);

    const src = fs.readFileSync(new URL('../src/p2p.js', import.meta.url), 'utf8');
    const at = src.indexOf('export async function rejectUnprovenTipExtend');
    assert.ok(at >= 0);
    const body = src.slice(at, src.indexOf('\n}\n', at));
    assert.doesNotMatch(body, /MAGIC_TESTNET/);
    assert.match(body, /store\.tipExtendPowReason\(block\)/);
    assert.match(body, /magic: store\.magic/);
  });

  it('rejectUnprovenTipExtend asks the store gate for a mainnet book', async () => {
    const tipHash = Buffer.alloc(32, 0x31);
    const header = Buffer.alloc(128);
    tipHash.copy(header, 4);
    const asked = [];
    const store = {
      magic: MAGIC_MAINNET,
      blocks: [{ hash: tipHash, header: Buffer.alloc(128, 1), height: 1 }],
      tip() { return this.blocks[0]; },
      tipExtendPowReason(block) {
        asked.push({ block, magic: this.magic });
        return Promise.resolve({ applies: true, reason: 'pow' });
      },
    };
    const got = await rejectUnprovenTipExtend(store, { header });
    assert.equal(got.reason, 'pow');
    assert.equal(asked.length, 1);
    assert.equal(asked[0].magic, MAGIC_MAINNET);
  });
});
