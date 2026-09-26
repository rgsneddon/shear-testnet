import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { BLOCK_SUBSIDY_NANOS, HASH_BONUS_NANOS } from './asert.js';
import { FLUFF_MAX_MS, FLUFF_MIN_MS, STEM_MAX_HOPS } from '../node/src/p2p.js';
import {
  DINS_ENABLED,
  SHARE_FLUFF_MAX_MS,
  SHARE_FLUFF_MIN_MS,
  SHARE_STEM_MAX_HOPS,
  addShare,
  createShareDag,
  pullBookHashLeg,
  sealDag,
  sealShareDag,
  soleMint,
} from './share_dag.js';

function simulateSeal(opts) {
  return sealShareDag(opts);
}

describe('DINS spike sim', () => {
  it('sole-mints pot plus hash once and rejects an omitted foreign blue', () => {
    const shares = [
      { id: 'a', hashNanos: 256, seen: 2 },
      { id: 'b', hashNanos: 256, seen: 1 },
    ];
    const first = simulateSeal({ spinePot: 1e11, shares, blue: ['a', 'b'] });
    const second = simulateSeal({ spinePot: 1e11, shares: [...shares].reverse(), blue: ['b', 'a'] });
    assert.equal(first.ok, true);
    assert.equal(first.emissionNanos, 1e11 + 512);
    assert.equal(second.emissionNanos, first.emissionNanos);
    assert.deepEqual(first.paid.sort(), second.paid.sort());
    const third = simulateSeal({ spinePot: 1e11, shares, blue: ['a', 'b'] });
    assert.equal(third.emissionNanos, first.emissionNanos);
    assert.deepEqual(third.paid.sort(), first.paid.sort());
    const omitted = simulateSeal({
      spinePot: 1e11,
      shares,
      blue: ['a', 'b'],
      omittedBlue: ['b'],
    });
    assert.equal(omitted.ok, false);
    assert.equal(omitted.reason, 'omit_eligible_foreign');
    const openRound = simulateSeal({
      spinePot: 1e11,
      shares: shares.concat([{ id: 'open', hashNanos: 256 }]),
      blue: ['a', 'b'],
    });
    assert.equal(openRound.ok, true);
    assert.equal(openRound.emissionNanos, first.emissionNanos);
    assert.equal(openRound.paid.includes('open'), false);
  });

  it('DINS is on, the node does not grow a new block rule, and the pull book drops the second hash leg', () => {
    const roots = ['crypto', 'node/src', 'pool/src'];
    const bad = [];
    for (const root of roots) {
      const dir = new URL(`../${root}/`, import.meta.url);
      for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith('.js')) continue;
        const file = new URL(name, dir);
        if (!fs.statSync(file).isFile()) continue;
        if (name === 'share_dag_sim.test.js') continue;
        const text = fs.readFileSync(file, 'utf8');
        if (/trustedShareBatch/.test(text)) bad.push(`${root}/${name}:trustedShareBatch`);
        if (root === 'node/src' && /sealShareDag|share_dag|DINS_ENABLED/.test(text)) {
          bad.push(`${root}/${name}:node-rule`);
        }
      }
    }
    assert.deepEqual(bad, []);
    assert.equal(DINS_ENABLED, true);
    const pool = fs.readFileSync(new URL('../pool/src/pool.js', import.meta.url), 'utf8');
    assert.match(pool, /pullBookHashLeg\(hashPays\)/);
    assert.doesNotMatch(pool, /hashByDest:\s*hashPays/);
    const leg = pullBookHashLeg(new Map([['ssa1', HASH_BONUS_NANOS]]));
    assert.equal(leg.size, 0);
    const off = pullBookHashLeg(new Map([['ssa1', HASH_BONUS_NANOS]]), false);
    assert.equal(off.get('ssa1'), HASH_BONUS_NANOS);
  });

  it('pays foreign blue the same from either sealer and refuses a double hash mint', () => {
    const dag = createShareDag();
    addShare(dag, { id: 'late', hashNanos: HASH_BONUS_NANOS });
    addShare(dag, { noteCommit: 'pool', hashNanos: HASH_BONUS_NANOS });
    addShare(dag, { id: 'pool', hashNanos: 999 });
    const reversed = createShareDag();
    addShare(reversed, { noteCommit: 'pool', hashNanos: HASH_BONUS_NANOS });
    addShare(reversed, { id: 'late', hashNanos: HASH_BONUS_NANOS });
    const a = sealDag(dag, { spinePot: BLOCK_SUBSIDY_NANOS });
    const b = sealDag(reversed, { spinePot: BLOCK_SUBSIDY_NANOS });
    assert.equal(a.ok, true);
    assert.equal(a.emissionNanos, BLOCK_SUBSIDY_NANOS + 2 * HASH_BONUS_NANOS);
    assert.deepEqual(a.paid, b.paid);
    assert.deepEqual(dag.seen, ['late', 'pool']);
    const starved = sealDag(dag, { spinePot: BLOCK_SUBSIDY_NANOS, omittedBlue: ['late'] });
    assert.equal(starved.ok, false);
    assert.equal(starved.reason, 'omit_eligible_foreign');
    const doubled = soleMint({
      enabled: true,
      pullBookHashNanos: HASH_BONUS_NANOS,
      leafHashNanos: a.hashNanos,
    });
    assert.equal(doubled.ok, false);
    assert.equal(doubled.reason, 'double_pay');
    const cut = soleMint({ enabled: true, pullBookHashNanos: 0, leafHashNanos: a.hashNanos });
    assert.equal(cut.ok, true);
    assert.equal(cut.pullBookHashNanos, 0);
    assert.equal(cut.leafHashNanos, a.hashNanos);
    assert.equal(BLOCK_SUBSIDY_NANOS, 100_000_000_000);
    assert.equal(HASH_BONUS_NANOS, 1);
    assert.equal(STEM_MAX_HOPS, 3);
    assert.equal(FLUFF_MIN_MS, 1000);
    assert.equal(FLUFF_MAX_MS, 3000);
    assert.equal(SHARE_STEM_MAX_HOPS, 3);
    assert.equal(SHARE_FLUFF_MIN_MS, 1000);
    assert.equal(SHARE_FLUFF_MAX_MS, 3000);
  });
});
