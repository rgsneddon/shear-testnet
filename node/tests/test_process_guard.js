import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { installNodeGuards, isChainStateError } from '../src/process_guard.js';

const self = fileURLToPath(import.meta.url);
const guardProbe = process.argv.includes('--guard-probe');

if (guardProbe) {
  installNodeGuards();
  const mode = process.argv[process.argv.indexOf('--guard-probe') + 1];
  if (mode === 'request') {
    const err = new Error('request boom');
    err.shearScope = 'request';
    Promise.reject(err);
    setTimeout(() => {
      console.log('alive');
      process.exit(0);
    }, 200);
  } else {
    const err = new Error('chain_state:book');
    err.chainState = true;
    Promise.reject(err);
    setTimeout(() => {
      console.log('alive');
      process.exit(0);
    }, 800);
  }
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
  it('classifies chain-state errors', () => {
    assert.equal(isChainStateError(Object.assign(new Error('chain_state:x'), { chainState: true })), true);
    assert.equal(isChainStateError(new Error('datadir_magic:shear-v1')), true);
    assert.equal(isChainStateError(Object.assign(new Error('nope'), { shearScope: 'request' })), false);
    assert.equal(isChainStateError(new Error('bad_nonce')), false);
  });

  it('logs a request rejection and stays up, and exits on chain-state', async () => {
    const request = await runProbe('request');
    assert.equal(request.code, 0, request.stderr);
    assert.match(request.stdout, /alive/);
    assert.match(request.stderr, /SHEAR unhandledRejection/);
    assert.match(request.stderr, /request boom/);
    const chain = await runProbe('chain');
    assert.equal(chain.code, 1, chain.stdout);
    assert.match(chain.stderr, /chain-state/);
    assert.match(chain.stderr, /chain_state:book/);
    assert.doesNotMatch(chain.stdout, /alive/);
  });
});
