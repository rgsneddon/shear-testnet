import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from '../src/store.js';
import { FAULT_EXIT, STORE_CORRUPT_EXIT, installNodeGuards } from '../src/process_guard.js';
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
  const mode = process.argv[process.argv.indexOf('--rpc-chain') + 1] || 'request';
  const store = {
    tip() { return null; },
    on() { return () => {}; },
    reservePinOk() { return true; },
    submitHeader() {
      if (mode === 'corrupt') {
        const err = new Error('book bytes diverged');
        err.storeCorrupt = true;
        err.code = 'store_corrupt';
        throw err;
      }
      if (mode === 'chain') {
        const err = new Error('chain_state:book');
        err.chainState = true;
        err.code = 'chain_state';
        throw err;
      }
      if (mode === 'untagged') throw new Error('untagged boom');
      const err = new Error('request boom');
      err.shearScope = 'request';
      throw err;
    },
  };
  const rpc = createRpc({ store, port: 0, host: '127.0.0.1' });
  const bound = await rpc.listen();
  console.log(JSON.stringify({ port: bound.port }));
  setTimeout(() => {
    console.log('alive');
    process.exit(0);
  }, mode === 'request' ? 1000 : 4000);
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

  async function faultChild(mode) {
    const child = spawn(process.execPath, [self, '--rpc-chain', mode], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c.toString('utf8'); });
    child.stderr.on('data', (c) => { stderr += c.toString('utf8'); });
    const exited = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`rpc ${mode} probe hung\n${stdout}\n${stderr}`));
      }, 8000);
      child.on('exit', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
    const portLine = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no port\n${stdout}\n${stderr}`)), 4000);
      const look = () => {
        const line = stdout.trim().split('\n').find((row) => row.includes('"port"'));
        if (!line) return;
        clearTimeout(timer);
        resolve(line);
      };
      child.stdout.on('data', look);
      look();
    });
    const port = JSON.parse(portLine).port;
    const got = await post(port, '/', JSON.stringify({
      method: 'submitblock',
      params: { jobId: 'job', nonce: '1' },
    }));
    const code = await exited;
    return { got, code, stdout, stderr };
  }

  it('a request-tagged fault returns 500 and the process stays up', async () => {
    const request = await faultChild('request');
    assert.equal(request.got.status, 500);
    assert.equal(request.got.json.ok, false);
    assert.equal(request.got.json.reason, 'internal');
    assert.equal(request.code, 0, request.stderr);
    assert.match(request.stdout, /alive/);
    assert.match(request.stderr, /SHEAR rpc request fault/);
    assert.match(request.stderr, /request boom/);
    assert.doesNotMatch(request.stderr, /SHEAR exit/);
  });

  it('a chain-state fault returns 500 and the process exits', async () => {
    const chain = await faultChild('chain');
    assert.equal(chain.got.status, 500);
    assert.equal(chain.got.json.reason, 'internal');
    assert.equal(chain.code, FAULT_EXIT, chain.stderr);
    assert.match(chain.stderr, /SHEAR rpc chain-state fault/);
    assert.match(chain.stderr, /SHEAR exit chain-state/);
    assert.doesNotMatch(chain.stdout, /alive/);
  });

  it('an untagged fault returns 500 and the process exits', async () => {
    const plain = await faultChild('untagged');
    assert.equal(plain.got.status, 500);
    assert.equal(plain.code, FAULT_EXIT, plain.stderr);
    assert.match(plain.stderr, /SHEAR exit untagged/);
    assert.doesNotMatch(plain.stdout, /alive/);
  });

  it('store corruption returns 500 and exits with its own code', async () => {
    const corrupt = await faultChild('corrupt');
    assert.equal(corrupt.got.status, 500);
    assert.equal(corrupt.got.json.ok, false);
    assert.equal(corrupt.got.json.reason, 'internal');
    assert.equal(corrupt.code, STORE_CORRUPT_EXIT, corrupt.stderr);
    assert.match(corrupt.stderr, /SHEAR rpc store-corrupt/);
    assert.match(corrupt.stderr, /book bytes diverged/);
    assert.match(corrupt.stderr, /SHEAR uncaughtException store-corrupt/);
    assert.doesNotMatch(corrupt.stdout, /alive/);
  });
});
