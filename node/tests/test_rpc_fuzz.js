import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from '../src/store.js';
import { installNodeGuards } from '../src/process_guard.js';
import { createRpc, nonceToU64 } from '../src/rpc.js';

const self = fileURLToPath(import.meta.url);
const chainProbe = process.argv.includes('--rpc-chain');

function post(port, pathname, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(body);
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: pathname,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': payload.length,
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { json = { raw: text }; }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function get(port, pathname) {
  return new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port, path: pathname }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') });
      });
    }).on('error', reject);
  });
}

if (chainProbe) {
  installNodeGuards();
  const store = {
    tip() { return null; },
    on() { return () => {}; },
    reservePinOk() { return true; },
    submitHeader() {
      const err = new Error('chain_state:book');
      err.chainState = true;
      throw err;
    },
  };
  const rpc = createRpc({ store, port: 0, host: '127.0.0.1' });
  const bound = await rpc.listen();
  console.log(JSON.stringify({ port: bound.port }));
  setTimeout(() => process.exit(0), 5000);
}

if (!chainProbe) describe('RPC bad input stays up', () => {
  it('rejects null, non-objects, and a non-u64 submit nonce with 400', async () => {
    assert.equal(nonceToU64('1'), 1n);
    assert.equal(nonceToU64('0'), 0n);
    assert.equal(nonceToU64('18446744073709551615'), 18446744073709551615n);
    assert.equal(nonceToU64('18446744073709551616'), null);
    assert.equal(nonceToU64('-1'), null);
    assert.equal(nonceToU64('1.5'), null);
    assert.equal(nonceToU64('abc'), null);
    assert.equal(nonceToU64(1.5), null);
    assert.equal(nonceToU64(-1), null);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-rpc-fuzz-'));
    const store = createStore(dir);
    const rpc = createRpc({ store, port: 0, host: '127.0.0.1' });
    const bound = await rpc.listen();
    const faults = [];
    const onReject = (err) => faults.push(err);
    process.on('unhandledRejection', onReject);
    try {
      const bodies = [
        ['/', 'null'],
        ['/', '[]'],
        ['/', '"hello"'],
        ['/', '1'],
        ['/', 'true'],
        ['/queuetx', 'null'],
        ['/queuetx', '[]'],
        ['/queuetx', '"nope"'],
        ['/api/wallet/send', 'null'],
        ['/api/wallet/send', '[]'],
        ['/queuetx', JSON.stringify({ tx: null })],
        ['/queuetx', JSON.stringify({ tx: [] })],
      ];
      for (const [pathn, body] of bodies) {
        const got = await post(bound.port, pathn, body);
        assert.equal(got.status, 400, `${pathn} ${body} -> ${got.status} ${JSON.stringify(got.json)}`);
        assert.equal(got.json.ok, false);
        assert.match(got.json.reason, /bad_body|bad_tx/);
      }
      const nonces = ['abc', '-1', '1.5', '18446744073709551616', '-0', '1e2', '', 'true'];
      for (const nonce of nonces) {
        const got = await post(bound.port, '/', JSON.stringify({
          method: 'submitblock',
          params: { jobId: 'missing', nonce },
        }));
        assert.equal(got.status, 400, nonce);
        assert.equal(got.json.ok, false);
        assert.equal(got.json.reason, 'bad_nonce', `${nonce} ${got.json.reason}`);
      }
      const fractional = await post(bound.port, '/', JSON.stringify({
        method: 'submitblock',
        params: { jobId: 'missing', nonce: 1.5 },
      }));
      assert.equal(fractional.status, 400);
      assert.equal(fractional.json.reason, 'bad_nonce');
      const negative = await post(bound.port, '/', JSON.stringify({
        method: 'submitblock',
        params: { jobId: 'missing', nonce: -1 },
      }));
      assert.equal(negative.status, 400);
      assert.equal(negative.json.reason, 'bad_nonce');
      const stats = await get(bound.port, '/stats');
      assert.equal(stats.status, 200);
      assert.equal(stats.json.ok, true);
      assert.equal(faults.length, 0);
    } finally {
      process.off('unhandledRejection', onReject);
      await rpc.close();
    }
  });

  it('a chain-state throw is logged, answered 500, and the process exits', async () => {
    const child = spawn(process.execPath, [self, '--rpc-chain'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c.toString('utf8'); });
    child.stderr.on('data', (c) => { stderr += c.toString('utf8'); });
    const exited = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`rpc chain probe hung\n${stdout}\n${stderr}`));
      }, 8000);
      child.on('exit', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
    const portLine = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no port\n${stdout}\n${stderr}`)), 4000);
      child.stdout.on('data', () => {
        const line = stdout.trim().split('\n').find((row) => row.includes('"port"'));
        if (!line) return;
        clearTimeout(timer);
        resolve(line);
      });
    });
    const port = JSON.parse(portLine).port;
    const got = await post(port, '/', JSON.stringify({
      method: 'submitblock',
      params: { jobId: 'job', nonce: '1' },
    }));
    const code = await exited;
    assert.equal(got.status, 500);
    assert.equal(got.json.ok, false);
    assert.equal(got.json.reason, 'internal');
    assert.equal(code, 1, stderr);
    assert.match(stderr, /SHEAR rpc chain-state/);
    assert.match(stderr, /chain_state:book/);
    assert.match(stderr, /SHEAR uncaughtException/);
  });
});
