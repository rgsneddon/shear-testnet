import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { admitMempool, emptyMempool, mempoolRow, retargetMempool, sameMempoolBody } from './mempool.js';
import { encodeDest, encodeAddress, newIdentity } from './address.js';
import { attachDummyOuts } from './dummy.js';
import { sealNote } from './note.js';
import { postedFeeNanos } from './spend.js';

const dest = encodeDest(Buffer.alloc(20, 3), newIdentity().admitBase);

describe('policy mempool', () => {
  it('refuses an opened hidden send, admits a bound send and a B-spend, and drops a fee under the levy', () => {
    const book = emptyMempool();
    const openedShapes = [
      attachDummyOuts({ kind: 'send', to: dest, fee: 100, vout: [{ address: dest }] }),
    ];
    for (const nanos of [1, 2_000_000_000, 100_000_000_000]) {
      openedShapes.push(attachDummyOuts({
        kind: 'send',
        to: dest,
        fee: 100,
        nanos,
        vout: [{ address: dest, nanos, kind: 'send' }],
      }));
    }
    for (const shape of openedShapes) {
      const send = shape.vout.find((o) => o.kind === 'send') || shape.vout[0];
      send.valueProof = sealNote(1, { dest20: Buffer.alloc(20, 3) }).valueProof;
    }
    for (const opened of openedShapes) {
      const send = admitMempool(book, opened, { baseFee: 1 });
      assert.equal(send.ok, false);
      assert.equal(send.reason, 'value_open');
    }
    assert.equal(book.txs.length, 0);
    const commit = Buffer.alloc(32, 7);
    const tag = Buffer.alloc(32, 9);
    const bound = attachDummyOuts({
      kind: 'send',
      to: dest,
      fee: 100,
      nanos: 1,
      vout: [{ address: dest, nanos: 1, kind: 'send' }],
    });
    for (const o of bound.vout) {
      if (String(o.kind || '') !== 'dummy') delete o.valueProof;
    }
    bound.vin = [{ commit }];
    bound.admit_proof = { cTilde: commit, spendTag: tag };
    const admitted = admitMempool(book, bound, { baseFee: 1 });
    assert.equal(admitted.ok, true, admitted.reason);
    assert.equal(book.txs[0].kind, 'send');
    const share = admitMempool(book, { share: true, to: dest, fee: 10 }, { baseFee: 1 });
    assert.equal(share.ok, false);
    assert.equal(share.reason, 'share_not_mempool');
    const rest = admitMempool(book, { kind: 'send', to: encodeAddress(Buffer.alloc(20, 1)), fee: 10 }, { baseFee: 1 });
    assert.equal(rest.ok, false);
    assert.equal(rest.reason, 'rest_frame_on_chain');
    const she = admitMempool(book, { kind: 'send', to: 'she1qxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', fee: 10 }, { baseFee: 1 });
    assert.equal(she.ok, false);
    assert.equal(she.reason, 'silent_id_on_chain');
    const bsp = admitMempool(book, { kind: 'b-spend', to: dest, fee: 0, bFlag: 1 }, { baseFee: 1 });
    assert.equal(bsp.ok, true);
    const claim = admitMempool(book, {
      kind: 'claim',
      from: dest,
      to: dest,
      nanos: 1,
      fee: 2,
      vout: [{ address: dest, nanos: 1 }],
    }, { baseFee: 1 });
    assert.equal(claim.ok, false);
    assert.equal(claim.reason, 'kind');
    assert.equal(book.txs[0].kind, 'send');
    book.txs[0].fee = 1;
    const drop = retargetMempool(book, 8);
    assert.ok(drop.dropped.length >= 1);
    assert.equal(drop.dropped.some((t) => t.kind === 'send'), true);
    assert.equal(book.txs.some((t) => t.kind === 'send'), false);
    assert.equal(book.txs.some((t) => t.kind === 'b-spend'), true);
  });
});

describe('one body per mempool id', () => {
  it('matches only the body that was queued: same bytes in any key order, never a changed fee or output', () => {
    const note = sealNote(5_000, { dest20: Buffer.alloc(20, 7), kind: 'send' });
    const tx = { id: 'tx-one', kind: 'send', fee: 120, anchor: 3, vin: [{ commit: Buffer.alloc(32, 1) }], vout: [{ ...note, kind: 'send' }] };
    // The row as admitMempool stores it: the posted fee is what was paid.
    const row = mempoolRow(tx, postedFeeNanos(tx), 'send');
    assert.equal(sameMempoolBody(row, tx), true, 'the queued body again');
    // A copy from the wire: other key order, Uint8Array for Buffer, a secret key the row never kept.
    const wire = { vout: tx.vout.map((o) => ({ ...o, commit: new Uint8Array(o.commit) })), vin: tx.vin, anchor: 3, fee: 120, kind: 'send', id: 'tx-one', viewKey: 'aa' };
    assert.equal(sameMempoolBody(row, wire), true, 'same bytes, other shape');
    // Anything that changes the body is another body under the same id.
    assert.equal(sameMempoolBody(row, { ...tx, fee: 121 }), false, 'fee');
    assert.equal(sameMempoolBody(row, { ...tx, anchor: 4 }), false, 'anchor');
    assert.equal(sameMempoolBody(row, { ...tx, vout: [{ ...tx.vout[0], commit: Buffer.alloc(32, 9) }] }), false, 'output');
    assert.equal(sameMempoolBody(row, { ...tx, vin: [] }), false, 'input');
    const noFee = { ...tx };
    delete noFee.fee;
    assert.equal(sameMempoolBody(row, noFee), false, 'no fee');
  });

  it('a resend matches the row a reorg bounce queued from the block copy, in every byte shape', () => {
    const note = sealNote(5_000, { dest20: Buffer.alloc(20, 7), kind: 'send' });
    const tx = { id: 'tx-bounce', kind: 'send', fee: 120, anchor: 3, vin: [{ commit: Buffer.alloc(32, 1) }], vout: [{ ...note, kind: 'send' }] };
    // A block copy from a p2p frame carries bytes as {$hex} (p2p.js hexify);
    // one posted over HTTP carries hex text.
    const asWire = (v) => {
      if (Buffer.isBuffer(v) || v instanceof Uint8Array) return { $hex: Buffer.from(v).toString('hex') };
      if (Array.isArray(v)) return v.map(asWire);
      if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, asWire(x)]));
      return v;
    };
    const asHttp = (v) => JSON.parse(JSON.stringify(v, function hexed(k, x) {
      const raw = this[k];
      return Buffer.isBuffer(raw) || raw instanceof Uint8Array ? Buffer.from(raw).toString('hex') : x;
    }));
    // store.js bounceMempool re-admits the disconnected block's tx as this row.
    const copy = asWire(tx);
    const bounced = { ...copy, kind: copy.kind, to: copy.to || copy.vout?.[0]?.address, from: copy.from || copy.vin?.[0]?.address, nanos: copy.nanos || copy.vout?.[0]?.nanos, fee: copy.fee };
    const row = mempoolRow(bounced, postedFeeNanos(bounced), 'send');
    assert.equal(sameMempoolBody(row, tx), true, 'Buffer resend');
    assert.equal(sameMempoolBody(row, asHttp(tx)), true, 'hex resend');
    assert.equal(sameMempoolBody(row, asWire(tx)), true, '{$hex} resend');
    assert.equal(sameMempoolBody(row, { ...asHttp(tx), vin: [{ commit: 'AA'.repeat(32) }] }), false, 'other input bytes, upper-case hex');
    assert.equal(sameMempoolBody(row, { ...tx, vin: [{ commit: '01'.repeat(32).toUpperCase() }] }), true, 'same input bytes, upper-case hex');
  });
});
