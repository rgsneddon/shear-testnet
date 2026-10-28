// The live share-PoW cache binds a proven nonce to its one-time key P and its
// width: a cached nonce cannot be stolen (re-aimed at another key) or
// inflated (claimed wider) on any credit path, hot or cold, live or replayed.
// R28: shares are BluNotes frames; theft now fails at the nonce binding
// (share_bind) before the cache is read. The legacy per-payee selection and
// pro-rata pot this file also covered are retired by D1/D2 (the template
// seats bluTemplateBatch and the block pays by draw, see test_r28_*).
// Digests are stashed as the prepared RandomX output; real ShearHash coverage
// of the same rules is in test_r28_share_rules.js.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { encodeHeader, setNonce } from '../../crypto/header.js';
import { GENESIS_BITS_PACKED, SHARE_FLOOR_BITS } from '../../crypto/asert.js';
import { meetsTarget } from '../../crypto/shear_hash.js';
import {
  clearLiveSharePow,
  compareBluShares,
  dropSharePowKeys,
  rememberLiveSharePow,
  stashSharePow,
  unitsForShare,
  verifyShareBatch,
} from '../../crypto/share_batch.js';
import { bindNonce, oneTimeKey } from '../../crypto/blunote.js';
import { bluWallet } from './support/blunote_mine.js';

function rxExact(bits, seed) {
  const tag = Buffer.alloc(8);
  tag.writeUInt32LE(seed >>> 0, 0);
  for (let i = 0; i < 1 << 22; i += 1) {
    tag.writeUInt32LE(i, 4);
    const rx = createHash('sha256').update('shear-test-rx').update(tag).digest();
    if (meetsTarget(rx, bits) && !meetsTarget(rx, bits + 1)) return rx;
  }
  throw new Error('no digest');
}

function rxThatMisses(bits, seed) {
  const tag = Buffer.alloc(8);
  tag.writeUInt32LE(seed >>> 0, 0);
  for (let i = 0; i < 1 << 16; i += 1) {
    tag.writeUInt32LE(i, 4);
    const rx = createHash('sha256').update('shear-test-miss').update(tag).digest();
    if (!meetsTarget(rx, bits)) return rx;
  }
  throw new Error('no miss');
}

describe('v12 share cache binds the key and bits', () => {
  it('a cached nonce cannot be stolen or inflated on any credit path', () => {
    clearLiveSharePow();
    const widths = [SHARE_FLOOR_BITS, SHARE_FLOOR_BITS + 1, SHARE_FLOOR_BITS + 3];
    const parent = encodeHeader({
      prevBlockHash: Buffer.alloc(32),
      merkleRoot: Buffer.alloc(32),
      continuityRoot: Buffer.alloc(32),
      timestamp: 1_700_000_000_000,
      bits: GENESIS_BITS_PACKED,
    });
    const proven = widths.map((bits, i) => {
      const k = oneTimeKey(bluWallet());
      const share = {
        shareR: k.R,
        shareP: k.P,
        viewTag: k.tag,
        nonce: bindNonce(parent, k.R, k.P, i, bits),
        lz: bits,
        shareBits: bits,
        proofSlot: 0,
      };
      const rx = rxExact(bits, i + 1);
      assert.equal(rememberLiveSharePow(parent, share.nonce, { noteCommit: k.P, shareBits: bits, lz: bits }), true);
      return { bits, share, rx, header: setNonce(parent, share.nonce) };
    }).sort((a, b) => compareBluShares(a.share, b.share));
    // The cache refuses an entry with no key, and a second entry for a proven
    // nonce under another key or a wider claim.
    assert.equal(rememberLiveSharePow(parent, 99n, { lz: 0, shareBits: widths[0] }), false);
    const stranger = oneTimeKey(bluWallet());
    assert.equal(rememberLiveSharePow(parent, proven[0].share.nonce, { noteCommit: stranger.P, shareBits: proven[0].bits, lz: proven[0].bits }), false);
    assert.equal(rememberLiveSharePow(parent, proven[0].share.nonce, { noteCommit: proven[0].share.shareP, shareBits: 52, lz: 0 }), false);

    const honestRows = () => proven.map((row) => ({ ...row.share }));
    const expectUnits = proven.reduce((n, row) => n + unitsForShare(row.bits), 0);
    for (const skipPow of [false, true]) {
      if (!skipPow) for (const row of proven) stashSharePow(row.header, row.rx);
      const ok = verifyShareBatch({ parentHeader: parent, shares: honestRows(), skipPow });
      assert.equal(ok.ok, true, `${skipPow} ${ok.reason}`);
      assert.equal(ok.units, expectUnits);
      for (const row of proven) {
        // Stolen: the victim's nonce under the attacker's key never binds.
        for (const claim of [row.bits, row.bits + 1]) {
          const thief = oneTimeKey(bluWallet());
          const stolen = verifyShareBatch({
            parentHeader: parent,
            shares: [{ ...row.share, shareR: thief.R, shareP: thief.P, shareBits: claim, lz: claim }],
            skipPow,
          });
          assert.equal(stolen.ok, false, `steal ${row.bits} ${claim} skip=${skipPow}`);
          assert.equal(stolen.reason, claim === row.bits ? 'share_bind' : 'share_target');
        }
        // Inflated: a wider claim than the nonce byte.
        for (const claim of [row.bits + 1, 52]) {
          const inflated = verifyShareBatch({ parentHeader: parent, shares: [{ ...row.share, shareBits: claim }], skipPow });
          assert.equal(inflated.ok, false);
          assert.equal(inflated.reason, 'share_target');
        }
      }
    }
    const empty = verifyShareBatch({ parentHeader: parent, shares: [], skipPow: true });
    assert.equal(empty.ok, true);
    assert.equal(empty.units, 0);

    // Cold: no cache entry and no prepared digest is no credit, even with skipPow.
    // (The first pass answered from the cache, so its prepared digests are unused.)
    clearLiveSharePow();
    dropSharePowKeys(proven.map((row) => row.header.toString('hex')));
    const cold = verifyShareBatch({ parentHeader: parent, shares: honestRows(), skipPow: true });
    assert.equal(cold.ok, false);
    assert.equal(cold.reason, 'share_pow');
    for (const [i, row] of proven.entries()) {
      // A digest that misses the floor is no credit; the real one is.
      stashSharePow(row.header, rxThatMisses(SHARE_FLOOR_BITS, i + 9));
      const missed = verifyShareBatch({ parentHeader: parent, shares: [{ ...row.share }] });
      assert.equal(missed.ok, false);
      assert.equal(missed.reason, 'share_pow');
      stashSharePow(row.header, row.rx);
      const peer = verifyShareBatch({ parentHeader: parent, shares: [{ ...row.share }] });
      assert.equal(peer.ok, true, peer.reason);
      assert.equal(peer.units, unitsForShare(row.bits));
      // The disk/JSON form replays to the same credit, and a mutated width does not.
      const disk = JSON.parse(JSON.stringify({
        shareR: row.share.shareR.toString('hex'),
        shareP: row.share.shareP.toString('hex'),
        viewTag: row.share.viewTag,
        nonce: row.share.nonce.toString(),
        lz: row.bits,
        shareBits: row.bits,
        proofSlot: 0,
      }));
      stashSharePow(row.header, row.rx);
      const replay = verifyShareBatch({ parentHeader: parent, shares: [disk] });
      assert.equal(replay.ok, true, replay.reason);
      assert.equal(replay.units, unitsForShare(row.bits));
      stashSharePow(row.header, row.rx);
      const mutated = verifyShareBatch({ parentHeader: parent, shares: [{ ...disk, shareBits: row.bits + 1 }] });
      assert.equal(mutated.ok, false);
      assert.equal(mutated.reason, 'share_target');
      // Moved to another key with the real digest stashed: still unbound.
      const thief = oneTimeKey(bluWallet());
      stashSharePow(row.header, row.rx);
      const moved = verifyShareBatch({ parentHeader: parent, shares: [{ ...row.share, shareR: thief.R, shareP: thief.P }] });
      assert.equal(moved.ok, false);
      assert.equal(moved.reason, 'share_bind');
    }
    clearLiveSharePow();
  });
});
