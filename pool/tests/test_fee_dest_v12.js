import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPool, THIS_POOL_DIRECT_FEE_DEST, configuredFeeIdentity } from '../src/pool.js';
import { isDestAddress, hash20FromAddress } from '../../crypto/address.js';
import { openedCoinbaseNanos } from '../../crypto/note.js';
import { POOL_FEE_BPS } from '../../crypto/asert.js';

const FEE = 'ssa1qfqhuqrvxe63785jttt6t35fjs8r7heus2zweyv22twndy8mkcyjqs6c03jaql5q64ragqs6hx6drwr4ddddqwre9sv';

describe('v12 pool fee address', () => {
  it('the page, /api/stats and the pool config hold the identical address', async () => {
    assert.equal(isDestAddress(FEE), true);
    assert.equal(THIS_POOL_DIRECT_FEE_DEST, FEE);
    const ident = configuredFeeIdentity({ env: {} });
    assert.equal(ident.ok, true);
    assert.equal(ident.feeDest, FEE);
    assert.equal(ident.adminSpendDest, FEE);

    const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
    const mark = '<strong>Testnet.</strong> Pool fee address : <code id="pool-fee-dest">';
    const at = html.indexOf(mark);
    assert.ok(at > html.indexOf('Shear is a private cryptocurrency.'), 'fee line stays on the Testnet paragraph');
    const code = html.slice(at + mark.length, html.indexOf('</code>', at));
    assert.equal(code, FEE);
    assert.match(
      html.slice(at, at + mark.length + FEE.length + 80),
      /<button type="button" id="copy-fee-dest">Copy dest<\/button>/,
    );
    assert.equal(code, THIS_POOL_DIRECT_FEE_DEST);
    assert.equal(code, ident.feeDest);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-fee-v12-'));
    const pool = createPool({ dataDir: dir, stratumPort: 0, httpPort: 0 });
    try {
      const heard = await pool.listen();
      pool.paintStatsSnap();
      const stats = await fetch(`http://127.0.0.1:${heard.httpPort}/api/stats`).then((r) => r.json());
      assert.equal(stats.ok, true);
      assert.equal(stats.feeDest, FEE);
      assert.equal(stats.feeDest, code);
      assert.equal(stats.feeDest, THIS_POOL_DIRECT_FEE_DEST);
      assert.equal(stats.feeNanos, undefined);
      assert.equal(stats.poolFeeNanos, undefined);
      assert.equal(stats.fluxset, undefined);
    } finally {
      pool.close();
    }
  });

  it('the first pool coinbase pays the fee note to that dest and carries the miner pot', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-fee-h1-'));
    const pool = createPool({ dataDir: dir, stratumPort: 0, httpPort: 0, miner: FEE });
    try {
      assert.equal(pool.store.tip(), null);
      const job = pool.issueJob(undefined, { force: true });
      assert.ok(job?.jobId);
      const tpl = pool.store.jobs.get(String(job.jobId)).tpl;
      assert.equal(tpl.height, 1);
      const cb = tpl.txs[0];
      const want = hash20FromAddress(FEE);
      const fees = (cb.vout || []).filter((o) => o.kind === 'pool-fee');
      assert.equal(fees.length, 1);
      assert.ok(Buffer.from(fees[0].dest20).equals(want));
      const opened = openedCoinbaseNanos(fees[0]);
      const carry = Math.floor(Number(cb.carryNanos) || 0);
      const subsidy = opened + carry;
      assert.equal(opened, Math.floor(subsidy * POOL_FEE_BPS / 10000));
      assert.ok(opened > 0 && opened < subsidy);
      assert.equal((cb.vout || []).some((o) => o.kind === 'pot'), false);
      const pow = Buffer.alloc(32);
      pow[4] = 3;
      const sealed = await pool.store.submitHeader({
        jobId: job.jobId,
        nonce: 0n,
        miner: FEE,
        powHash: pow.toString('hex'),
      }, { trusted: true });
      assert.equal(sealed.ok, true, sealed.reason || 'seal');
      const tip = pool.store.tip();
      assert.equal(tip.height, 1);
      const stored = (tip.txs[0].vout || []).filter((o) => o.kind === 'pool-fee');
      assert.equal(stored.length, 1);
      assert.ok(Buffer.from(stored[0].dest20).equals(want));
      assert.equal(openedCoinbaseNanos(stored[0]), opened);
      assert.equal(Math.floor(Number(tip.txs[0].carryNanos) || 0), carry);
    } finally {
      pool.close();
    }
  });
});
