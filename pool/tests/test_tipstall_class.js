import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tipStallClass, TIP_STALL_MS } from '../src/pool.js';

describe('tip stall class', () => {
  it('names low hashrate and tip age without calling the tip dead', () => {
    const row = tipStallClass({
      tipAgeMs: TIP_STALL_MS + 1,
      lastFoundAgeMs: TIP_STALL_MS + 1,
      hashrate: 640,
      miners: 1,
      sealProgress: true,
      peerMaxStuck: false,
      ibdDead: false,
    });
    assert.equal(row.klass, 'low-h');
    assert.equal(row.deadTip, false);
    assert.equal(row.bounce, false);
    assert.equal(row.restart, false);
    assert.match(row.text, /low-H/);
    assert.match(row.text, /tipAge/);
    assert.doesNotMatch(row.text, /dead tip/i);
  });

  it('names a frozen tip only when seal, peer-max, and IBD are all stuck', () => {
    const row = tipStallClass({
      tipAgeMs: TIP_STALL_MS + 1,
      lastFoundAgeMs: TIP_STALL_MS + 1,
      hashrate: 0,
      miners: 0,
      sealProgress: false,
      peerMaxStuck: true,
      ibdDead: true,
    });
    assert.equal(row.klass, 'frozen');
    assert.equal(row.deadTip, true);
    assert.equal(row.bounce, false);
    assert.match(row.text, /frozen/);
  });

  it('never bounces or restarts from hashrate or a frozen classification', () => {
    const src = fs.readFileSync(new URL('../src/pool.js', import.meta.url), 'utf8');
    const body = src.slice(src.indexOf('function watchTipStall'), src.indexOf('function resetOpenRound'));
    assert.equal(/tip_stall_restamp/.test(body), false);
    assert.equal(/systemctl/.test(body), false);
    assert.equal(/\.restart\(/.test(body), false);
    assert.equal(/process\.exit/.test(body), false);
    const row = tipStallClass({
      tipAgeMs: TIP_STALL_MS * 4,
      lastFoundAgeMs: TIP_STALL_MS * 4,
      hashrate: 640,
      miners: 1,
      sealProgress: true,
    });
    assert.equal(row.bounce, false);
    assert.equal(row.restart, false);
    assert.equal(row.deadTip, false);
  });
});
