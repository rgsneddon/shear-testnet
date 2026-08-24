import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { HEADER_LEN } from '../../crypto/shear_hash.js';
import { encodeHeader } from '../../crypto/header.js';
import { EMPTY_ROOT } from '../../crypto/merkle.js';
import { BLOCK_SUBSIDY_NANOS, HASH_BONUS_NANOS, RESERVE_PROGRAM } from '../../crypto/asert.js';
import { newIdentity } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { extraMintAllowed, extraMint, coinbaseSplit, coinbaseTx } from '../../crypto/mint.js';

describe('header size', () => {
  it('packs 120 bytes', () => {
    const raw = encodeHeader({
      prevBlockHash: Buffer.alloc(32),
      merkleRoot: EMPTY_ROOT,
      continuityRoot: EMPTY_ROOT,
      timestamp: 1n,
      bits: 8,
      nonce: 0n,
    });
    assert.equal(raw.length, HEADER_LEN);
    assert.equal(HEADER_LEN, 120);
  });
});

describe('coinbase: 1 SHE pot + per-hasher nanos', () => {
  it('pays each hasher, not only the finder', () => {
    const alice = newIdentity();
    const bob = newIdentity();
    const destA = destForLogin(alice.address, { viewKey: alice.viewKey, height: 3 });
    const destB = destForLogin(bob.address, { viewKey: bob.viewKey, height: 3 });
    const samples = [
      { miner: destA, nonce: '1', tag: 'shear-a', count: 4000 },
      { miner: destB, nonce: '2', tag: 'shear-b', count: 1000 },
    ];
    const cb = coinbaseTx({ height: 3, miner: destA, samples });
    const split = coinbaseSplit(cb);
    assert.equal(split.potNanos, BLOCK_SUBSIDY_NANOS);
    assert.equal(split.potNanos, 100_000_000_000);
    assert.equal(split.hashByMiner[destA], 4000 * HASH_BONUS_NANOS);
    assert.equal(split.hashByMiner[destB], 1000 * HASH_BONUS_NANOS);
    assert.equal(split.hashNanos, 5000 * HASH_BONUS_NANOS);
    assert.equal(HASH_BONUS_NANOS, 1);
    assert.notEqual(alice.address, bob.address);
  });
});

describe('extra mint allowlist', () => {
  it('accepts The Reserve and rejects any other program', () => {
    const id = newIdentity();
    assert.equal(extraMintAllowed(RESERVE_PROGRAM), true);
    assert.equal(extraMintAllowed('shear-vault-v1'), false);
    assert.equal(extraMintAllowed(''), false);
    const ok = extraMint({ programId: RESERVE_PROGRAM, to: id.address, nanos: 10 });
    assert.equal(ok.ok, true);
    assert.equal(ok.kind, 'reserve');
    const no = extraMint({ programId: 'third-party-stake', to: id.address, nanos: 10 });
    assert.equal(no.ok, false);
    assert.equal(no.reason, 'mint_forbidden');
  });
});
