import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { requiredJobFields } from '../../crypto/header.js';
import { newIdentity } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { createPool, gateJob, scoreShare, admitClient } from '../src/pool.js';
import { publicJob, buildTemplate } from '../../node/src/chain.js';
import { GENESIS_PREV } from '../../node/src/chain.js';

describe('job gate', () => {
  it('refuses a job missing header fields', () => {
    const got = gateJob({ jobId: '1', height: 1 });
    assert.equal(got.ok, false);
    assert.ok(got.missing.includes('header'));
    assert.ok(got.missing.includes('prevBlockHash'));
    assert.ok(got.missing.includes('merkleRoot'));
    assert.ok(got.missing.includes('continuityRoot'));
    assert.ok(got.missing.includes('bits'));
    const shipped = requiredJobFields({ jobId: '1' });
    assert.equal(shipped.ok, false);
  });
});

describe('admit', () => {
  it('admits sdcard1 dest login, refuses rest-frame shear1 and wrong client', () => {
    const id = newIdentity();
    const dest = destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
    assert.equal(admitClient({ login: dest, client: 'ShearHash' }).ok, true);
    assert.equal(admitClient({ login: id.address, client: 'ShearHash' }).ok, false);
    assert.equal(admitClient({ login: dest, client: 'other' }).ok, false);
  });
});

describe('pool dashboard + stratum', () => {
  it('serves light SHE page and accepts a header share on 1111', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-pool-'));
    const id = newIdentity();
    const dest = destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
    const pool = createPool({
      dataDir: dir,
      stratumPort: 0,
      httpPort: 0,
      miner: dest,
      shareBits: 4,
      bits: 8,
    });
    await new Promise((resolve, reject) => {
      pool.stratum.listen(0, '127.0.0.1', () => {
        pool.httpServer.listen(0, '127.0.0.1', resolve);
      });
      pool.stratum.on('error', reject);
    });
    const httpPort = pool.httpServer.address().port;
    const stratumPort = pool.stratum.address().port;
    const html = await fetch(`http://127.0.0.1:${httpPort}/`).then((r) => r.text());
    assert.match(html, /background:var\(--bg\)|#eef3f8/);
    assert.match(html, /color:var\(--ink\)|#0d2137/);
    assert.match(html, />SHE</);
    assert.match(html, /ShearHash/);
    assert.match(html, /:1111/);
    assert.match(html, />SHE</);
    assert.equal(html.toLowerCase().includes('shearhash'), true);
    assert.match(html, /sdcard1/);
    assert.match(html, /YOUR_SDCARD1/);
    assert.match(html, /\/\^sdcard1/);
    assert.equal(html.includes('YOUR_SHEAR1'), false);
    assert.equal(/\/\^shear1/.test(html), false);

    const job = pool.issueJob();
    assert.equal(gateJob(job).ok, true);
    assert.equal(job.header.length, 240);

    const scored = await new Promise((resolve, reject) => {
      const sock = net.connect(stratumPort, '127.0.0.1', () => {
        sock.write(JSON.stringify({
          id: 1,
          method: 'login',
          params: { login: dest + '.rig', client: 'ShearHash', threads: 1 },
        }) + '\n');
      });
      let buf = '';
      sock.on('data', (c) => {
        buf += c.toString();
        if (buf.includes('\n') && buf.includes('job')) {
          const first = JSON.parse(buf.split('\n')[0]);
          const j = first.job || first.params;
          let nonce = 0n;
          let hit = null;
          while (nonce < 200000n) {
            const s = scoreShare({ job: j || job, nonce });
            if (s.ok) { hit = { nonce, s }; break; }
            nonce += 1n;
          }
          if (!hit) {
            sock.destroy();
            reject(new Error('no_share'));
            return;
          }
          sock.write(JSON.stringify({
            id: 2,
            method: 'submit',
            params: { jobId: (j || job).jobId, nonce: String(hit.nonce) },
          }) + '\n');
        }
        if (buf.includes('"status":"OK"') && buf.includes('"hash"')) {
          sock.end();
          resolve(buf);
        }
      });
      sock.on('error', reject);
      setTimeout(() => reject(new Error('timeout')), 20000);
    });
    assert.match(scored, /OK/);
    pool.close();
  });
});
