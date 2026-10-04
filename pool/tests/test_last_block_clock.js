import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createPool } from '../src/pool.js';
import { newIdentity, freshStealthDest } from '../../crypto/address.js';

function sliceFn(src, name) {
  const key = `function ${name}(`;
  const start = src.indexOf(key);
  assert.ok(start >= 0, name);
  let i = src.indexOf('{', start);
  let depth = 0;
  for (; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  assert.fail(`unclosed ${name}`);
}

describe('pool last-block clock', () => {
  const page = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const poolSrc = fs.readFileSync(new URL('../src/pool.js', import.meta.url), 'utf8');
  const api = vm.runInNewContext(
    `${sliceFn(page, 'poolFindClockOffsetMs')}
${sliceFn(page, 'poolLastBlockAgeMs')}
${sliceFn(page, 'fmtSinceBlock')}
({ poolFindClockOffsetMs, poolLastBlockAgeMs, fmtSinceBlock });`,
  );

  it('a newly observed find starts at 00:00:00 rather than the poll delay', () => {
    const foundAt = 1_700_000_000_000;
    const poolNow = foundAt + 180;
    const pollDelayMs = 60_000;
    const clientNow = poolNow + pollDelayMs;
    const offset = api.poolFindClockOffsetMs(poolNow, clientNow);
    const age = api.poolLastBlockAgeMs(foundAt, clientNow, offset);
    assert.equal(age, 180);
    assert.equal(Math.floor(age / 1000), 0);
    assert.equal(api.fmtSinceBlock(age), '00:00:00');
    assert.ok(clientNow - foundAt >= pollDelayMs);
    const later = api.poolLastBlockAgeMs(foundAt, clientNow + 3_000, offset);
    assert.equal(later, 180 + 3_000);
    assert.equal(api.fmtSinceBlock(later), '00:00:03');
  });

  it('an older pool find keeps the pool age', () => {
    const poolNow = 1_700_000_000_000;
    const foundAt = poolNow - (10 * 60_000);
    const clientNow = poolNow + 45_000;
    const offset = api.poolFindClockOffsetMs(poolNow, clientNow);
    const age = api.poolLastBlockAgeMs(foundAt, clientNow, offset);
    assert.equal(age, 10 * 60_000);
    assert.equal(api.fmtSinceBlock(age), '00:10:00');
    assert.equal(api.poolLastBlockAgeMs(0, clientNow, offset), 0);
    assert.equal(api.fmtSinceBlock(NaN), '—');
  });

  it('the page update path uses lastFoundAt and poolNow, not the header', () => {
    const note = sliceFn(page, 'notePoolFindClock');
    assert.match(note, /s\.lastFoundAt/);
    assert.match(note, /s\.poolNow/);
    assert.doesNotMatch(note, /recentTxs|headerTipMs|lastPoolSealAt|\.header/);
    const render = sliceFn(page, 'renderPoolFindClock');
    assert.match(render, /poolLastBlockAgeMs\(at, clientNow, poolClockOffsetMs\)/);
    assert.doesNotMatch(render, /Date\.now\(\) - /);
    assert.doesNotMatch(page, /lastPoolSealAt|headerTipMs|networkTipSealAt/);
    assert.match(page, /paintLastBlock\(s\)/);
    assert.doesNotMatch(page, /boxDue\('last'/);
    assert.match(page, /renderPoolFindClock\(Date\.now\(\)\)/);
    const paint = sliceFn(page, 'paint');
    assert.ok(paint.indexOf('paintLastBlock(s)') > 0);
    assert.equal(paint.includes("boxDue('last'"), false);
  });

  it('a seal publishes lastFoundAt on the stats snapshot before the next refresh', () => {
    const a = poolSrc.indexOf('stats.lastFoundAt = Date.now()');
    const b = poolSrc.indexOf('if (session) session.blocks', a);
    assert.ok(a > 0 && b > a);
    const seal = poolSrc.slice(a, b);
    assert.ok(seal.indexOf('paintStatsSnap()') > seal.lastIndexOf('stats.lastFoundAt = Date.now()'));
    assert.match(poolSrc, /lastFoundAt: stats\.lastFoundAt \|\| 0,\s*poolNow: now,/);
    assert.equal(/stats\.lastFoundAt = sealed\?\.header/.test(poolSrc), false);
  });

  it('stats the page polls age a fresh find from the pool clock, not the client clock', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-find-clock-'));
    const id = newIdentity();
    const dest = freshStealthDest(id).dest;
    const pool = createPool({
      dataDir: dir,
      stratumPort: 0,
      httpPort: 0,
      miner: dest,
      shareBits: 8,
      bits: 16,
    });
    try {
      const foundAt = Date.now();
      pool.stats.lastFoundAt = foundAt;
      pool.paintStatsSnap();
      await new Promise((resolve, reject) => {
        pool.httpServer.once('error', reject);
        pool.httpServer.listen(0, '127.0.0.1', resolve);
      });
      const httpPort = pool.httpServer.address().port;
      const stats = await fetch(`http://127.0.0.1:${httpPort}/api/stats`).then((r) => r.json());
      assert.equal(stats.lastFoundAt, foundAt);
      assert.ok(Number(stats.poolNow) >= foundAt);
      const pollDelayMs = 60_000;
      const clientNow = stats.poolNow + pollDelayMs;
      const offset = api.poolFindClockOffsetMs(stats.poolNow, clientNow);
      const age = api.poolLastBlockAgeMs(stats.lastFoundAt, clientNow, offset);
      assert.equal(Math.floor(age / 1000), 0, `age ${age} must not include poll delay ${pollDelayMs}`);
      assert.equal(api.fmtSinceBlock(age), '00:00:00');
      assert.ok(clientNow - stats.lastFoundAt >= pollDelayMs);
      const counted = api.poolLastBlockAgeMs(stats.lastFoundAt, clientNow + 2_000, offset);
      assert.ok(counted >= 2_000 && counted < 3_000);
      assert.equal(api.fmtSinceBlock(counted), '00:00:02');
    } finally {
      pool.close();
    }
  });
});
