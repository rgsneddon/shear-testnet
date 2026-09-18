import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { BLOCK_SUBSIDY_NANOS, NANOS_PER_SHE } from '../../crypto/asert.js';
import { explorerRecentTxs, confirmedBlockTxs, networkSupply } from '../src/wallet_api.js';
import { encodeHeader } from '../../crypto/header.js';
import { emptyVault } from '../../crypto/reserve_vault.js';

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

  it('explorer recent Infinity returns every sealed block', () => {
    function block(height) {
      return {
        height,
        hash: Buffer.alloc(32, height),
        header: Buffer.alloc(128),
        txs: [{ coinbase: true, height, vout: [{ kind: 'pot', nanos: 1 }] }],
      };
    }
    const blocks = [];
    for (let h = 1; h <= 40; h += 1) blocks.push(block(h));
    const store = { blocks, tip: () => blocks[blocks.length - 1], mempool: [] };
    const all = explorerRecentTxs(store, Infinity).filter((t) => t.kind === 'block');
    assert.equal(all.length, 40);
    assert.equal(all[0].height, 40);
    assert.equal(all[39].height, 1);
    for (let i = 1; i < all.length; i += 1) {
      assert.ok(all[i - 1].height > all[i].height, 'newest height first');
    }
    const capped = explorerRecentTxs(store, 30).filter((t) => t.kind === 'block');
    assert.equal(capped.length, 30);
  });

  it('networkSupply uses the pot schedule when compact coinbase nanos are hidden', () => {
    const hdr = (ms) => encodeHeader({
      prevBlockHash: Buffer.alloc(32),
      merkleRoot: Buffer.alloc(32),
      continuityRoot: Buffer.alloc(32),
      timestamp: BigInt(ms),
      bits: 16,
    });
    const blocks = [];
    for (let h = 1; h <= 3; h += 1) {
      blocks.push({
        height: h,
        header: hdr(1_700_000_000_000 + h * 90_000),
        txs: [{ coinbase: true, vout: [{ kind: 'pot', noteCommit: Buffer.alloc(32), nanos: 0 }] }],
      });
    }
    const store = { blocks, tip: () => blocks[2], reserveVault: emptyVault() };
    const supply = networkSupply(store);
    assert.equal(supply.potNanos, 3 * NANOS_PER_SHE);
    assert.equal(supply.circulatingNanos, 3 * NANOS_PER_SHE);
    assert.equal(supply.vaultNanos, 0);
  });
});
