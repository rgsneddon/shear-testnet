import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { freezeBannerLine, applySignals, emptyPolicyState, getpolicy } from '../../crypto/confirm_policy.js';
import { createPool } from '../src/pool.js';
import { newIdentity, freshStealthDest } from '../../crypto/address.js';

function loadPaintFreezeBanner(rel) {
  const src = fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
  assert.match(src, /id="freeze-banner"/);
  assert.match(src, /function paintFreezeBanner\(el, s\)/);
  assert.match(src, /policy\.freeze_banner/);
  assert.match(src, /s\.frozen/);
  assert.doesNotMatch(src, /SHEAR_POOL_SPEND_SEED/);
  const fn = src.match(/function paintFreezeBanner\(el, s\) \{[\s\S]*?\n    \}/);
  assert.ok(fn, `paintFreezeBanner missing in ${rel}`);
  return new Function(`${fn[0]}; return paintFreezeBanner;`)();
}

const SURFACES = [
  '../public/index.html',
  '../public/miner.html',
  '../admin/index.html',
];

describe('freeze banner on pool HUD / miner / admin', () => {
  for (const rel of SURFACES) {
    it(`${rel} paints freeze_reason and elevated confirms when frozen, hides when not`, () => {
      const paint = loadPaintFreezeBanner(rel);
      const el = { hidden: true, textContent: '' };
      paint(el, { frozen: false, policy: { freeze_banner: 'Credits frozen (h_ratio): confirmations elevated to 60.' } });
      assert.equal(el.hidden, true);
      assert.equal(el.textContent, '');
      const line = freezeBannerLine({
        frozen: true,
        freeze_reason: 'h_ratio',
        operational: { pool_merchant: 60 },
      });
      paint(el, { frozen: true, policy: { freeze_banner: line }, freeze_banner: line });
      assert.equal(el.hidden, false);
      assert.equal(el.textContent, 'Credits frozen (h_ratio): confirmations elevated to 60.');
      assert.match(el.textContent, /h_ratio/);
      assert.match(el.textContent, /elevated/);
      assert.doesNotMatch(el.textContent, /ssa1/);
    });
  }

  it('pool stats / admin health / miner JSON expose freeze_banner from getpolicy', () => {
    const src = fs.readFileSync(new URL('../src/pool.js', import.meta.url), 'utf8');
    assert.match(src, /freeze_banner: policy\.freeze_banner/);
    assert.match(src, /frozen: !!policy\.frozen/);
    assert.match(src, /freeze_reason: policy\.freeze_reason/);
    const s = applySignals(emptyPolicyState(), { nowMs: 1, h_ratio: 0.39, side_lead: 0 });
    const p = getpolicy(s);
    assert.equal(p.frozen, true);
    assert.equal(p.freeze_reason, 'h_ratio');
    assert.equal(p.h_ratio, 0.39);
    assert.equal(typeof p.side_lead, 'number');
    assert.equal(p.freeze_banner, 'Credits frozen (h_ratio): confirmations elevated to 60.');
  });

  it('Continuum source shows freeze banner when frozen', () => {
    const dart = fs.readFileSync(new URL('../../wallet/lib/main.dart', import.meta.url), 'utf8');
    assert.match(dart, /continuum-freeze-banner/);
    assert.match(dart, /creditsFrozen/);
    assert.match(dart, /freezeBanner/);
    const ledger = fs.readFileSync(new URL('../../wallet/lib/shear_ledger.dart', import.meta.url), 'utf8');
    assert.match(ledger, /freeze_reason/);
    assert.match(ledger, /freeze_banner/);
    assert.match(ledger, /Credits frozen \(\$reason\): confirmations elevated to \$confirmedNeed/);
  });

  it('GET /api/stats returns frozen, freeze_reason, h_ratio, side_lead, confirmedNeed', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-freeze-stats-'));
    const dest = freshStealthDest(newIdentity()).dest;
    const pool = createPool({
      dataDir: dir,
      stratumPort: 0,
      httpPort: 0,
      miner: dest,
      shareBits: 8,
      bits: 16,
    });
    await new Promise((resolve, reject) => {
      pool.httpServer.listen(0, '127.0.0.1', resolve);
      pool.httpServer.on('error', reject);
    });
    try {
      const port = pool.httpServer.address().port;
      const stats = await fetch(`http://127.0.0.1:${port}/api/stats`).then((r) => r.json());
      assert.equal(stats.ok, true);
      assert.equal(stats.frozen, false);
      assert.equal(stats.confirmedNeed, 30);
      assert.equal(stats.spendableConfirmations, 6);
      assert.equal(stats.policy.frozen, false);
      assert.equal(stats.policy.freeze_reason, '');
      assert.equal(stats.policy.freeze_banner, '');
      assert.equal(typeof stats.policy.h_ratio, 'number');
      assert.equal(typeof stats.policy.side_lead, 'number');
      const live = pool.publicStats();
      assert.equal(live.frozen, false);
      assert.equal(live.policy.freeze_reason, '');
    } finally {
      pool.close();
    }
  });
});
