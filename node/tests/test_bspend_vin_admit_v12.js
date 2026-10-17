/**
 * A sealed b-spend vin admits an integer index in 0..2^32-1, a 32-byte prev,
 * and a 32-byte noteCommit. Index 0 stays 0. A short link, a non-integer
 * index, and dest20 beside noteCommit are vin_link and are not coerced.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bSpendVinRejected, compactTx } from '../../crypto/chronoflux.js';
import { chainBSpendsRejected } from '../../crypto/clearing.js';
import { admitMempool, emptyMempool } from '../../crypto/mempool.js';
import { createStore } from '../src/store.js';
import { payerIdentity } from './b_leaf_fund.js';

const INDEX_MAX = 0xffffffff;

describe('b-spend vin admission', () => {
  it('keeps a canonical index, including 0, and refuses the rest', () => {
    const who = payerIdentity();
    const tx = {
      kind: 'b-spend',
      vin: [
        { address: who.dest, index: 1, prev: Buffer.alloc(32, 2) },
        { address: who.dest, index: 0 },
        { address: who.dest, index: INDEX_MAX },
        { noteCommit: Buffer.alloc(32, 9), index: 0n },
      ],
    };
    assert.equal(bSpendVinRejected(tx), null);
    const sealed = compactTx(tx);
    const again = compactTx(sealed);
    assert.equal(sealed.vin[0].index, 1);
    assert.equal(sealed.vin[1].index, 0);
    assert.equal(sealed.vin[2].index, INDEX_MAX);
    assert.equal(sealed.vin[3].index, 0);
    assert.equal(sealed.vin[3].dest20, undefined);
    assert.equal(Buffer.from(sealed.vin[3].noteCommit).length, 32);
    assert.equal(Buffer.from(sealed.vin[0].prev).length, 32);
    assert.equal(again.vin[1].index, 0);
    assert.equal(bSpendVinRejected(sealed), null);

    const badIndex = [-1, 1.5, 2 ** 32, true, '0', 1n << 32n];
    for (const index of badIndex) {
      const raw = { kind: 'b-spend', vin: [{ index, address: who.dest }] };
      assert.equal(bSpendVinRejected(raw)?.reason, 'vin_link', String(index));
      const row = compactTx(raw).vin[0];
      assert.equal(row.index, index, String(index));
      assert.equal(bSpendVinRejected(compactTx(raw))?.reason, 'vin_link', String(index));
    }

    const shortPrev = { kind: 'b-spend', vin: [{ prev: Buffer.alloc(31, 7) }] };
    assert.equal(bSpendVinRejected(shortPrev)?.reason, 'vin_link');
    assert.equal(compactTx(shortPrev).vin[0].prev.length, 31);

    const shortNote = { kind: 'b-spend', vin: [{ noteCommit: Buffer.alloc(16, 3) }] };
    assert.equal(bSpendVinRejected(shortNote)?.reason, 'vin_link');
    assert.equal(Buffer.from(compactTx(shortNote).vin[0].noteCommit).length, 16);

    const both = {
      kind: 'b-spend',
      vin: [{ noteCommit: Buffer.alloc(32, 4), dest20: Buffer.alloc(20, 5) }],
    };
    assert.equal(bSpendVinRejected(both)?.reason, 'vin_link');
    const kept = compactTx(both).vin[0];
    assert.equal(Buffer.from(kept.noteCommit).length, 32);
    assert.equal(Buffer.from(kept.dest20).length, 20);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-bspend-vin-'));
    try {
      const store = createStore(dir);
      const queued = store.queueTx({
        id: 'bad-idx',
        kind: 'b-spend',
        vin: [{ index: -1, address: who.dest }],
        vout: [],
      });
      assert.equal(queued.reason, 'vin_link');
      const parked = admitMempool(emptyMempool(), {
        id: 'bad-idx-pool',
        kind: 'b-spend',
        vin: [{ index: 1.5 }],
        vout: [],
      });
      assert.equal(parked.reason, 'vin_link', parked.reason);
      // Snap and suffix load skip verifyBlock and run this predicate.
      assert.equal(chainBSpendsRejected([{
        height: 1,
        header: Buffer.alloc(80),
        txs: [{ kind: 'b-spend', fee: 0, vin: [{ index: 1.5 }] }],
      }])?.reason, 'vin_link');
      assert.equal(chainBSpendsRejected([{
        height: 1,
        header: Buffer.alloc(80),
        txs: [{ kind: 'b-spend', fee: 0, vin: [{ noteCommit: Buffer.alloc(16, 3) }] }],
      }])?.reason, 'vin_link');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
