import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { encodeDest } from '../../crypto/address.js';
import { createStore } from '../src/store.js';
import { chainWorkOf } from '../src/chain.js';
import { observeRate, emptyOracle } from '../../crypto/reserve_oracle.js';
import { decodeHeader } from '../../crypto/header.js';
import { consensusFingerprint } from '../../crypto/asert.js';

function destMiner() {
  return encodeDest(Buffer.alloc(20, 4));
}

let powTag = 1;
function mineOne(store, dest) {
  const parent = store.tip();
  const now = parent
    ? Number(decodeHeader(Buffer.from(parent.header)).timestamp) + 90_000
    : Date.now();
  const { tpl } = store.template({ miner: dest, now });
  const pow = Buffer.alloc(32, 0);
  pow[31] = powTag;
  powTag += 1;
  return store.append({
    header: tpl.header,
    txs: tpl.txs,
    samples: tpl.samples,
    miner: dest,
    aLeaves: tpl.aLeaves,
    bLeaves: tpl.bLeaves,
    rootA: tpl.rootA,
    rootB: tpl.rootB,
    weight: tpl.weight,
  }, { trustedPowHash: pow, skipSharePow: true });
}

describe('store policy and pause', () => {
  it('getpolicy is live and fingerprint still pins 9 not 30', () => {
    const store = createStore(fs.mkdtempSync(path.join(os.tmpdir(), 'shear-pol-')));
    const p = store.getpolicy();
    assert.equal(p.consensus_min, 9);
    assert.equal(p.bands.pool_merchant, 12);
    assert.equal(p.frozen, false);
    assert.equal(p.freeze_reason, '');
    assert.equal(p.freeze_banner, '');
    assert.equal(p.h_ratio, 1);
    assert.equal(typeof p.side_lead, 'number');
    const storeSrc = fs.readFileSync(new URL('../src/store.js', import.meta.url), 'utf8');
    assert.match(storeSrc, /hourlyWorkBuckets/);
    const fp = consensusFingerprint();
    assert.match(fp, /:9:1:1000:/);
    assert.match(fp, /HASH_FN=ShearHash-v3/);
    assert.equal(fp.includes(':30:'), false);
  });

  it('module pause refuses new pool-withdraw txs and does not rewind the tip', () => {
    const dest = destMiner();
    const store = createStore(fs.mkdtempSync(path.join(os.tmpdir(), 'shear-pause-')));
    const mined = mineOne(store, dest);
    assert.equal(mined.ok, true, mined.reason);
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
    const mined = mineOne(store, dest);
    assert.equal(mined.ok, true, mined.reason);
    const before = chainWorkOf(store.blocks);
    const oracle = emptyOracle();
    observeRate(oracle, { annualBps: 9000, nowMs: Date.now() });
    store.reserveVault.oracle = oracle;
    assert.equal(chainWorkOf(store.blocks), before);
  });
});
