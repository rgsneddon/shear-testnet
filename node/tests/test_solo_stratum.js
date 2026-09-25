import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { encodeDest } from '../../crypto/address.js';
import { startNode } from '../src/node.js';
import {
  parseSoloLogin,
  createSoloStratum,
  applySoloSubmit,
  soloSubmitAck,
  soloMaySeal,
} from '../src/solo_stratum.js';
import { createStore } from '../src/node.js';
import { setNonce, headerFromHex } from '../../crypto/header.js';
import { shearHash, meetsTarget, setHashBackend } from '../../crypto/shear_hash.js';
import { destBoundShareHash, noteCommitOfShare } from '../../crypto/share_batch.js';
import { SHARE_FLOOR_BITS } from '../../crypto/asert.js';

function destMiner() {
  return encodeDest(Buffer.alloc(20, 5));
}

function minerBin() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const dir = path.join(here, '../../sheark-miner');
  const names = process.platform === 'win32'
    ? ['ShearK-Miner-2.5.exe', 'ShearK-Miner.exe']
    : ['ShearK-Miner'];
  for (const n of names) {
    const p = path.join(dir, n);
    if (fs.existsSync(p)) return p;
  }
  return '';
}

function stripAnsi(s) {
  return String(s || '').replace(/\x1b\[[0-9;]*m/g, '');
}

function killChild(child) {
  if (!child) return;
  try { child.kill(); } catch { /* ignore */ }
  if (child.pid && process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  }
}

function yieldTick() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function findDestShareNotBlock({ headerHex, dest, shareBits, blockBits, max = 400_000n }) {
  const header0 = headerFromHex(headerHex);
  const nc = noteCommitOfShare({ dest });
  for (let nonce = 0n; nonce < max; nonce += 1n) {
    const header = setNonce(header0, nonce);
    const rx = shearHash(header);
    const bound = destBoundShareHash(rx, nc);
    if (meetsTarget(bound, shareBits) && !meetsTarget(rx, blockBits)) {
      return { nonce, hash: rx.toString('hex') };
    }
    if ((nonce & 31n) === 31n) await yieldTick();
  }
  throw new Error('no_share');
}

async function findBlockHit({ headerHex, bits, max = 3_000_000n }) {
  const header0 = headerFromHex(headerHex);
  for (let nonce = 0n; nonce < max; nonce += 1n) {
    const header = setNonce(header0, nonce);
    const rx = shearHash(header);
    if (meetsTarget(rx, bits)) return { nonce, hash: rx.toString('hex') };
    if ((nonce & 31n) === 31n) await yieldTick();
  }
  throw new Error('no_block');
}

function loginSolo(port, dest, shareBits = SHARE_FLOOR_BITS) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1');
    let buf = '';
    const t = setTimeout(() => reject(new Error('login timeout')), 15_000);
    sock.on('error', reject);
    sock.once('connect', () => {
      sock.write(`${JSON.stringify({
        id: 1,
        method: 'login',
        params: { login: `${dest}.solo`, shareBits, threads: 1 },
      })}\n`);
    });
    const onData = (chunk) => {
      buf += chunk.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const raw = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!raw) continue;
        clearTimeout(t);
        sock.off('data', onData);
        let msg;
        try { msg = JSON.parse(raw); } catch (e) { reject(e); return; }
        resolve({ sock, msg });
        return;
      }
    };
    sock.on('data', onData);
  });
}

function submitAndReply(sock, payload, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const t = setTimeout(() => reject(new Error('submit timeout')), timeoutMs);
    const onData = (chunk) => {
      buf += chunk.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const raw = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!raw) continue;
        let msg;
        try { msg = JSON.parse(raw); } catch { continue; }
        if (msg.method === 'job') continue;
        clearTimeout(t);
        sock.off('data', onData);
        resolve(msg);
        return;
      }
    };
    sock.on('data', onData);
    sock.on('error', (err) => {
      clearTimeout(t);
      reject(err);
    });
    sock.write(`${JSON.stringify(payload)}\n`);
  });
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
    const bare = parseSoloLogin(dest);
    assert.equal(bare.ok, true);
    assert.equal(bare.worker, '');
    const ahead = new Map([['peer', { height: 100 }]]);
    assert.equal(soloMaySeal({ height: 70, peers: ahead }), false);
    assert.equal(soloMaySeal({ height: 100, peers: ahead }), true);
    assert.equal(soloMaySeal({ height: 70 }), true);
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

describe('solo submit share vs block', () => {
  setHashBackend('jit-full');

  it('does not import pool and share hits skip submitHeader', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const soloSrc = fs.readFileSync(path.join(here, '../src/solo_stratum.js'), 'utf8');
    assert.doesNotMatch(soloSrc, /from ['"].*pool\/src/);
    assert.match(soloSrc, /applySoloSubmit/);
    assert.match(soloSrc, /evaluateSoloSubmit/);
    assert.match(soloSrc, /soloSubmitAck/);
    assert.match(soloSrc, /BLOCKFOUND/);
    assert.match(soloSrc, /destBoundShareHash/);
    assert.match(soloSrc, /got\?\.ok && got\.block/);
    const poolSrc = fs.readFileSync(path.join(here, '../../pool/src/pool.js'), 'utf8');
    assert.match(poolSrc, /result: \{ status: 'OK', hash: scored\.hash, block: sealedBlock \}/);
  });

  it('soloSubmitAck JSON is block true only after a seal', () => {
    const hash = 'ab'.repeat(32);
    const sealed = JSON.stringify(soloSubmitAck(2, { ok: true, block: true, hash }));
    assert.match(sealed, /"status":"OK"/);
    assert.match(sealed, /"block":true/);
    assert.match(sealed, new RegExp(`"hash":"${hash}"`));
    assert.equal(JSON.parse(sealed).result.block, true);
    const share = JSON.stringify(soloSubmitAck(3, { ok: true, block: false, hash }));
    assert.match(share, /"block":false/);
    assert.doesNotMatch(share, /"block":true/);
    assert.equal(JSON.parse(share).result.block, false);
    const rejected = JSON.stringify(soloSubmitAck(4, {
      ok: false, reason: 'prev', block: true, hash,
    }));
    assert.match(rejected, /"error":"prev"/);
    assert.doesNotMatch(rejected, /"status":"OK"/);
    assert.doesNotMatch(rejected, /"block":true/);
  });

  it('dest-bound shareBits=8 that misses blockBits is OK and does not append', { timeout: 180_000 }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-solo-share-'));
    const store = createStore(dir);
    const stratum = createSoloStratum({ store, port: 0, host: '127.0.0.1', restampMs: 0 });
    const bound = await stratum.listen();
    const dest = destMiner();
    const bin = minerBin();
    assert.ok(bin, 'ShearK-Miner binary required to hash dest-bound shares');
    let child;
    try {
      const heightBefore = store.tip()?.height || 0;
      const nBefore = store.blocks.length;
      child = spawn(bin, [
        '--backend', 'jit',
        '--pool', `127.0.0.1:${bound.port}`,
        '--notls',
        '--user', `${dest}.solo`,
        '--threads', '4',
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', (d) => { out += d.toString(); });
      child.stderr.on('data', (d) => { out += d.toString(); });
      const deadline = Date.now() + 170_000;
      while (Date.now() < deadline) {
        const text = stripAnsi(out);
        if (/accepted=[1-9]/.test(text)) break;
        if (/reject pow/.test(text)) break;
        await new Promise((r) => setTimeout(r, 200));
      }
      const text = stripAnsi(out);
      assert.match(text, /accepted=[1-9]/, text.slice(-800));
      assert.equal(/BLOCKFOUND!!!/.test(text), false, text.slice(-800));
      assert.equal(/reject pow/.test(text), false, text.slice(-800));
      assert.equal(store.tip()?.height || 0, heightBefore);
      assert.equal(store.blocks.length, nBefore);
    } finally {
      killChild(child);
      if (child) await new Promise((r) => child.once('close', r));
      stratum.close();
    }
  });

  it('header hash that meets blockBits appends', { timeout: 300_000 }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-solo-block-'));
    const store = createStore(dir);
    const stratum = createSoloStratum({ store, port: 0, host: '127.0.0.1', restampMs: 0 });
    const bound = await stratum.listen();
    const dest = destMiner();
    let sock;
    try {
      const heightBefore = store.tip()?.height || 0;
      const nBefore = store.blocks.length;
      const logged = await loginSolo(bound.port, dest, SHARE_FLOOR_BITS);
      sock = logged.sock;
      const job = logged.msg.job;
      assert.ok(job?.jobId);
      const found = await findBlockHit({
        headerHex: job.header,
        bits: Number(job.blockBits || job.bits),
        max: 3_000_000n,
      });
      const reply = await submitAndReply(sock, {
        id: 2,
        method: 'submit',
        params: {
          jobId: job.jobId,
          nonce: String(found.nonce),
          hash: found.hash,
        },
      }, 30_000);
      assert.equal(reply.error, undefined, reply.error);
      assert.equal(reply.result?.status, 'OK');
      assert.equal(reply.result?.block, true);
      assert.equal(reply.result?.hash, found.hash);
      assert.equal(store.tip()?.height, heightBefore + 1);
      assert.equal(store.blocks.length, nBefore + 1);
    } finally {
      try { sock?.destroy(); } catch { /* ignore */ }
      stratum.close();
    }
  });

  it('dest-bound share that misses blockBits ACKs block false', { timeout: 180_000 }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-solo-share-ack-'));
    const store = createStore(dir);
    const stratum = createSoloStratum({ store, port: 0, host: '127.0.0.1', restampMs: 0 });
    const bound = await stratum.listen();
    const dest = destMiner();
    let sock;
    try {
      const heightBefore = store.tip()?.height || 0;
      const nBefore = store.blocks.length;
      const logged = await loginSolo(bound.port, dest, SHARE_FLOOR_BITS);
      sock = logged.sock;
      const job = logged.msg.job;
      const found = await findDestShareNotBlock({
        headerHex: job.header,
        dest,
        shareBits: Number(job.shareBits),
        blockBits: Number(job.blockBits || job.bits),
      });
      const reply = await submitAndReply(sock, {
        id: 2,
        method: 'submit',
        params: {
          jobId: job.jobId,
          nonce: String(found.nonce),
          hash: found.hash,
        },
      });
      assert.equal(reply.error, undefined, reply.error);
      assert.equal(reply.result?.status, 'OK');
      assert.equal(reply.result?.block, false);
      assert.equal(reply.result?.hash, found.hash);
      assert.equal(store.tip()?.height || 0, heightBefore);
      assert.equal(store.blocks.length, nBefore);
    } finally {
      try { sock?.destroy(); } catch { /* ignore */ }
      stratum.close();
    }
  });

  it('block-bits hit whose append is rejected is an error, not OK', { timeout: 180_000 }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-solo-seal-fail-'));
    const store = createStore(dir);
    const stratum = createSoloStratum({ store, port: 0, host: '127.0.0.1', restampMs: 0 });
    const bound = await stratum.listen();
    const dest = destMiner();
    let sock;
    try {
      const heightBefore = store.tip()?.height || 0;
      const nBefore = store.blocks.length;
      const logged = await loginSolo(bound.port, dest, SHARE_FLOOR_BITS);
      sock = logged.sock;
      const job = logged.msg.job;
      const found = await findBlockHit({
        headerHex: job.header,
        bits: Number(job.blockBits || job.bits),
        max: 3_000_000n,
      });
      store.submitHeader = () => ({ ok: false, reason: 'prev' });
      const reply = await submitAndReply(sock, {
        id: 2,
        method: 'submit',
        params: {
          jobId: job.jobId,
          nonce: String(found.nonce),
          hash: found.hash,
        },
      });
      assert.equal(reply.error, 'prev');
      assert.notEqual(reply.result?.status, 'OK');
      assert.equal(reply.result, undefined);
      assert.equal(store.tip()?.height || 0, heightBefore);
      assert.equal(store.blocks.length, nBefore);
    } finally {
      try { sock?.destroy(); } catch { /* ignore */ }
      stratum.close();
    }
  });

  it('mismatched claimed hash is rejected and does not append', { timeout: 180_000 }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-solo-badhash-'));
    const store = createStore(dir);
    const stratum = createSoloStratum({ store, port: 0, host: '127.0.0.1', restampMs: 0 });
    const bound = await stratum.listen();
    const dest = destMiner();
    let sock;
    try {
      const nBefore = store.blocks.length;
      const logged = await loginSolo(bound.port, dest, SHARE_FLOOR_BITS);
      sock = logged.sock;
      const job = logged.msg.job;
      const reply = await submitAndReply(sock, {
        id: 2,
        method: 'submit',
        params: {
          jobId: job.jobId,
          nonce: '0',
          hash: '00'.repeat(32),
        },
      });
      assert.ok(reply.error);
      assert.notEqual(reply.error, 'pow');
      assert.equal(reply.error, 'bad_hash');
      assert.notEqual(reply.result?.status, 'OK');
      assert.equal(store.blocks.length, nBefore);
    } finally {
      try { sock?.destroy(); } catch { /* ignore */ }
      stratum.close();
    }
  });

  it('unknown jobId rejects stale_job', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-solo-stale-'));
    const store = createStore(dir);
    const stratum = createSoloStratum({ store, port: 0, host: '127.0.0.1', restampMs: 0 });
    const bound = await stratum.listen();
    const dest = destMiner();
    let sock;
    try {
      const nBefore = store.blocks.length;
      const logged = await loginSolo(bound.port, dest, SHARE_FLOOR_BITS);
      sock = logged.sock;
      const reply = await submitAndReply(sock, {
        id: 2,
        method: 'submit',
        params: {
          jobId: 'shear-not-a-job',
          nonce: '1',
          hash: '00'.repeat(32),
        },
      });
      assert.equal(reply.error, 'stale_job');
      assert.notEqual(reply.result?.status, 'OK');
      assert.equal(store.blocks.length, nBefore);
    } finally {
      try { sock?.destroy(); } catch { /* ignore */ }
      stratum.close();
    }
  });
});
