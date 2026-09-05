import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { newIdentity } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { GENESIS_BITS, LIVE_MIN_BITS, TARGET_BLOCK_INTERVAL_MS } from '../../crypto/asert.js';
import { createPool } from '../src/pool.js';
import { SHARE_BITS_V2_START } from '../src/share_vardiff.js';

describe('testnet blockBits', () => {
  it('genesis and live floor are easier than the old 21-bit hours-per-block default', () => {
    assert.ok(GENESIS_BITS < 21, `GENESIS_BITS ${GENESIS_BITS} is still 21`);
    assert.ok(LIVE_MIN_BITS <= GENESIS_BITS, `floor ${LIVE_MIN_BITS} above genesis ${GENESIS_BITS}`);
    const hashes = 2 ** GENESIS_BITS;
    const secondsAt50 = hashes / 50;
    assert.ok(secondsAt50 < 3600, `~50 H/s would take ${secondsAt50}s at genesis bits ${GENESIS_BITS}`);
    assert.ok(secondsAt50 < 15 * 60, `expected minutes not hours, got ${secondsAt50}s`);
    const targetHashes = 50 * (TARGET_BLOCK_INTERVAL_MS / 1000);
    assert.ok(hashes <= targetHashes * 4, `genesis work ${hashes} is far above 90s at 50 H/s (${targetHashes})`);
    assert.ok(SHARE_BITS_V2_START <= GENESIS_BITS);
  });

  it('createPool login job serves blockBits easier than 21', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-bits-'));
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
          params: { login: dest + '.bits', client: 'ShearHash', threads: 1 },
        }) + '\n');
        setTimeout(() => reject(new Error('login_timeout')), 8000);
      });
      const blockBits = Number(job.blockBits || job.bits);
      const shareBits = Number(job.shareBits);
      assert.ok(Number.isFinite(blockBits) && blockBits > 0);
      assert.ok(blockBits < 21, `login blockBits ${blockBits} is still the too-hard default`);
      assert.equal(blockBits, GENESIS_BITS);
      assert.ok(shareBits <= blockBits);
      assert.equal(shareBits, SHARE_BITS_V2_START);
    } finally {
      sock.end();
      pool.close();
    }
  });
});
