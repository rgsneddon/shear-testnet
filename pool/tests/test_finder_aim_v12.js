/**
 * An unproven fee pushed at the pool does not become the levy.
 * The job a miner hashes has no finder-fee note and no reserve-fee note,
 * for any of these fees and miner counts. Append does not credit the
 * vault fee bank from that push. A body that would verify is a separate
 * proof and is not this file.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { newIdentity } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { SHEARK_MINER_VERSION } from '../../crypto/asert.js';
import { FEE_SPLIT_FINDER_BPS, splitLevy } from '../../crypto/levy.js';
import { coinbaseLevyPays } from '../../node/src/chain.js';
import { configuredFeeIdentity, createPool } from '../src/pool.js';

function minerDest() {
  const id = newIdentity();
  return destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
}

function listen(pool) {
  return new Promise((resolve, reject) => {
    pool.stratum.listen(0, '127.0.0.1', () => {
      pool.httpServer.listen(0, '127.0.0.1', resolve);
    });
    pool.stratum.on('error', reject);
  });
}

function login(pool, dest, localAddress = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const sock = net.connect({
      port: pool.stratum.address().port,
      host: '127.0.0.1',
      localAddress,
    });
    sock.setEncoding('utf8');
    let buf = '';
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error('login_timeout'));
    }, 8000);
    sock.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    sock.on('data', (chunk) => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      clearTimeout(timer);
      let msg;
      try { msg = JSON.parse(buf.slice(0, nl)); } catch (err) {
        sock.destroy();
        reject(err);
        return;
      }
      resolve({ sock, job: msg.job || msg.result?.job || null, error: msg.error || '' });
    });
    sock.write(`${JSON.stringify({
      id: 1,
      method: 'login',
      params: {
        login: `${dest}.finder`,
        client: 'ShearHash',
        version: SHEARK_MINER_VERSION,
        threads: 1,
      },
    })}\n`);
  });
}

describe('finder-fee on the job the finder hashes', () => {
  it('an unproven fee is not minted onto that job and does not credit the vault', async () => {
    const feeTo = configuredFeeIdentity().feeDest;
    const spreads = [
      { fee: 0, count: 2 },
      { fee: 1, count: 2 },
      { fee: 2, count: 1 },
      { fee: 100, count: 7 },
      { fee: (2 ** 20) + 3, count: 3 },
    ];
    for (const row of spreads) {
      const split = splitLevy(row.fee);
      assert.equal(split.finder, Math.floor(row.fee * FEE_SPLIT_FINDER_BPS / 10000));
      assert.equal(split.finder + split.reserve, row.fee);
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-finder-aim-'));
      const pool = createPool({ dataDir: dir, stratumPort: 0, httpPort: 0, miner: feeTo });
      const socks = [];
      try {
        if (row.fee > 0) {
          pool.store.mempool.push({
            id: `levy-${row.fee}-${row.count}`,
            kind: 'b-spend',
            fee: row.fee,
            to: feeTo,
            from: feeTo,
            vin: [],
            vout: [],
          });
        }
        await listen(pool);
        const dests = [];
        for (let i = 0; i < row.count; i += 1) dests.push(minerDest());
        const jobs = [];
        for (let i = 0; i < dests.length; i += 1) {
          const dest = dests[i];
          // This test exercises finder aiming, not the per-IP login cap.
          // Keep each loopback source within the production cap of four.
          const source = `127.0.0.${Math.floor(i / 4) + 1}`;
          const got = await login(pool, dest, source);
          socks.push(got.sock);
          assert.equal(got.error, '', `login ${row.fee} ${got.error}`);
          assert.ok(got.job?.jobId, `job ${row.fee}`);
          jobs.push({ dest, job: got.job });
        }
        for (let i = 0; i < jobs.length; i += 1) {
          const { dest, job } = jobs[i];
          const rec = pool.store.jobs.get(String(job.jobId));
          assert.ok(rec?.tpl, `tpl ${row.fee} ${job.jobId}`);
          const cb = rec.tpl.txs[0];
          const body = (rec.tpl.txs || []).slice(1);
          assert.equal(body.some((tx) => tx && tx.id === `levy-${row.fee}-${row.count}`), false, `fee ${row.fee}`);
          const finderNotes = (cb.vout || []).filter((o) => o.kind === 'finder-fee');
          const reserveNotes = (cb.vout || []).filter((o) => o.kind === 'reserve-fee');
          assert.equal(finderNotes.length, 0, `fee ${row.fee}`);
          assert.equal(reserveNotes.length, 0, `fee ${row.fee}`);
          assert.equal(String(job.jobId).includes('.'), false, job.jobId);
          const included = coinbaseLevyPays(cb, 0);
          assert.equal(included.ok, true, `fee ${row.fee} ${included.reason || ''}`);
          if (row.fee > 0) {
            const named = coinbaseLevyPays(cb, row.fee);
            assert.equal(named.ok, false, `fee ${row.fee}`);
            assert.equal(named.reason, 'levy_split', `fee ${row.fee} ${named.reason || ''}`);
          }
          const pow = Buffer.alloc(32);
          pow[4] = 3;
          pow[5] = i + 1;
          pow[6] = row.count;
          const sealed = await pool.store.submitHeader({
            jobId: job.jobId,
            nonce: 0n,
            miner: dest,
            powHash: pow.toString('hex'),
          }, { trusted: true });
          assert.equal(Number(pool.store.reserveVault.feeBankNanos), 0, `fee ${row.fee} bank ${sealed.reason || 'ok'}`);
          if (sealed.ok) {
            const tip = pool.store.tip();
            const paid = (tip?.txs?.[0]?.vout || []).filter((o) => o.kind === 'finder-fee' || o.kind === 'reserve-fee');
            assert.equal(paid.length, 0, `fee ${row.fee}`);
          }
        }
      } finally {
        for (const sock of socks) {
          try { sock.destroy(); } catch { /* closed */ }
        }
        pool.close();
      }
    }
  });
});
