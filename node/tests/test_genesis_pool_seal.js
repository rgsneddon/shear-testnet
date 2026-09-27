import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newIdentity, freshStealthDest } from '../../crypto/address.js';
import { BLOCK_SUBSIDY_NANOS } from '../../crypto/asert.js';
import { splitPot } from '../../pool/src/pool.js';
import { createStore } from '../src/store.js';
import { unitsForShare } from '../../crypto/share_batch.js';
import { verifySealedNote } from '../../crypto/note.js';

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
});
