import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { encodeDest } from '../../crypto/address.js';
import { startNode } from '../src/node.js';
import { parseSoloLogin, createSoloStratum } from '../src/solo_stratum.js';
import { createStore } from '../src/node.js';

function destMiner() {
  return encodeDest(Buffer.alloc(20, 5));
}

describe('thin solo stratum', () => {
  it('does not load pool/src/main.js and npm run solo is node --solo', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const soloSrc = fs.readFileSync(path.join(here, '../src/solo_stratum.js'), 'utf8');
    const nodeSrc = fs.readFileSync(path.join(here, '../src/node.js'), 'utf8');
    const help = fs.readFileSync(path.join(here, '../src/help.js'), 'utf8');
    const pkg = JSON.parse(fs.readFileSync(path.join(here, '../../package.json'), 'utf8'));
    assert.doesNotMatch(soloSrc, /from ['"].*pool\/src/);
    assert.doesNotMatch(nodeSrc, /pool\/src\/main/);
    assert.equal(pkg.scripts.solo, 'node node/src/node.js --solo');
    assert.match(pkg.scripts.pool, /pool\/src\/main/);
    assert.match(help, /npm run solo/);
    assert.match(help, /thin local stratum/);
    assert.doesNotMatch(help, /2\. npm run pool/);
    const dest = destMiner();
    const ok = parseSoloLogin(`${dest}.solo`);
    assert.equal(ok.ok, true);
    assert.equal(ok.dest, dest);
    assert.equal(ok.worker, 'solo');
    assert.equal(parseSoloLogin('not-a-dest.solo').ok, false);
  });

  it('startNode({ solo: true }) boots stratum without pool/main.js', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-solo-'));
    const started = await startNode({
      dataDir: dir,
      p2pPort: 0,
      rpcPort: 0,
      p2pBind: '127.0.0.1',
      seeds: [],
      solo: true,
      stratumPort: 0,
      stratumBind: '127.0.0.1',
    });
    try {
      assert.equal(started.solo, true);
      assert.ok(started.stratumBound?.port > 0);
      const dest = destMiner();
      const sock = net.connect(started.stratumBound.port, '127.0.0.1');
      const reply = await new Promise((resolve, reject) => {
        let buf = '';
        const t = setTimeout(() => reject(new Error('stratum timeout')), 4000);
        sock.on('data', (chunk) => {
          buf += chunk.toString('utf8');
          if (buf.includes('\n')) {
            clearTimeout(t);
            resolve(buf);
          }
        });
        sock.on('error', reject);
        sock.once('connect', () => {
          sock.write(`${JSON.stringify({ method: 'login', params: { login: `${dest}.solo`, threads: 1 } })}\n`);
        });
      });
      sock.destroy();
      const msg = JSON.parse(reply.trim().split('\n')[0]);
      assert.equal(msg.result?.status, 'OK');
      assert.ok(msg.job?.jobId);
      assert.equal(msg.job.shareBind, 'dest');
      const mainJs = fs.readFileSync(new URL('../src/solo_stratum.js', import.meta.url), 'utf8');
      assert.doesNotMatch(mainJs, /sweepAutoPayouts/);
      assert.doesNotMatch(mainJs, /createAdmin/);
    } finally {
      started.p2p.close();
      await started.rpc?.close?.();
    }
  });

  it('createSoloStratum binds loopback and issues a job from the local store', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-solo2-'));
    const store = createStore(dir);
    const stratum = createSoloStratum({ store, port: 0, host: '127.0.0.1' });
    const bound = await stratum.listen();
    try {
      assert.equal(bound.host, '127.0.0.1');
      const dest = destMiner();
      const job = stratum.issueJob(dest);
      assert.ok(job.jobId);
      assert.match(job.header, /^[0-9a-f]+$/i);
    } finally {
      stratum.close();
    }
  });
});
