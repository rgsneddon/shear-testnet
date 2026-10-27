/**
 * An unproven append that store refuses hashes its header once.
 *
 * unprovenAppendReason runs assessHeader, which ShearHashes the header and
 * stashes the digest, then compares the claimed id with that digest. Before
 * this fix the compare hashed the header again (Protocol Abuse lane, PA7,
 * PR 130), so every refused claim cost two ShearHashes on the main thread.
 *
 * Cost is counted, not timed: the native addon's hash export is wrapped and
 * every call on the refused header is counted.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { encodeDest } from '../../crypto/address.js';
import { setNonce } from '../../crypto/header.js';
import { MAGIC_REGTEST, regtestBitsOverride } from '../../crypto/regtest_bits.js';
import { meetsTarget, shearHash } from '../../crypto/shear_hash.js';
import { createRegtestStore } from './regtest_store.js';

const T0 = 1_700_000_000_000;

/** The addon object crypto/shear_hash.js loaded; require returns the cached one. */
function nativeAddon() {
  try {
    return createRequire(import.meta.url)('../../crypto/native/shearhash.node');
  } catch {
    return null;
  }
}

const native = nativeAddon();

describe('unproven append hashes once', () => {
  it('a refused claim on a header that misses its target costs one ShearHash', async () => {
    assert.equal(typeof native?.hash, 'function', 'crypto/native/shearhash.node must be built');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-hash-once-'));
    try {
      const store = createRegtestStore(dir);
      const before = store.tip()?.height ?? -1;
      const dest = encodeDest(randomBytes(20));
      const { tpl } = store.template({ miner: dest, bits: regtestBitsOverride(MAGIC_REGTEST), shareBits: 4, now: T0 });
      // A real template header under a nonce whose ShearHash misses the
      // header's own target: assessHeader refuses it after hashing it.
      let header = null;
      for (let n = 1n; n < 4096n && !header; n += 1n) {
        const h = setNonce(Buffer.from(tpl.header), n);
        if (!meetsTarget(shearHash(h), tpl.bits)) header = h;
      }
      assert.ok(header, 'need a nonce that misses the regtest target');
      const real = native.hash;
      let calls = 0;
      native.hash = (buf) => {
        if (Buffer.from(buf).equals(header)) calls += 1;
        return real(buf);
      };
      let got;
      try {
        got = await Promise.resolve(store.append({
          header,
          hash: randomBytes(32),
          txs: tpl.txs,
          samples: tpl.samples,
          shareBatch: tpl.shareBatch || [],
          miner: dest,
          aLeaves: tpl.aLeaves,
          bLeaves: tpl.bLeaves,
          rootA: tpl.rootA,
          rootB: tpl.rootB,
          weight: tpl.weight,
        }));
      } finally {
        native.hash = real;
      }
      assert.equal(got.ok, false);
      assert.equal(got.reason, 'hash_claim');
      assert.equal(calls, 1, `ShearHash ran ${calls} times on the refused header`);
      assert.equal(store.tip()?.height ?? -1, before);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
