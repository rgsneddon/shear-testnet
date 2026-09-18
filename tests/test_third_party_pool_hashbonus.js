import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { newIdentity, freshStealthDest } from '../crypto/address.js';
import { hasherPayoutDest } from '../crypto/flow_sheet.js';
import { extraMintAllowed } from '../crypto/asert.js';
import { extraMint } from '../crypto/mint.js';
import { noteCommitOfDest20 } from '../crypto/note.js';
import { dest20OfShare, destBoundShareHash, SHARE_DEST_DST } from '../crypto/share_batch.js';
import { hash20FromAddress } from '../crypto/address.js';
import { shearHash, meetsTarget } from '../crypto/shear_hash.js';
import { setNonce } from '../crypto/header.js';
import { judgeShare } from '../pool/src/pool.js';
import { SHARE_FLOOR_BITS } from '../crypto/asert.js';

describe('third-party pool cannot cheat hash bonus', () => {
  it('cannot extra-mint SHE; dest-bound share hash changes when dest is restamped', () => {
    assert.equal(extraMintAllowed('third-party-vortice'), false);
    assert.equal(extraMintAllowed('shear-pool-v9'), false);
    const alice = newIdentity();
    const no = extraMint({ programId: 'third-party-pool', to: alice.address, nanos: 10 });
    assert.equal(no.ok, false);
    assert.equal(no.reason, 'mint_forbidden');

    const a = freshStealthDest(alice).dest;
    const b = freshStealthDest(newIdentity()).dest;
    assert.notEqual(a, b);
    const rx = createHash('sha256').update('rx-fixture').digest();
    const nca = noteCommitOfDest20(dest20OfShare({ dest: a }));
    const ncb = noteCommitOfDest20(dest20OfShare({ dest: b }));
    const ha = destBoundShareHash(rx, nca);
    const hb = destBoundShareHash(rx, ncb);
    assert.equal(ha.length, 32);
    assert.equal(ha.equals(hb), false);
    const manual = createHash('sha256').update(SHARE_DEST_DST).update(rx).update(nca).digest();
    assert.equal(ha.equals(manual), true);
    assert.equal(hasherPayoutDest(alice.paymentCode), null);
    assert.equal(hasherPayoutDest(a), a);
  });

  it('95-char Copy dest dest20 matches pool; dest-bound accepts; RandomX-floor is low_diff', () => {
    const longDest = 'ssa1qsj3qt0mcuznqv6r5370d58tw32gz3yhjychuu0sljyw5zmw9pmwc47d9vnwagjafs3ywjz7udh7suc7e3qsshw25ze';
    const d20 = hash20FromAddress(longDest);
    assert.equal(d20.length, 20);
    assert.equal(d20.toString('hex'), '84a205bf78e0a60668748f9eda1d6e8a902892f2');
    assert.equal(hasherPayoutDest(`${longDest}.P7`), longDest);
    const header = Buffer.alloc(128, 0);
    header[0] = 1;
    let rxFloor = null;
    for (let n = 1; n < 200_000; n += 1) {
      const h = setNonce(header, n);
      const rx = shearHash(h);
      if (!meetsTarget(rx, SHARE_FLOOR_BITS)) continue;
      const bound = destBoundShareHash(rx, noteCommitOfDest20(d20));
      if (meetsTarget(bound, SHARE_FLOOR_BITS)) continue;
      rxFloor = { header: h, hash: rx, nonce: n };
      break;
    }
    assert.ok(rxFloor, 'need an rx-floor nonce that misses dest-bound floor');
    const job = { shareBits: SHARE_FLOOR_BITS, blockBits: 16, bits: 16 };
    const miss = judgeShare({ job, header: rxFloor.header, hash: rxFloor.hash, dest: longDest });
    assert.equal(miss.ok, false, 'RandomX-floor must not credit dest-bound shares');
    assert.equal(miss.reason, 'low_diff');
    let destHit = null;
    for (let n = 1; n < 400_000; n += 1) {
      const h = setNonce(header, n);
      const rx = shearHash(h);
      const bound = destBoundShareHash(rx, noteCommitOfDest20(d20));
      if (!meetsTarget(bound, SHARE_FLOOR_BITS)) continue;
      destHit = { header: h, hash: rx };
      break;
    }
    assert.ok(destHit, 'need a dest-bound floor nonce');
    const hit = judgeShare({ job, header: destHit.header, hash: destHit.hash, dest: longDest });
    assert.equal(hit.ok, true, hit.reason);
  });

  it('RandomX block that misses dest-bound shareBits is a block, not low_diff', () => {
    const longDest = 'ssa1qsj3qt0mcuznqv6r5370d58tw32gz3yhjychuu0sljyw5zmw9pmwc47d9vnwagjafs3ywjz7udh7suc7e3qsshw25ze';
    const d20 = hash20FromAddress(longDest);
    const header = Buffer.alloc(128, 0);
    header[0] = 1;
    const bits = SHARE_FLOOR_BITS;
    let rxBlock = null;
    for (let n = 1; n < 200_000; n += 1) {
      const h = setNonce(header, n);
      const rx = shearHash(h);
      if (!meetsTarget(rx, bits)) continue;
      const bound = destBoundShareHash(rx, noteCommitOfDest20(d20));
      if (meetsTarget(bound, bits)) continue;
      rxBlock = { header: h, hash: rx };
      break;
    }
    assert.ok(rxBlock, 'need an rx block that misses dest-bound shareBits');
    const job = { shareBits: bits, blockBits: bits, bits };
    const got = judgeShare({ job, header: rxBlock.header, hash: rxBlock.hash, dest: longDest });
    assert.equal(got.ok, true, got.reason);
    assert.equal(got.block, true);
    assert.equal(got.creditedShareBits, 0);
    const shareOnly = judgeShare({
      job: { shareBits: bits, blockBits: 24, bits: 24 },
      header: rxBlock.header,
      hash: rxBlock.hash,
      dest: longDest,
    });
    assert.equal(shareOnly.ok, false);
    assert.equal(shareOnly.reason, 'low_diff');
  });

  it('credits dest-bound against recent shareBitsPrev after a vardiff climb', () => {
    const longDest = 'ssa1qsj3qt0mcuznqv6r5370d58tw32gz3yhjychuu0sljyw5zmw9pmwc47d9vnwagjafs3ywjz7udh7suc7e3qsshw25ze';
    const d20 = hash20FromAddress(longDest);
    const header = Buffer.alloc(128, 0);
    header[0] = 1;
    let destHit = null;
    for (let n = 1; n < 200_000; n += 1) {
      const h = setNonce(header, n);
      const rx = shearHash(h);
      const bound = destBoundShareHash(rx, noteCommitOfDest20(d20));
      if (!meetsTarget(bound, SHARE_FLOOR_BITS)) continue;
      if (meetsTarget(bound, 16)) continue;
      destHit = { header: h, hash: rx };
      break;
    }
    assert.ok(destHit, 'need dest-bound floor that misses 16');
    const live = judgeShare({
      job: {
        shareBits: 16,
        shareBitsPrev: SHARE_FLOOR_BITS,
        shareBitsAt: Date.now(),
        blockBits: 24,
        bits: 24,
      },
      header: destHit.header,
      hash: destHit.hash,
      dest: longDest,
    });
    assert.equal(live.ok, true, live.reason);
    assert.equal(live.creditedShareBits, SHARE_FLOOR_BITS);
    const stale = judgeShare({
      job: {
        shareBits: 16,
        shareBitsPrev: SHARE_FLOOR_BITS,
        shareBitsAt: Date.now() - 20_000,
        blockBits: 24,
        bits: 24,
      },
      header: destHit.header,
      hash: destHit.hash,
      dest: longDest,
    });
    assert.equal(stale.ok, false);
    assert.equal(stale.reason, 'low_diff');
  });
});
