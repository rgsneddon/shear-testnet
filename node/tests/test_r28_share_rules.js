// R28 BluNotes share rules one by one, each with a passing control: the
// canonical order (R33), the digest's own lz, a repeated work key, a kin
// header nobody issued, a payee-commit frame among BluNotes frames, and a
// claimed width the nonce does not carry. Shares are real ShearHash-v3.
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { setHashBackend } from '../../crypto/shear_hash.js';
import { decodeHeader } from '../../crypto/header.js';
import { compareBluShares, verifyShareBatch } from '../../crypto/share_batch.js';
import { bluWallet, mineBluShare } from './support/blunote_mine.js';

try { setHashBackend('jit'); } catch { /* interpreter */ }

describe('R28 BluNotes share rules', () => {
  const header = randomBytes(128);
  // A sane header: the version and bits fields do not matter to share PoW.
  header.writeUInt32LE(1, 0);
  let a;
  let b;
  before(() => {
    const w = bluWallet();
    const two = [mineBluShare(w, header), mineBluShare(w, header)].sort(compareBluShares);
    [a, b] = two;
  });

  it('accepts canonical order and refuses any other (R33)', () => {
    const ok = verifyShareBatch({ parentHeader: header, shares: [a, b] });
    assert.equal(ok.ok, true, ok.reason);
    assert.equal(ok.shares.length, 2);
    const swapped = verifyShareBatch({ parentHeader: header, shares: [b, a] });
    assert.equal(swapped.ok, false);
    assert.equal(swapped.reason, 'share_order');
  });

  it('refuses a frame whose lz is not its digest\'s', () => {
    const lied = verifyShareBatch({ parentHeader: header, shares: [{ ...a, lz: (a.lz + 1) & 0xff }] });
    assert.equal(lied.ok, false);
    assert.equal(lied.reason, 'share_lz');
  });

  it('refuses the same work twice in one block', () => {
    const twice = verifyShareBatch({ parentHeader: header, shares: [a, { ...a }] });
    assert.equal(twice.ok, false);
    // Equal frames are also out of canonical order (not strictly increasing).
    assert.ok(['dup_share', 'share_order'].includes(twice.reason), twice.reason);
  });

  it('refuses work already paid in the parent', () => {
    const paid = verifyShareBatch({ parentHeader: header, shares: [a] });
    assert.equal(paid.ok, true, paid.reason);
    const again = verifyShareBatch({ parentHeader: header, shares: [a], excludeNonces: new Set([paid.shares[0].workKey]) });
    assert.equal(again.ok, false);
    assert.equal(again.reason, 'paid_share');
  });

  it('refuses a kin header nobody issued, and seats it once issued', () => {
    const kinHeader = Buffer.from(header);
    kinHeader.writeBigUInt64LE(decodeHeader(kinHeader).timestamp + 1n, 100);
    const k = mineBluShare(bluWallet(), kinHeader, { kin: true });
    const unissued = verifyShareBatch({ parentHeader: header, shares: [k] });
    assert.equal(unissued.ok, false);
    assert.equal(unissued.reason, 'share_slot');
    const issued = verifyShareBatch({ parentHeader: header, shares: [k], issuedJobKeys: [kinHeader] });
    assert.equal(issued.ok, true, issued.reason);
  });

  it('refuses a payee-commit frame among BluNotes frames', () => {
    const mixed = verifyShareBatch({ parentHeader: header, shares: [a, { noteCommit: randomBytes(32), nonce: 1n, lz: 8, shareBits: 8, proofSlot: 0 }] });
    assert.equal(mixed.ok, false);
    assert.equal(mixed.reason, 'share_frame');
  });

  it('refuses a claimed width the nonce does not carry', () => {
    const wide = verifyShareBatch({ parentHeader: header, shares: [{ ...a, shareBits: a.shareBits + 1 }] });
    assert.equal(wide.ok, false);
    assert.equal(wide.reason, 'share_target');
  });
});
