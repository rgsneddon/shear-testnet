import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { sealedAvgRewardShe } from '../src/sealed_avg.js';

describe('explorer average block reward', () => {
  it('uses gross sealed pot over height with no fee subtract and no 1.0 clamp', () => {
    const half = sealedAvgRewardShe({
      height: 100,
      potEmittedNanos: 50e11,
      hashBonusEmittedNanos: 0,
    });
    assert.equal(half, 0.5);
    const fat = sealedAvgRewardShe({
      height: 100,
      potEmittedNanos: 150e11,
      hashBonusEmittedNanos: 50e11,
    });
    assert.equal(fat, 2);
    assert.notEqual(fat, 1);
    const live = sealedAvgRewardShe({
      height: 1796,
      potEmittedNanos: 179600000000000,
      hashBonusEmittedNanos: 10477056,
    });
    assert.equal(live, (179600000000000 + 10477056) / 1796 / 1e11);
    assert.equal(sealedAvgRewardShe({ height: 0, potEmittedNanos: 1, hashBonusEmittedNanos: 1 }), null);
  });

  it('explorer page binds that formula and does not invent an avg API', () => {
    const html = fs.readFileSync(new URL('../public/explorer.html', import.meta.url), 'utf8');
    assert.match(html, /Average block reward since genesis/);
    assert.match(html, /avgPot \+ avgBonus/);
    assert.doesNotMatch(html, /avgBlockReward/);
    assert.doesNotMatch(html, /Math\.min\(\s*avg/);
    assert.doesNotMatch(html, /POOL_FEE/);
    const wallet = fs.readFileSync(new URL('../../wallet/lib/main.dart', import.meta.url), 'utf8');
    const hashLabel = wallet.indexOf("'Hash bonus'");
    const hashAt = wallet.indexOf("key: const Key('continuum-hash-bonus')");
    const avgLabel = wallet.indexOf("'Avg block reward'");
    const avgAt = wallet.indexOf("key: const Key('continuum-avg-block-reward')");
    assert.ok(hashLabel > 0 && hashAt > hashLabel && avgLabel > hashAt && avgAt > avgLabel);
    const ledger = fs.readFileSync(new URL('../../wallet/lib/shear_ledger.dart', import.meta.url), 'utf8');
    assert.match(ledger, /potEmittedNanos \+ hashBonusEmittedNanos\) \/ height/);
  });
});
