import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MAGIC_TESTNET } from '../../crypto/asert.js';
import { createP2p } from '../src/p2p.js';
import { createRpc } from '../src/rpc.js';
import {
  FAULT_EXIT,
  STORE_CORRUPT_EXIT,
  installNodeGuards,
  isChainStateError,
  isStoreCorruptError,
} from '../src/process_guard.js';

const self = fileURLToPath(import.meta.url);
const guardProbe = process.argv.includes('--guard-probe');
const spread = process.argv.includes('--fault-spread');

function makeFault(kind, detail) {
  const err = new Error(detail);
  if (kind === 'request') err.shearScope = 'request';
  if (kind === 'chain') {
    err.chainState = true;
    err.code = 'chain_state';
  }
  return err;
}

if (guardProbe) {
  installNodeGuards();
  const mode = process.argv[process.argv.indexOf('--guard-probe') + 1];
  if (mode === 'request') {
    const err = new Error('request boom');
    err.shearScope = 'request';
    Promise.reject(err);
  } else if (mode === 'chain') {
    const err = new Error('chain_state:book');
    err.chainState = true;
    err.code = 'chain_state';
    Promise.reject(err);
  } else if (mode === 'message') {
    Promise.reject(new Error('store_corrupt:book'));
  } else {
    const err = new Error('book bytes diverged');
    err.storeCorrupt = true;
    err.code = 'store_corrupt';
    Promise.reject(err);
  }
  setTimeout(() => {
    console.log('alive');
    process.exit(0);
  }, mode === 'request' ? 200 : 800);
}

if (spread) {
  runSpreadChild().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

async function runSpreadChild() {
  const idx = process.argv.indexOf('--fault-spread');
  const source = process.argv[idx + 1];
  const timing = process.argv[idx + 2];
  const kind = process.argv[idx + 3];
  installNodeGuards();
  const err = makeFault(kind, `spread ${source} ${timing} ${kind}`);
  const aliveMs = source === 'rpc' ? 2500 : 800;
  setTimeout(() => {
    console.log('alive');
    process.exit(0);
  }, aliveMs);
  if (source === 'timer') {
    setTimeout(() => {
      if (timing === 'sync') throw err;
      Promise.reject(err);
    }, 20);
    return;
  }
  if (source === 'rpc') {
    const store = {
      tip() { return null; },
      on() { return () => {}; },
      reservePinOk() { return true; },
      submitHeader() {
        if (timing === 'sync') throw err;
        return Promise.reject(err);
      },
    };
    const rpc = createRpc({ store, port: 0, host: '127.0.0.1' });
    const bound = await rpc.listen();
    console.log(JSON.stringify({ port: bound.port }));
    return;
  }
  if (source === 'p2p') {
    const store = {
      blocks: [],
      tip() { return null; },
      on() { return () => {}; },
      offerHeaders() {
        if (timing === 'sync') throw err;
        return { accepted: 0 };
      },
      ingest() {
        return Promise.reject(err);
      },
    };
    const p2p = createP2p({
      store,
      port: 0,
      host: '127.0.0.1',
      magic: MAGIC_TESTNET,
      helloMs: 5000,
      idleMs: 60000,
    });
    const bound = await p2p.listen();
    const sock = net.connect(bound.port, '127.0.0.1');
    sock.on('data', () => {});
    sock.on('error', () => {});
    await new Promise((resolve, reject) => {
      sock.once('connect', resolve);
      sock.once('error', reject);
    });
    const hello = `${JSON.stringify({ type: 'hello', magic: MAGIC_TESTNET })}\n`;
    const faultLine = timing === 'sync'
      ? `${JSON.stringify({
        type: 'headers',
        magic: MAGIC_TESTNET,
        headers: [{ hash: 'ab'.repeat(32), height: 1 }],
      })}\n`
      : `${JSON.stringify({
        type: 'block',
        magic: MAGIC_TESTNET,
        block: {
          header: '11'.repeat(128),
          hash: '22'.repeat(32),
          height: 1,
          txs: [],
        },
      })}\n`;
    sock.write(hello + faultLine);
    return;
  }
  console.error(`unknown source ${source}`);
  process.exit(1);
}

function runProbe(mode) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [self, '--guard-probe', mode], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c.toString('utf8'); });
    child.stderr.on('data', (c) => { stderr += c.toString('utf8'); });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`probe ${mode} hung\n${stdout}\n${stderr}`));
    }, 4000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function postRpc(port) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify({
      method: 'submitblock',
      params: { jobId: 'job', nonce: '1' },
    }));
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': payload.length,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') });
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function runSpread(source, timing, kind) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [self, '--fault-spread', source, timing, kind], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c.toString('utf8'); });
    child.stderr.on('data', (c) => { stderr += c.toString('utf8'); });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`spread ${source} ${timing} ${kind} hung\n${stdout}\n${stderr}`));
    }, 8000);
    let httpResult = null;
    let exitCode = null;
    let httpDone = source !== 'rpc';
    const finish = () => {
      if (exitCode == null || !httpDone) return;
      clearTimeout(timer);
      resolve({ code: exitCode, stdout, stderr, httpResult });
    };
    if (source === 'rpc') {
      const look = () => {
        const line = stdout.trim().split('\n').find((row) => row.includes('"port"'));
        if (!line) return;
        child.stdout.off('data', look);
        const port = JSON.parse(line).port;
        postRpc(port).then((got) => {
          httpResult = got;
          httpDone = true;
          finish();
        }).catch((err) => {
          child.kill();
          reject(err);
        });
      };
      child.stdout.on('data', look);
    }
    child.on('close', (code) => {
      exitCode = code;
      finish();
    });
  });
}

if (!guardProbe && !spread) describe('process guards', () => {
  it('classifies chain-state and store-corruption by flag or code only', () => {
    assert.equal(isChainStateError(Object.assign(new Error('chain_state:x'), { chainState: true })), true);
    assert.equal(isChainStateError(Object.assign(new Error('datadir_magic:shear-v1'), { code: 'datadir_magic' })), true);
    assert.equal(isChainStateError(Object.assign(new Error('supply_state'), { code: 'supply_state' })), true);
    assert.equal(isChainStateError(Object.assign(new Error('spent_checkpoint'), { code: 'spent_checkpoint' })), true);
    assert.equal(isChainStateError(Object.assign(new Error('book_seal'), { code: 'book_seal' })), true);
    assert.equal(isChainStateError(new Error('datadir_magic:shear-v1')), false);
    assert.equal(isChainStateError(Object.assign(new Error('nope'), { shearScope: 'request' })), false);
    assert.equal(isChainStateError(new Error('bad_nonce')), false);
    assert.equal(isStoreCorruptError(Object.assign(new Error('book'), { storeCorrupt: true })), true);
    assert.equal(isStoreCorruptError(Object.assign(new Error('book'), { code: 'store_corrupt' })), true);
    assert.equal(isStoreCorruptError(new Error('store_corrupt:book')), false);
    assert.equal(isStoreCorruptError(Object.assign(new Error('chain_state:book'), { chainState: true, code: 'chain_state' })), false);
    assert.equal(isStoreCorruptError(Object.assign(new Error('datadir_magic:shear-v1'), { code: 'datadir_magic' })), false);
  });

  it('stays up only on a request-tagged fault and exits on chain-state and untagged faults', async () => {
    const request = await runProbe('request');
    assert.equal(request.code, 0, request.stderr);
    assert.match(request.stdout, /alive/);
    assert.match(request.stderr, /SHEAR unhandledRejection request/);
    assert.match(request.stderr, /request boom/);
    assert.doesNotMatch(request.stderr, /SHEAR exit/);
    const chain = await runProbe('chain');
    assert.equal(chain.code, FAULT_EXIT, chain.stdout + chain.stderr);
    assert.match(chain.stderr, /SHEAR unhandledRejection chain-state/);
    assert.match(chain.stderr, /SHEAR exit chain-state/);
    assert.match(chain.stderr, /chain_state:book/);
    assert.doesNotMatch(chain.stdout, /alive/);
    const message = await runProbe('message');
    assert.equal(message.code, FAULT_EXIT, message.stdout + message.stderr);
    assert.match(message.stderr, /SHEAR unhandledRejection untagged/);
    assert.match(message.stderr, /SHEAR exit untagged/);
    assert.match(message.stderr, /store_corrupt:book/);
    assert.doesNotMatch(message.stderr, /store-corrupt/);
    assert.doesNotMatch(message.stdout, /alive/);
    const corrupt = await runProbe('corrupt');
    assert.equal(corrupt.code, STORE_CORRUPT_EXIT, corrupt.stdout + corrupt.stderr);
    assert.match(corrupt.stderr, /store-corrupt/);
    assert.match(corrupt.stderr, /SHEAR exit store-corrupt/);
    assert.match(corrupt.stderr, /book bytes diverged/);
    assert.doesNotMatch(corrupt.stdout, /alive/);
  });

  it('exits from rpc, p2p, and timer faults unless the fault is request-tagged', async () => {
    const sources = ['rpc', 'p2p', 'timer'];
    const timings = ['sync', 'async'];
    const kinds = ['request', 'chain', 'untagged'];
    for (const source of sources) {
      for (const timing of timings) {
        for (const kind of kinds) {
          const got = await runSpread(source, timing, kind);
          const label = `${source} ${timing} ${kind}`;
          if (kind === 'request') {
            assert.equal(got.code, 0, `${label}\n${got.stderr}`);
            assert.match(got.stdout, /alive/, label);
            assert.match(got.stderr, /SHEAR \S+ request/, label);
            assert.doesNotMatch(got.stderr, /SHEAR exit/, label);
          } else {
            const exitLabel = kind === 'chain' ? 'chain-state' : 'untagged';
            assert.equal(got.code, FAULT_EXIT, `${label}\n${got.stdout}\n${got.stderr}`);
            assert.match(got.stderr, new RegExp(`SHEAR exit ${exitLabel}`), label);
            assert.doesNotMatch(got.stdout, /alive/, label);
          }
          if (source === 'rpc') {
            assert.equal(got.httpResult?.status, 500, `${label} did not answer 500\n${JSON.stringify(got.httpResult)}`);
          }
        }
      }
    }
  });
});
