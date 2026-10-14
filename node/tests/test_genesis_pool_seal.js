import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newIdentity, freshStealthDest, hash20FromAddress } from '../../crypto/address.js';
import { BLOCK_SUBSIDY_NANOS, HASH_BONUS_NANOS, PI_SHE_NANOS, SHARE_FLOOR_BITS } from '../../crypto/asert.js';
import { splitPot } from '../../pool/src/pool.js';
import { createStore } from '../src/store.js';
import {
  unitsForShare,
  dest20OfShare,
  nonceWithShareTarget,
  noteCommitOfShare,
  rememberLiveSharePow,
} from '../../crypto/share_batch.js';
import { noteCommitOfDest20, verifySealedNote } from '../../crypto/note.js';
import { custodyPotShares } from '../src/chain.js';
import { reconstructOwner } from '../../pool/src/wallet_api.js';
import { createPullBook } from '../../pool/src/pull_book.js';
import { publicMinerTag } from '../../pool/src/pool.js';
import { potCreditAfterFeeNanos } from '../../pool/src/auto_payout.js';

function destMiner() {
  return freshStealthDest(newIdentity()).dest;
}

describe('pool genesis seal: empty shareBatch, poolDest ≠ hasher', () => {
  it('store.submitHeader appends height 1 with full hash_bonus + pot verify', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-genesis-seal-'));
    const store = createStore(dir);
    const hasher = destMiner();
    const pool = destMiner();
    const finder = destMiner();
    assert.notEqual(hasher, pool);
    assert.notEqual(finder, hasher);
    const potShares = splitPot([{ miner: hasher, count: 1 }], pool, BLOCK_SUBSIDY_NANOS);
    assert.ok(potShares.length >= 1, 'splitPot');
    const { job } = store.template({
      miner: hasher,
      poolDest: pool,
      shareBatch: [],
      potShares,
    });
    const got = store.submitHeader({
      jobId: job.jobId,
      nonce: 0n,
      miner: finder,
      powHash: '00'.repeat(32),
    }, { trusted: true });
    assert.equal(got.ok, true, got.reason || JSON.stringify(got));
    const tip = store.tip();
    assert.equal(Number(tip.height), 1);
    const vout = tip.txs[0].vout || [];
    const hashV = vout.filter((o) => o.kind === 'hash');
    assert.equal(hashV.length, 0, 'empty shareBatch mints no hash notes');
    const potV = vout.filter((o) => o.kind !== 'hash' && o.kind !== 'finder-fee' && o.kind !== 'reserve-fee');
    assert.ok(potV.length >= 1, 'pot notes');
    const floor = unitsForShare();
    for (const o of hashV) {
      assert.equal(verifySealedNote(o, floor), true);
    }
  });

  it('next seal dest-binds lag-1 hash bonus and rejects a custodial pot', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-payout-legs-'));
    const store = createStore(dir);
    const hasher = destMiner();
    const pool = destMiner();
    const units = unitsForShare();
    const g = store.template({
      miner: hasher,
      poolDest: pool,
      shareBatch: [],
      potShares: custodyPotShares(pool, BLOCK_SUBSIDY_NANOS),
    });
    const gGot = store.submitHeader({
      jobId: g.job.jobId,
      nonce: 0n,
      miner: hasher,
      powHash: '00'.repeat(32),
    }, { trusted: true });
    assert.equal(gGot.ok, true, gGot.reason || JSON.stringify(gGot));
    const parent = store.tip();
    const share = {
      dest: hasher,
      dest20: dest20OfShare({ dest: hasher }),
      nonce: nonceWithShareTarget(1n, SHARE_FLOOR_BITS),
      lz: SHARE_FLOOR_BITS,
      shareBits: SHARE_FLOOR_BITS,
      proofSlot: 0,
      verifiedHeader: Buffer.from(parent.header).toString('hex'),
    };
    assert.equal(rememberLiveSharePow(parent.header, share.nonce, {
      noteCommit: noteCommitOfShare(share),
      shareBits: SHARE_FLOOR_BITS,
      lz: SHARE_FLOOR_BITS,
    }), true);
    const { job } = store.template({
      miner: hasher,
      poolDest: pool,
      shareBatch: [share],
      potShares: custodyPotShares(pool, BLOCK_SUBSIDY_NANOS),
    });
    const got = store.submitHeader({
      jobId: job.jobId,
      nonce: 0n,
      miner: hasher,
      powHash: '00'.repeat(32),
    }, { trusted: true });
    assert.equal(got.ok, false);
    assert.equal(got.reason, 'pot_prop');
    const honestShares = splitPot([{ miner: hasher, count: units }], pool, BLOCK_SUBSIDY_NANOS, pool);
    const honest = store.template({
      miner: hasher,
      poolDest: pool,
      shareBatch: [share],
      potShares: honestShares,
    });
    const paid = store.submitHeader({
      jobId: honest.job.jobId,
      nonce: 0n,
      miner: hasher,
      powHash: '00'.repeat(32),
    }, { trusted: true });
    assert.equal(paid.ok, true, String(paid?.reason || 'append'));
    const tip = store.tip();
    const vout = tip.txs[0].vout || [];
    const hashV = vout.filter((o) => o.kind === 'hash');
    const potV = vout.filter((o) => o.kind === 'pot' || o.kind === 'pool-fee');
    assert.equal(hashV.length, 1);
    assert.equal(verifySealedNote(hashV[0], units * HASH_BONUS_NANOS), true);
    assert.equal(
      Buffer.from(hashV[0].noteCommit).equals(noteCommitOfDest20(hash20FromAddress(hasher))),
      true,
    );
    const poolNc = noteCommitOfDest20(hash20FromAddress(pool));
    const hasherNc = noteCommitOfDest20(hash20FromAddress(hasher));
    const rest = potCreditAfterFeeNanos(BLOCK_SUBSIDY_NANOS);
    assert.ok(potV.some((o) => Buffer.from(o.noteCommit).equals(poolNc)));
    assert.equal(
      potV.some((o) => Buffer.from(o.noteCommit).equals(hasherNc)),
      true,
    );
    const hasherPot = potV.find((o) => Buffer.from(o.noteCommit).equals(hasherNc));
    assert.equal(verifySealedNote(hasherPot, rest), true);

    const sealedH = Number(tip.height);
    for (let h = sealedH + 1; h <= sealedH + 8; h += 1) {
      store.blocks.push({ height: h, txs: [] });
    }
    const hashRec = reconstructOwner(store, hasher);
    const poolRec = reconstructOwner(store, pool);
    assert.equal(hashRec.spendableNanos, rest + units * HASH_BONUS_NANOS);
    assert.ok(poolRec.spendableNanos >= rest);

    const book = createPullBook(path.join(dir, 'pull'));
    const tag = publicMinerTag(hasher);
    const potShare = potCreditAfterFeeNanos(BLOCK_SUBSIDY_NANOS);
    assert.equal(book.creditRound(
      [{ tag, dest: hasher, count: units }],
      { height: 1, nanos: potShare, hashByDest: new Map() },
    ).ok, true);
    assert.equal(book.dueAuto({ tipHeight: 40, need: 6 }).length, 0);
    assert.equal(book.creditRound(
      [{ tag, dest: hasher, count: units }],
      { height: 2, nanos: PI_SHE_NANOS, hashByDest: new Map() },
    ).ok, true);
    const due = book.dueAuto({ tipHeight: 40, need: 6 });
    assert.equal(due.length, 1);
    assert.equal(due[0].dest, hasher);
    assert.ok(due[0].nanos >= PI_SHE_NANOS);

    const src = fs.readFileSync(new URL('../../pool/src/pool.js', import.meta.url), 'utf8');
    assert.match(src, /potSharesFromBatch\(lag1Shares, feeTo, wantPot, carry\)/);
    assert.doesNotMatch(src, /custodyPotShares\(poolPay/);
    assert.match(src, /shareBatch: lag1Shares/);
    assert.match(src, /nanos: 0,/);
  });
});
