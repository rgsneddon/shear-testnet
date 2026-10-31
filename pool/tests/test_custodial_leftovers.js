/**
 * What the custodial pull left behind, now gone: the pullPending route and
 * its map, the exported takeConfirmed, the withdraw CSS and the pull
 * formatter on the miner page, the finder and found-count reads in pool.js.
 * The dead withdraw routes answer 410 with the reason the queue gives,
 * custodial_pull, not the name of a payout that no longer exists.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPullBook } from '../src/pull_book.js';
import { handleWalletApi } from '../src/wallet_api.js';
import { configuredFeeIdentity, createPool } from '../src/pool.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const FEE = configuredFeeIdentity().feeDest;
const url = (p) => new URL(`http://127.0.0.1${p}`);
const ctx = () => ({ store: { historyFor: () => [], tip: () => ({ height: 20 }), mempool: [] }, queueSend: () => ({}) });
const AUTO_PAYOUT_REASON = ['auto', 'payout'].join('_');

describe('custodial leftovers are gone', () => {
  it('the dead withdraw routes answer 410 custodial_pull', async () => {
    const api = handleWalletApi(url('/api/pool/withdraw'), 'POST', { login: '', dest: 'ssa1q', nanos: 1, sig: 'x' }, ctx());
    assert.equal(api.status, 410);
    assert.equal(api.json.ok, false);
    assert.equal(api.json.reason, 'custodial_pull');
    assert.equal(api.json.deprecated, true);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-leftover-410-'));
    const pool = createPool({ dataDir: dir, stratumPort: 0, httpPort: 0, miner: FEE });
    try {
      await new Promise((resolve, reject) => {
        pool.httpServer.listen(0, '127.0.0.1', resolve);
        pool.httpServer.on('error', reject);
      });
      const port = pool.httpServer.address().port;
      const res = await fetch(`http://127.0.0.1:${port}/api/miners/mdeadbeef/withdraw`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      const json = await res.json();
      assert.equal(res.status, 410);
      assert.equal(json.ok, false);
      assert.equal(json.reason, 'custodial_pull');
    } finally {
      pool.close();
    }
    for (const file of ['pool/src/wallet_api.js', 'pool/src/pool.js']) {
      assert.equal(read(file).includes(`reason: '${AUTO_PAYOUT_REASON}'`), false, file);
    }
  });

  it('there is no pullPending route and no pending-pull map', () => {
    for (const p of ['/api/pool/pullPending?tag=mdeadbeef', '/api/pool/pullpending?login=she1abc']) {
      assert.equal(handleWalletApi(url(p), 'GET', null, ctx()), null, p);
    }
    for (const file of ['pool/src/wallet_api.js', 'pool/src/pool.js']) {
      assert.doesNotMatch(read(file), /pullPending|pullpending|pendingPulls/, file);
    }
  });

  it('the pull book exports no takeConfirmed, reconcile or finderOf', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-leftover-book-'));
    const book = createPullBook(dir);
    assert.equal(book.takeConfirmed, undefined);
    assert.equal(book.reconcile, undefined);
    assert.equal(book.finderOf, undefined);
    assert.equal(book.sealsLifetime, undefined);
    assert.equal(typeof book.view, 'function');
    assert.equal(typeof book.bindDest, 'function');
    assert.equal(typeof book.hasTag, 'function');
  });

  it('the miner page has no withdraw styles and no pull formatter', () => {
    const miner = read('pool/public/miner.html');
    assert.doesNotMatch(miner, /\.withdraw-btn|\.pull-form|fmtPullShe/);
  });

  it('pool.js reads no finder record or found count from the pull book', () => {
    const src = read('pool/src/pool.js');
    assert.doesNotMatch(src, /finderOf|foundBlocks|pullBook\.sealsLifetime|pullBook\.reconcile/);
  });
});
