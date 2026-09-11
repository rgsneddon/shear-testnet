import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { newIdentity } from '../crypto/address.js';
import { destForLogin, destAtIndex, hasherPayoutDest } from '../crypto/flow_sheet.js';
import {
  BLOCK_SUBSIDY_NANOS,
  HASH_BONUS_NANOS,
  POOL_FEE_BPS,
  NANOS_PER_SHE,
  SHARE_FLOOR_BITS,
} from '../crypto/asert.js';
import { dest20OfShare, unitsForShare, collateShareUnits } from '../crypto/share_batch.js';
import { poolFeeDest } from '../crypto/levy.js';
import { coinbaseTx, hashBonusByMiner, buildTemplate, GENESIS_PREV } from '../node/src/chain.js';
import { mintShareMinBits, SHARE_BITS_V2_START } from '../pool/src/share_vardiff.js';

function bindable(id) {
  return destForLogin(id.address, { spendPub: id.spendPub });
}

function share(dest, nonce) {
  return { dest, dest20: dest20OfShare({ dest }), nonce: BigInt(nonce), lz: 8 };
}

describe('hash bonus is per hasher dest, 1u per proven floor unit', () => {
  it('two destCommit dests with one share each get two kind:hash vouts; she1 mints nothing; dest-index is not the pay dest', () => {
    const alice = newIdentity();
    const bob = newIdentity();
    const a = bindable(alice);
    const b = bindable(bob);
    const indexed = destAtIndex(alice.address, { index: 0, viewKey: alice.viewKey });
    assert.notEqual(a, b);
    assert.notEqual(a, indexed);
    assert.equal(hasherPayoutDest(alice.paymentCode), a);
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
    const potNanos = pots.reduce((n, o) => n + o.nanos, 0);
    assert.equal(potNanos, BLOCK_SUBSIDY_NANOS);
    assert.equal(BLOCK_SUBSIDY_NANOS, NANOS_PER_SHE);
    assert.equal(hashes.length, 2);
    const ha = hashes.find((o) => o.address === a);
    const hb = hashes.find((o) => o.address === b);
    assert.ok(ha, 'alice hash vout');
    assert.ok(hb, 'bob hash vout');
    assert.equal(ha.nanos, units * HASH_BONUS_NANOS);
    assert.equal(hb.nanos, units * HASH_BONUS_NANOS);
    assert.equal(hashes.some((o) => o.address === pool), false);
    assert.equal(hashes.some((o) => o.address === indexed), false);
    const fee = Math.floor(BLOCK_SUBSIDY_NANOS * POOL_FEE_BPS / 10000);
    assert.equal(pots.find((o) => o.address === pool)?.nanos, fee);

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
    assert.equal(tplHash.find((o) => o.address === a).nanos, units * HASH_BONUS_NANOS);
    assert.equal(tplHash.find((o) => o.address === b).nanos, units * HASH_BONUS_NANOS);
    assert.equal(hashBonusByMiner([{ miner: alice.paymentCode, count: 99 }], HASH_BONUS_NANOS, null).size, 0);
    assert.equal(mintShareMinBits(), SHARE_FLOOR_BITS);
    assert.ok(mintShareMinBits() >= SHARE_BITS_V2_START);
  });
});
