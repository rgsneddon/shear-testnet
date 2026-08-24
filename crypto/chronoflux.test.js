import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  SAMPLE_PRUNE_CONFIRMATIONS,
  shouldPruneSamples,
  collateSamples,
  pruneSamples,
  sealedExplorerRows,
  compactChainBlock,
  compactTx,
} from './chronoflux.js';

describe('chronoflux prune + collate', () => {
  it('collates thousands of hashes into one sample per miner', () => {
    const miner = 'shear1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq';
    const fat = Array.from({ length: 4000 }, (_, i) => ({
      miner,
      nonce: String(i),
      tag: 'a',
      count: 1,
    }));
    const slim = collateSamples(fat);
    assert.equal(slim.length, 1);
    assert.equal(slim[0].count, 4000);
    assert.ok(JSON.stringify(slim).length < JSON.stringify(fat).length / 100);
  });

  it('prunes sample bodies after 100 confirmations and never drops sealed txs', () => {
    assert.equal(SAMPLE_PRUNE_CONFIRMATIONS, 100);
    assert.equal(shouldPruneSamples(1, 101), true);
    assert.equal(shouldPruneSamples(2, 101), false);
    const send = {
      id: 'send-1',
      from: 'shear1from',
      to: 'shear1to',
      nanos: 50,
      vin: [{ address: 'shear1from' }],
      vout: [{ address: 'shear1to', nanos: 50 }],
    };
    const block = {
      height: 1,
      hash: 'aa',
      samples: [{ miner: 'shear1from', nonce: '1', tag: 't', count: 9 }],
      txs: [
        {
          coinbase: true,
          height: 1,
          samples: [{ miner: 'shear1from', count: 9 }],
          vout: [
            { address: 'shear1from', nanos: 100_000_000_000, kind: 'pot' },
            { address: 'shear1from', nanos: 90, kind: 'hash' },
          ],
        },
        send,
      ],
    };
    const pruned = pruneSamples(block);
    assert.equal(pruned.samplesPruned, true);
    assert.deepEqual(pruned.samples, []);
    assert.equal(pruned.txs[0].samples, undefined);
    assert.equal(pruned.txs[0].vout.length, 2);
    assert.equal(pruned.txs[1].id, 'send-1');
    const rows = sealedExplorerRows(pruned);
    assert.equal(rows.length, 3);
    assert.ok(rows.some((r) => r.kind === 'coinbase' && r.nanos === 100_000_000_000));
    assert.ok(rows.some((r) => r.id === 'send-1'));
    assert.throws(() => pruneSamples({ height: 1, txs: [] }), /prune_refuses_empty_txs/);
  });

  it('compact chain row is header + sealed txs, not per-hash JSON', () => {
    const fatSamples = Array.from({ length: 200 }, (_, i) => ({
      miner: 'shear1a',
      nonce: String(i),
      count: 1,
    }));
    const row = compactChainBlock({
      magic: 'shear-testnet-v1',
      height: 4,
      miner: 'shear1a',
      samples: fatSamples,
      txs: [
        compactTx({
          coinbase: true,
          height: 4,
          samples: fatSamples,
          vout: [{ address: 'shear1a', nanos: 100_000_000_000, kind: 'pot' }],
        }),
      ],
    });
    assert.equal(row.samples.length, 1);
    assert.equal(row.samples[0].count, 200);
    assert.equal(row.txs[0].samples, undefined);
    assert.equal(row.txs[0].vout[0].kind, 'pot');
    const prunedRow = compactChainBlock({ ...row, samplesPruned: true, samples: fatSamples });
    assert.deepEqual(prunedRow.samples, []);
    assert.equal(prunedRow.txs.length, 1);
  });
});
