/**
 * A hash failure must not become an all-zero digest that meets every target.
 * Stubs the native addon. Does not score pool shares (pool.js is another lane).
 */
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GENESIS_BITS_PACKED, MAGIC_TESTNET } from '../../crypto/asert.js';
import { freshStealthDest, newIdentity } from '../../crypto/address.js';
import { encodeHeader } from '../../crypto/header.js';
import { shearHash, HEADER_LEN } from '../../crypto/shear_hash.js';
import {
  assessHeader,
  GENESIS_PREV,
  headerPowReason,
  holdPreparedHeader,
  discardPreparedHeader,
} from '../src/chain.js';
import { applyVerifiedIpcBlock } from '../src/p2p_ipc.js';
import { createStore } from '../src/store.js';

const require = createRequire(import.meta.url);
const native = require('../../crypto/native/shearhash.node');
const realHash = native.hash;

function powHeader(prev = GENESIS_PREV) {
  return encodeHeader({
    prevBlockHash: prev,
    merkleRoot: Buffer.alloc(32, 1),
    continuityRoot: Buffer.alloc(32, 2),
    timestamp: 1_700_000_000_000,
    bits: GENESIS_BITS_PACKED,
    nonce: 1n,
    baseFee: 1n,
  });
}

function stopBlock(header) {
  return { header, height: 1 };
}

afterEach(() => {
  native.hash = realHash;
});

describe('zero digest is not proof of work', () => {
  it('shearHash throws when the native hash returns zeros', () => {
    assert.equal(typeof realHash, 'function');
    const header = Buffer.alloc(HEADER_LEN, 3);
    native.hash = () => Buffer.alloc(32);
    assert.throws(() => shearHash(header), /shearhash_failed/);
  });

  it('shearHash throws when the native hash throws', () => {
    const header = Buffer.alloc(HEADER_LEN, 4);
    native.hash = () => {
      throw new Error('shearhash_failed');
    };
    assert.throws(() => shearHash(header), /shearhash_failed/);
  });

  it('assessHeader refuses proof of work when the native hash returns zeros', () => {
    native.hash = () => Buffer.alloc(32);
    assert.throws(
      () => assessHeader(stopBlock(powHeader()), null, {
        stopAfterPow: true,
        magic: MAGIC_TESTNET,
      }),
      /shearhash_failed/,
    );
  });

  it('assessHeader refuses a prepared or trusted all-zero digest', () => {
    const header = powHeader();
    const prepared = assessHeader(stopBlock(header), null, {
      preparedHash: Buffer.alloc(32),
      stopAfterPow: true,
      magic: MAGIC_TESTNET,
    });
    assert.equal(prepared.ok, false);
    assert.equal(prepared.reason, 'pow');
    const trusted = assessHeader(stopBlock(header), null, {
      trustedPowHash: Buffer.alloc(32),
      stopAfterPow: true,
      magic: MAGIC_TESTNET,
    });
    assert.equal(trusted.ok, false);
    assert.equal(trusted.reason, 'pow');
  });

  it('childMeetsTarget refuses a header whose hash comes back as zeros', () => {
    native.hash = () => Buffer.alloc(32);
    const header = powHeader(Buffer.alloc(32, 0x11));
    const store = {
      blocks: [],
      tip() {
        return { height: 5, hash: Buffer.alloc(32, 0x22) };
      },
    };
    const got = applyVerifiedIpcBlock(store, {
      type: 'ipc_block',
      magic: MAGIC_TESTNET,
      powHash: 'ab'.repeat(32),
      block: {
        header: header.toString('hex'),
        hash: 'cd'.repeat(32),
        height: 9,
        txs: [],
      },
    });
    assert.equal(got.ok, false);
    assert.equal(got.reason, 'pow');
  });

  it('the off-loop path refuses a prepared all-zero digest', async () => {
    const header = powHeader();
    assert.equal(holdPreparedHeader(header, Buffer.alloc(32)), true);
    try {
      const early = await headerPowReason(stopBlock(header), null, { magic: MAGIC_TESTNET });
      assert.equal(early.reason, 'pow');
      early.release?.();
    } finally {
      discardPreparedHeader(header);
    }
  });

  it('submitHeader(trusted) refuses an all-zero claim', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-zero-digest-'));
    try {
      const store = createStore(dir, { diskJournal: false, lock: false });
      const miner = freshStealthDest(newIdentity()).dest;
      const { job } = store.template({ miner });
      const got = store.submitHeader({
        jobId: job.jobId,
        nonce: 0n,
        miner,
        powHash: '00'.repeat(32),
      }, { trusted: true });
      assert.equal(got.ok, false);
      assert.equal(got.reason, 'pow');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
