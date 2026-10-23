import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  STORE_CORRUPT_EXIT,
  installNodeGuards,
  isChainStateError,
  isStoreCorruptError,
} from '../src/process_guard.js';

const self = fileURLToPath(import.meta.url);
const guardProbe = process.argv.includes('--guard-probe');

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
  }, mode === 'corrupt' ? 800 : 200);
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
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

if (!guardProbe) describe('process guards', () => {
  it('classifies chain-state and store-corruption by flag or code only', () => {
    assert.equal(isChainStateError(Object.assign(new Error('chain_state:x'), { chainState: true })), true);
    assert.equal(isChainStateError(Object.assign(new Error('datadir_magic:shear-v1'), { code: 'datadir_magic' })), true);
    assert.equal(isChainStateError(Object.assign(new Error('supply_state'), { code: 'supply_state' })), true);
    assert.equal(isChainStateError(new Error('datadir_magic:shear-v1')), false);
    assert.equal(isChainStateError(Object.assign(new Error('nope'), { shearScope: 'request' })), false);
    assert.equal(isChainStateError(new Error('bad_nonce')), false);
    assert.equal(isStoreCorruptError(Object.assign(new Error('book'), { storeCorrupt: true })), true);
    assert.equal(isStoreCorruptError(Object.assign(new Error('book'), { code: 'store_corrupt' })), true);
    assert.equal(isStoreCorruptError(new Error('store_corrupt:book')), false);
    assert.equal(isStoreCorruptError(Object.assign(new Error('chain_state:book'), { chainState: true, code: 'chain_state' })), false);
    assert.equal(isStoreCorruptError(Object.assign(new Error('datadir_magic:shear-v1'), { code: 'datadir_magic' })), false);
  });

  it('stays up on a request or chain-state fault and exits only on store corruption', async () => {
    const request = await runProbe('request');
    assert.equal(request.code, 0, request.stderr);
    assert.match(request.stdout, /alive/);
    assert.match(request.stderr, /SHEAR unhandledRejection/);
    assert.match(request.stderr, /request boom/);
    const chain = await runProbe('chain');
    assert.equal(chain.code, 0, chain.stderr);
    assert.match(chain.stdout, /alive/);
    assert.match(chain.stderr, /chain_state:book/);
    assert.doesNotMatch(chain.stderr, /store-corrupt/);
    const message = await runProbe('message');
    assert.equal(message.code, 0, message.stderr);
    assert.match(message.stdout, /alive/);
    assert.match(message.stderr, /store_corrupt:book/);
    assert.doesNotMatch(message.stderr, /store-corrupt/);
    const corrupt = await runProbe('corrupt');
    assert.equal(corrupt.code, STORE_CORRUPT_EXIT, corrupt.stdout);
    assert.match(corrupt.stderr, /store-corrupt/);
    assert.match(corrupt.stderr, /book bytes diverged/);
    assert.doesNotMatch(corrupt.stdout, /alive/);
  });
});
