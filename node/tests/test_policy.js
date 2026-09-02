import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { encodeDest } from '../../crypto/address.js';
import { createStore } from '../src/store.js';
import { mineTemplate, chainWorkOf } from '../src/chain.js';
import { observeRate, emptyOracle } from '../../crypto/reserve_oracle.js';
import { decodeHeader } from '../../crypto/header.js';
import { consensusFingerprint } from '../../crypto/asert.js';

function destMiner() {
  return encodeDest(Buffer.alloc(20, 4));
}

function mineOne(store, dest, bits = 4) {
  const parent = store.tip();
  const now = parent
    ? Number(decodeHeader(Buffer.from(parent.header)).timestamp) + 90_000
    : Date.now();
  const { tpl } = store.template({ miner: dest, bits, shareBits: bits, now });
  const found = mineTemplate({ ...tpl, bits }, { maxTries: 3_000_000, shareBits: bits });
  assert.ok(found && found.block, 'need pow');
  return store.append({
    header: found.header,
    txs: tpl.txs,
    samples: tpl.samples,
    miner: dest,
  });
}

describe('store policy and pause', () => {
  it('getpolicy is live and fingerprint still pins 6 not 30', () => {
    const store = createStore(fs.mkdtempSync(path.join(os.tmpdir(), 'shear-pol-')));
    const p = store.getpolicy();
    assert.equal(p.consensus_min, 6);
    assert.equal(p.bands.pool_merchant, 30);
    const fp = consensusFingerprint();
    assert.match(fp, /:6:1:HASH_FN=ShearHash-v2/);
    assert.equal(fp.includes(':30:'), false);
  });

  it('module pause refuses new pool-withdraw txs and does not rewind the tip', () => {
    const dest = destMiner();
    const store = createStore(fs.mkdtempSync(path.join(os.tmpdir(), 'shear-pause-')));
    assert.equal(mineOne(store, dest).ok, true);
    const before = Buffer.from(store.tip().hash);
    store.pause.poolWithdraw = true;
    const q = store.queueTx({
      id: 'pull-paused',
      kind: 'pool-withdraw',
      from: dest,
      to: dest,
      nanos: 1,
      fee: 100,
    });
    assert.equal(q.ok, false);
    assert.equal(q.reason, 'paused');
    assert.equal(Buffer.from(store.tip().hash).equals(before), true);
    assert.equal(store.tip().height, 1);
  });

  it('reorg_halt_depth defaults off and can be set on a throwaway store', () => {
    const a = createStore(fs.mkdtempSync(path.join(os.tmpdir(), 'shear-halt-a-')));
    assert.equal(a.reorgHaltDepth, 0);
    const b = createStore(fs.mkdtempSync(path.join(os.tmpdir(), 'shear-halt-b-')), { reorgHaltDepth: 4 });
    assert.equal(b.reorgHaltDepth, 4);
  });

  it('oracle bps does not change chain work', () => {
    const dest = destMiner();
    const store = createStore(fs.mkdtempSync(path.join(os.tmpdir(), 'shear-oracle-')));
    assert.equal(mineOne(store, dest).ok, true);
    const before = chainWorkOf(store.blocks);
    const oracle = emptyOracle();
    observeRate(oracle, { annualBps: 9000, nowMs: Date.now() });
    store.reserveVault.oracle = oracle;
    assert.equal(chainWorkOf(store.blocks), before);
  });
});
