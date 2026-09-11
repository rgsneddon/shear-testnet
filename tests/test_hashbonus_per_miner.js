import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { newIdentity, freshStealthDest } from '../crypto/address.js';
import { destAtIndex, hasherPayoutDest } from '../crypto/flow_sheet.js';
import {
  BLOCK_SUBSIDY_NANOS,
  HASH_BONUS_NANOS,
  POOL_FEE_BPS,
  NANOS_PER_SHE,
  SHARE_FLOOR_BITS,
} from '../crypto/asert.js';
import { dest20OfShare, unitsForShare, collateShareUnits, noteCommitOfShare } from '../crypto/share_batch.js';
import { verifySealedNote, noteCommitOfDest20 } from '../crypto/note.js';
import { poolFeeDest } from '../crypto/levy.js';
import { coinbaseTx, hashBonusByMiner, buildTemplate, GENESIS_PREV } from '../node/src/chain.js';
import { mintShareMinBits, SHARE_BITS_V2_START } from '../pool/src/share_vardiff.js';
import { encodeHeader, setNonce } from '../crypto/header.js';
import { provenLag1Shares } from '../pool/src/pool.js';

function bindable(id) {
  return freshStealthDest(id.paymentCode).dest;
}

function share(dest, nonce) {
  return { dest, dest20: dest20OfShare({ dest }), nonce: BigInt(nonce), lz: 8 };
}

describe('hash bonus is per hasher dest, 1u per proven floor unit', () => {
  it('two one-time dests with one share each get two kind:hash vouts; she1 mints nothing; dest-index is not the pay dest', () => {
    const alice = newIdentity();
    const bob = newIdentity();
    const a = bindable(alice);
    const b = bindable(bob);
    const indexed = destAtIndex(alice.address, { index: 0, viewKey: alice.viewKey });
    assert.notEqual(a, b);
    assert.notEqual(a, indexed);
    assert.equal(hasherPayoutDest(alice.paymentCode), null);
    assert.equal(hasherPayoutDest(a), a);
    assert.equal(hasherPayoutDest(alice.paymentCode, { dest: a }), a);

    const batch = [share(a, 1), share(b, 2)];
    const units = unitsForShare();
    const by = collateShareUnits(batch);
    assert.equal(by.get(a), units);
    assert.equal(by.get(b), units);

    const pool = poolFeeDest();
    const bonuses = hashBonusByMiner([], HASH_BONUS_NANOS, batch);
    assert.equal(bonuses.get(a), units * HASH_BONUS_NANOS);
    assert.equal(bonuses.get(b), units * HASH_BONUS_NANOS);
    assert.equal(bonuses.has(pool), false);

    const cb = coinbaseTx({
      height: 2,
      miner: a,
      shareBatch: batch,
      poolDest: pool,
    });
    const pots = cb.vout.filter((o) => o.kind === 'pot');
    const hashes = cb.vout.filter((o) => o.kind === 'hash');
    const nca = noteCommitOfShare({ dest: a });
    const ncb = noteCommitOfShare({ dest: b });
    const ncp = noteCommitOfDest20(dest20OfShare({ dest: pool }));
    assert.equal(hashes.length, 2);
    const ha = hashes.find((o) => Buffer.from(o.noteCommit).equals(nca));
    const hb = hashes.find((o) => Buffer.from(o.noteCommit).equals(ncb));
    assert.ok(ha, 'alice hash note');
    assert.ok(hb, 'bob hash note');
    assert.equal(ha.nanos, undefined);
    assert.equal(hb.nanos, undefined);
    assert.equal(verifySealedNote(ha, units * HASH_BONUS_NANOS), true);
    assert.equal(verifySealedNote(hb, units * HASH_BONUS_NANOS), true);
    assert.equal(hashes.some((o) => Buffer.from(o.noteCommit).equals(ncp)), false);
    const nci = noteCommitOfDest20(dest20OfShare({ dest: indexed }));
    assert.equal(hashes.some((o) => Buffer.from(o.noteCommit).equals(nci)), false);
    const fee = Math.floor(BLOCK_SUBSIDY_NANOS * POOL_FEE_BPS / 10000);
    const rest = BLOCK_SUBSIDY_NANOS - fee;
    const poolPot = pots.find((o) => Buffer.from(o.noteCommit).equals(ncp));
    assert.equal(verifySealedNote(poolPot, fee), true);
    const hasherPot = pots.filter((o) => !Buffer.from(o.noteCommit).equals(ncp));
    assert.equal(hasherPot.length, 2);
    for (const o of hasherPot) {
      assert.equal(o.nanos, undefined);
      assert.equal(verifySealedNote(o, rest / 2), true);
    }

    const she1 = coinbaseTx({
      height: 2,
      miner: a,
      shareBatch: [],
      samples: [{ miner: alice.paymentCode, count: 99 }],
    });
    assert.equal(she1.vout.filter((o) => o.kind === 'hash').length, 0);

    const empty = coinbaseTx({ height: 2, miner: a, shareBatch: [], samples: [{ miner: a, count: 50 }] });
    assert.equal(empty.vout.filter((o) => o.kind === 'hash').length, 0);

    const tpl = buildTemplate({
      prev: GENESIS_PREV,
      height: 1,
      miner: a,
      bits: 4,
      now: 1_700_000_000_000,
      shareBatch: batch,
      poolDest: pool,
    });
    const tplHash = tpl.txs[0].vout.filter((o) => o.kind === 'hash');
    assert.equal(tplHash.length, 2);
    assert.equal(verifySealedNote(tplHash.find((o) => Buffer.from(o.noteCommit).equals(nca)), units * HASH_BONUS_NANOS), true);
    assert.equal(verifySealedNote(tplHash.find((o) => Buffer.from(o.noteCommit).equals(ncb)), units * HASH_BONUS_NANOS), true);
    assert.equal(hashBonusByMiner([{ miner: alice.paymentCode, count: 99 }], HASH_BONUS_NANOS, null).size, 0);
    assert.equal(mintShareMinBits(), SHARE_FLOOR_BITS);
    assert.ok(mintShareMinBits() >= SHARE_BITS_V2_START);
  });

  it('provenLag1Shares keeps every same-job hasher dest; a restamp row cannot collapse the batch to the finder', () => {
    const alice = newIdentity();
    const bob = newIdentity();
    const a = bindable(alice);
    const b = bindable(bob);
    const job = encodeHeader({
      prevBlockHash: Buffer.alloc(32, 1),
      merkleRoot: Buffer.alloc(32, 2),
      continuityRoot: Buffer.alloc(32, 3),
      timestamp: 1_700_000_000_000n,
      bits: 12,
      nonce: 0n,
      baseFee: 1n,
    });
    const sealed = setNonce(job, 99n);
    const restamp = encodeHeader({
      prevBlockHash: Buffer.alloc(32, 1),
      merkleRoot: Buffer.alloc(32, 2),
      continuityRoot: Buffer.alloc(32, 3),
      timestamp: 1_700_000_010_000n,
      bits: 12,
      nonce: 13n,
      baseFee: 1n,
    });
    const row = (dest, nonce, header) => ({
      dest,
      dest20: dest20OfShare({ dest }),
      nonce,
      lz: 8,
      verifiedHeader: Buffer.from(header).toString('hex'),
    });
    const kept = provenLag1Shares(sealed, [
      row(a, 11n, setNonce(job, 11n)),
      row(b, 12n, setNonce(job, 12n)),
      row(a, 99n, sealed),
      row(b, 13n, restamp),
    ]);
    assert.equal(kept.length, 3, JSON.stringify(kept.map((s) => [s.dest === a ? 'a' : 'b', String(s.nonce)])));
    assert.equal(kept.filter((s) => s.dest === a).length, 2);
    assert.equal(kept.filter((s) => s.dest === b).length, 1);
    assert.equal(kept.some((s) => String(s.nonce) === '13'), false);

    const cb = coinbaseTx({ height: 2, miner: a, shareBatch: kept, poolDest: poolFeeDest() });
    const hashes = cb.vout.filter((o) => o.kind === 'hash');
    const unit = unitsForShare();
    assert.equal(hashes.length, 2);
    const nca2 = noteCommitOfShare({ dest: a });
    const ncb2 = noteCommitOfShare({ dest: b });
    assert.equal(verifySealedNote(hashes.find((o) => Buffer.from(o.noteCommit).equals(nca2)), 2 * unit * HASH_BONUS_NANOS), true);
    assert.equal(verifySealedNote(hashes.find((o) => Buffer.from(o.noteCommit).equals(ncb2)), 1 * unit * HASH_BONUS_NANOS), true);
  });
});
