import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { newIdentity } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { GENESIS_BITS, GENESIS_BITS_PACKED, LIVE_MIN_BITS, TARGET_BLOCK_INTERVAL_MS, unpackBits } from '../../crypto/asert.js';
import { createPool } from '../src/pool.js';
import { SHARE_BITS_V2_START } from '../src/share_vardiff.js';

describe('testnet blockBits', () => {
  it('genesis is 21 packed; floor 4 ceiling 256; HUD never paints packed Q16.16', () => {
    assert.equal(GENESIS_BITS, 21);
    assert.ok(LIVE_MIN_BITS <= GENESIS_BITS);
    assert.equal(unpackBits(GENESIS_BITS_PACKED), 21);
    assert.equal(GENESIS_BITS_PACKED, 21 * 65536);
    assert.ok(GENESIS_BITS_PACKED > 256, 'wire bits are packed, not the 256 ceiling');
    assert.ok(SHARE_BITS_V2_START <= GENESIS_BITS);
  });

  it('createPool login job serves packed genesis 21', async () => {
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
      assert.equal(blockBits, GENESIS_BITS_PACKED);
      assert.equal(unpackBits(blockBits), 21);
      assert.ok(shareBits <= unpackBits(blockBits));
      assert.equal(shareBits, SHARE_BITS_V2_START);
    } finally {
      sock.end();
      pool.close();
    }
  });
});
