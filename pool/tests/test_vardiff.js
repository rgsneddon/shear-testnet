import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { newIdentity } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { createPool } from '../src/pool.js';
import {
  clampShareBits,
  expectedOneThreadHs,
  hashesProvenByShare,
  nextShareBits,
  shouldRetargetShare,
  SHARE_VARDIFF_TARGET_MS,
  SHARE_VARDIFF_RETARGET_SHARES,
  SHARE_BITS_V2_START,
} from '../src/share_vardiff.js';

describe('share vardiff', () => {
  it('expected 1-thread H/s is hashes-per-share over the target interval', () => {
    const one = expectedOneThreadHs(12);
    assert.ok(one > 0);
    assert.equal(one, hashesProvenByShare(12) / (SHARE_VARDIFF_TARGET_MS / 1000));
  });

  it('v2 opening share bits is livable at RandomX-lite H/s, not SHA-256 farm scale', () => {
    assert.equal(SHARE_BITS_V2_START, 8);
    const one = expectedOneThreadHs(SHARE_BITS_V2_START);
    assert.ok(one < 10_000, `opening 1-thread H/s ${one} is SHA-256 scale`);
    assert.ok(one > 10);
    assert.ok(expectedOneThreadHs(18) > one);
  });

  it('v2 share interval is slow enough that RandomX verify cannot flood the event loop', () => {
    assert.ok(SHARE_VARDIFF_TARGET_MS >= 2000, SHARE_VARDIFF_TARGET_MS);
  });

  it('never exceeds block bits and never goes below min', () => {
    assert.equal(clampShareBits(24, { blockBits: 21 }), 21);
    assert.equal(clampShareBits(16, { blockBits: 29 }), 16);
    assert.equal(clampShareBits(1, { minBits: 4, blockBits: 8 }), 4);
    assert.equal(clampShareBits(40, { blockBits: 48 }), 40);
    assert.equal(clampShareBits(25, { blockBits: 25 }), 25);
    assert.equal(clampShareBits(300), 256);
  });

  it('raises share bits when shares arrive faster than the session target', () => {
    const next = nextShareBits({
      current: 8,
      actualIntervalMs: 1,
      targetMs: SHARE_VARDIFF_TARGET_MS,
      blockBits: 21,
    });
    assert.ok(next > 8, `expected climb from 8, got ${next}`);
    assert.ok(next <= 21);
  });

  it('does not let share bits fight header bits', () => {
    const next = nextShareBits({
      current: 16,
      actualIntervalMs: 1,
      blockBits: 16,
    });
    assert.equal(next, 16);
  });

  it('retargets after N shares or T milliseconds', () => {
    assert.equal(shouldRetargetShare({ shares: SHARE_VARDIFF_RETARGET_SHARES, elapsedMs: 100 }), true);
    assert.equal(shouldRetargetShare({ shares: 1, elapsedMs: 20_000 }), true);
    assert.equal(shouldRetargetShare({ shares: 1, elapsedMs: 100 }), false);
  });

  it('createPool login job uses v2 opening share bits; submit path retargets from actual interval', async () => {
    const src = fs.readFileSync(new URL('../src/pool.js', import.meta.url), 'utf8');
    assert.match(src, /shouldRetargetShare/);
    assert.match(src, /nextShareBits/);
    assert.match(src, /conn\.shareBits = next/);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-var-'));
    const id = newIdentity();
    const dest = destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
    const pool = createPool({
      dataDir: dir,
      stratumPort: 0,
      httpPort: 0,
      miner: dest,
    });
    await new Promise((resolve, reject) => {
      pool.stratum.listen(0, '127.0.0.1', () => {
        pool.httpServer.listen(0, '127.0.0.1', resolve);
      });
      pool.stratum.on('error', reject);
    });
    const sock = net.connect(pool.stratum.address().port, '127.0.0.1');
    try {
      const job = await new Promise((resolve, reject) => {
        sock.setEncoding('utf8');
        let buf = '';
        sock.on('data', (chunk) => {
          buf += chunk;
          if (!buf.includes('\n')) return;
          const msg = JSON.parse(buf.split('\n')[0]);
          resolve(msg.job || msg.result?.job);
        });
        sock.on('error', reject);
        sock.write(JSON.stringify({
          id: 1,
          method: 'login',
          params: { login: dest + '.var', client: 'ShearHash', threads: 1 },
        }) + '\n');
        setTimeout(() => reject(new Error('login_timeout')), 8000);
      });
      assert.equal(Number(job.shareBits), SHARE_BITS_V2_START);
      assert.ok(Number(job.blockBits) >= Number(job.shareBits));
    } finally {
      sock.end();
      pool.close();
    }
  });
});
