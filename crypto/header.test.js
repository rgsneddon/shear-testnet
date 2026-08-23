import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { HEADER_LEN, shearHash, meetsTarget } from './shear_hash.js';
import { encodeHeader, decodeHeader, setNonce, requiredJobFields } from './header.js';
import { merkleRoot, EMPTY_ROOT, sampleLeaf } from './merkle.js';
import { encodeAddress, isShearAddress, newIdentity } from './address.js';
import { nextBits, GENESIS_BITS, LIVE_MIN_BITS } from './asert.js';

const z32 = Buffer.alloc(32);

describe('header codec', () => {
  it('round-trips 120 bytes', () => {
    const raw = encodeHeader({
      prevBlockHash: z32,
      merkleRoot: EMPTY_ROOT,
      continuityRoot: EMPTY_ROOT,
      timestamp: 1_700_000_000_000n,
      bits: GENESIS_BITS,
      nonce: 99n,
    });
    assert.equal(raw.length, HEADER_LEN);
    const d = decodeHeader(raw);
    assert.equal(d.version, 1);
    assert.equal(d.bits, GENESIS_BITS);
    assert.equal(d.nonce, 99n);
    assert.ok(d.prevBlockHash.equals(z32));
  });

  it('hashes header and meets easy target', () => {
    const raw = encodeHeader({
      prevBlockHash: z32,
      merkleRoot: EMPTY_ROOT,
      continuityRoot: EMPTY_ROOT,
      timestamp: 1n,
      bits: 8,
      nonce: 1n,
    });
    const h = shearHash(raw);
    assert.equal(h.length, 32);
    assert.equal(meetsTarget(h, 0), true);
  });

  it('setNonce only touches the last 8 bytes', () => {
    const a = encodeHeader({
      prevBlockHash: z32,
      merkleRoot: EMPTY_ROOT,
      continuityRoot: EMPTY_ROOT,
      timestamp: 5n,
      bits: 14,
      nonce: 0n,
    });
    const b = setNonce(a, 7n);
    assert.deepEqual([...a.subarray(0, 112)], [...b.subarray(0, 112)]);
    assert.equal(decodeHeader(b).nonce, 7n);
  });
});

describe('job completeness', () => {
  it('rejects a job missing header fields', () => {
    const got = requiredJobFields({ jobId: '1', height: 1 });
    assert.equal(got.ok, false);
    assert.ok(got.missing.includes('header'));
    assert.ok(got.missing.includes('prevBlockHash'));
    assert.ok(got.missing.includes('merkleRoot'));
    assert.ok(got.missing.includes('continuityRoot'));
    assert.ok(got.missing.includes('bits'));
  });
});

describe('merkle + address + asert', () => {
  it('empty root is stable', () => {
    assert.equal(merkleRoot([]).toString('hex'), EMPTY_ROOT.toString('hex'));
    const leaf = sampleLeaf({ nonce: '1', tag: 'shear-aa' });
    assert.equal(merkleRoot([leaf]).length, 32);
  });

  it('makes shear1 addresses', () => {
    const id = newIdentity();
    assert.ok(isShearAddress(id.address));
    assert.match(id.address, /^shear1/);
    assert.equal(id.viewKey.length, 64);
    const again = encodeAddress(Buffer.alloc(20, 7));
    assert.ok(isShearAddress(again));
  });

  it('ASERT eases when blocks are slow', () => {
    const next = nextBits(LIVE_MIN_BITS, 180_000);
    assert.ok(next <= LIVE_MIN_BITS);
  });
});
