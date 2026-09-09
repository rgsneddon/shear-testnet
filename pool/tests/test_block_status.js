import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { BLOCK_SUBSIDY_NANOS } from '../../crypto/asert.js';
import { explorerRecentTxs, confirmedBlockTxs } from '../src/wallet_api.js';

function loadBlockStatus(rel) {
  const src = fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
  const fn = src.match(/function blockStatus\(t, tip, need\) \{[\s\S]*?\n    \}/);
  assert.ok(fn, `blockStatus missing in ${rel}`);
  return new Function(`${fn[0]}; return blockStatus;`)();
}

describe('mined-block pending uses consensus 6, not pool_merchant 30', () => {
  for (const rel of ['../public/index.html', '../public/explorer.html']) {
    it(`${rel} confirms height 1 at tip 6; 30-conf band is not the mined gate`, () => {
      const src = fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
      assert.match(src, /spendableConfirmations/);
      assert.doesNotMatch(src, /confirmedNeed/);
      assert.doesNotMatch(src, /pool_merchant/);
      const blockStatus = loadBlockStatus(rel);
      assert.equal(blockStatus({ height: 1 }, 6, 6), 'confirmed');
      assert.equal(blockStatus({ height: 1 }, 5, 6), 'pending');
      assert.equal(blockStatus({ height: 1 }, 1, 6), 'pending');
      assert.equal(blockStatus({ height: 1 }, 6, 30), 'pending');
      assert.equal(blockStatus({ height: 5 }, 10, 6), 'confirmed');
    });
  }

  it('dashboard and explorer paint mined status from tip vs 6, not API status', () => {
    for (const rel of ['../public/index.html', '../public/explorer.html']) {
      const src = fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
      assert.match(src, /Number\(t\.height\) >= 1/);
      assert.match(src, /blockStatus\(t,/);
      assert.equal(src.includes('t.status || blockStatus'), false);
    }
  });

  it('wallet Continuum settle is already spendableConfirmations 6', () => {
    const src = fs.readFileSync(new URL('../../wallet/lib/shear_ledger.dart', import.meta.url), 'utf8');
    assert.match(src, /static const spendableConfirmations = 6/);
    assert.match(src, /confirmationsOf\(row\.height, tip\) >= spendableConfirmations/);
    assert.match(src, /confirmationsOf\(h, tip\) >= spendableConfirmations/);
  });

  it('explorerRecentTxs marks a tip-height coinbase pending until 6 confirms', () => {
    const dest = 'ssa1qfywwp7jll5p0ys54azypr7u9p2g0r45k59xxxr';
    function block(height, n) {
      return {
        height,
        hash: Buffer.alloc(32, height),
        miner: dest,
        header: Buffer.alloc(128),
        txs: [{
          coinbase: true,
          height,
          vout: [{ address: dest, nanos: BLOCK_SUBSIDY_NANOS, kind: 'pot' }],
        }],
      };
    }
    const blocks = [block(1, 1), block(2, 2), block(3, 3)];
    const store = {
      blocks,
      tip: () => blocks[blocks.length - 1],
    };
    const rows = explorerRecentTxs(store, 10);
    const byH = Object.fromEntries(rows.filter((t) => t.kind === 'block').map((t) => [t.height, t]));
    assert.equal(byH[3].pending, true);
    assert.equal(byH[3].status, 'pending');
    assert.equal(byH[3].confirmations, 1);
    assert.equal(byH[1].pending, true);
    assert.equal(byH[1].confirmations, 3);
    const deep = [];
    for (let h = 1; h <= 6; h += 1) deep.push(block(h, h));
    const store6 = { blocks: deep, tip: () => deep[deep.length - 1] };
    const later = confirmedBlockTxs(store6, 10);
    const h1 = later.find((t) => t.height === 1);
    const h6 = later.find((t) => t.height === 6);
    assert.equal(h1.status, 'confirmed');
    assert.equal(h1.pending, false);
    assert.equal(h1.confirmations, 6);
    assert.equal(h6.status, 'pending');
    assert.equal(h6.pending, true);
    assert.equal(h6.confirmations, 1);
  });
});
