import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { newIdentity } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { scoreShare, createPool } from '../src/pool.js';
import {
  clampShareBits,
  expectedOneThreadHs,
  hashesProvenByShare,
  nextShareBits,
  shouldRetargetShare,
  SHARE_VARDIFF_TARGET_MS,
  SHARE_VARDIFF_RETARGET_SHARES,
} from '../src/share_vardiff.js';

describe('share vardiff', () => {
  it('expected 1-thread H/s is hashes-per-share over the target interval', () => {
    const one = expectedOneThreadHs(12);
    assert.ok(one > 0);
    assert.equal(one, hashesProvenByShare(12) / (SHARE_VARDIFF_TARGET_MS / 1000));
  });

  it('never exceeds block bits and never goes below min', () => {
    assert.equal(clampShareBits(24, { blockBits: 21 }), 13);
    assert.equal(clampShareBits(16, { blockBits: 29 }), 16);
    assert.equal(clampShareBits(1, { minBits: 4, blockBits: 8 }), 4);
    assert.equal(clampShareBits(40, { blockBits: 48 }), 40);
    assert.ok(clampShareBits(25, { blockBits: 25 }) <= 17);
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
    assert.ok(next < 16);
    assert.equal(next, 8);
  });

  it('retargets after N shares or T milliseconds', () => {
    assert.equal(shouldRetargetShare({ shares: SHARE_VARDIFF_RETARGET_SHARES, elapsedMs: 100 }), true);
    assert.equal(shouldRetargetShare({ shares: 1, elapsedMs: 20_000 }), true);
    assert.equal(shouldRetargetShare({ shares: 1, elapsedMs: 100 }), false);
  });

  it('createPool raises per-session shareBits after fast accepts, capped at block bits', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-var-'));
    const id = newIdentity();
    const dest = destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
    const pool = createPool({
      dataDir: dir,
      stratumPort: 0,
      httpPort: 0,
      miner: dest,
      shareBits: 4,
      bits: 12,
    });
    await new Promise((resolve, reject) => {
      pool.stratum.listen(0, '127.0.0.1', () => {
        pool.httpServer.listen(0, '127.0.0.1', resolve);
      });
      pool.stratum.on('error', reject);
    });
    const port = pool.stratum.address().port;
    const jobs = [];
    const sock = net.connect(port, '127.0.0.1');
    try {
      await new Promise((resolve, reject) => {
        sock.setEncoding('utf8');
        let buf = '';
        let started = false;
        sock.on('data', (chunk) => {
          buf += chunk;
          let idx;
          while ((idx = buf.indexOf('\n')) >= 0) {
            const msg = JSON.parse(buf.slice(0, idx));
            buf = buf.slice(idx + 1);
            const job = msg.job || (msg.method === 'job' ? msg.params : null);
            if (job && job.shareBits != null) jobs.push(job);
            if (!started && job) {
              started = true;
              let found = 0;
              let nonce = 0n;
              while (found < SHARE_VARDIFF_RETARGET_SHARES && nonce < 2_000_000n) {
                const s = scoreShare({ job, nonce });
                if (s.ok) {
                  sock.write(JSON.stringify({
                    id: 10 + found,
                    method: 'submit',
                    params: { jobId: job.jobId, nonce: String(nonce) },
                  }) + '\n');
                  found += 1;
                }
                nonce += 1n;
              }
              if (found < SHARE_VARDIFF_RETARGET_SHARES) {
                reject(new Error('not_enough_shares'));
                return;
              }
            }
            if (jobs.length >= 2) resolve();
          }
        });
        sock.on('error', reject);
        sock.write(JSON.stringify({
          id: 1,
          method: 'login',
          params: { login: dest + '.var', client: 'ShearHash', threads: 1 },
        }) + '\n');
        setTimeout(() => reject(new Error('timeout')), 20000);
      });
      assert.equal(jobs[0].shareBits, 4);
      const later = jobs[jobs.length - 1];
      assert.ok(later.shareBits > 4, `expected climb, got ${later.shareBits}`);
      assert.ok(later.shareBits <= later.blockBits);
      assert.ok(later.shareBits <= 12);
    } finally {
      sock.end();
      pool.close();
    }
  });
});
