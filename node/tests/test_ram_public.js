import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HIDDEN, publicRecord } from '../../explorer/ram/public_view.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('public explorer fields pass through and hidden or failed reads say hidden on chain', () => {
  assert.equal(HIDDEN, 'hidden on chain');

  const failed = publicRecord(null);
  assert.equal(JSON.stringify(failed).includes('0'), false);
  assert.equal(failed.height, HIDDEN);
  assert.equal(failed.amount, HIDDEN);

  const refused = publicRecord({ ok: false, height: 0, amount: 5, payee: 'ssa1secret' });
  assert.equal(refused.height, HIDDEN);
  assert.equal(refused.amount, HIDDEN);
  assert.equal(refused.payee, HIDDEN);
  assert.equal(JSON.stringify(refused).includes('0'), false);

  const row = publicRecord({
    height: 12,
    hash: 'abc',
    txid: 'tx1',
    nullifier: 'nf',
    output: 'out',
    commitment: 'cm',
    fee: 3,
    emission: 4,
    supply: 5,
    coinbase: true,
    hashBonus: 6,
    difficulty: 7,
    timestamp: 8,
    vault: { state: 'public' },
    mempool: 9,
    pins: ['pin'],
    fingerprint: 'fp',
    amount: 99,
    payee: 'ssa1secret',
    address: 'ssa1secret',
    ip: '1.2.3.4',
    worker: 'rig-a',
    guess: 0,
  });
  assert.equal(row.height, 12);
  assert.equal(row.hash, 'abc');
  assert.equal(row.txid, 'tx1');
  assert.equal(row.nullifier, 'nf');
  assert.equal(row.output, 'out');
  assert.equal(row.commitment, 'cm');
  assert.equal(row.fee, 3);
  assert.equal(row.emission, 4);
  assert.equal(row.supply, 5);
  assert.equal(row.coinbase, true);
  assert.equal(row.hashBonus, 6);
  assert.equal(row.difficulty, 7);
  assert.equal(row.timestamp, 8);
  assert.deepEqual(row.vault, { state: 'public' });
  assert.equal(row.mempool, 9);
  assert.deepEqual(row.pins, ['pin']);
  assert.equal(row.fingerprint, 'fp');
  assert.equal(row.amount, HIDDEN);
  assert.equal(row.payee, HIDDEN);
  assert.equal(row.address, HIDDEN);
  assert.equal(row.ip, HIDDEN);
  assert.equal(row.worker, HIDDEN);
  assert.equal(row.guess, HIDDEN);

  const genesis = publicRecord({ height: 0, hash: 'gen', fee: 0 });
  assert.equal(genesis.height, 0);
  assert.equal(genesis.fee, 0);
  assert.equal(genesis.hash, 'gen');

  const missing = publicRecord({ height: null, hash: 'h' });
  assert.equal(missing.height, HIDDEN);
  assert.equal(missing.hash, 'h');
});

test('staged ram explorer reuses the live chrome and does not replace the live page', () => {
  const html = fs.readFileSync(path.join(root, 'explorer/ram/index.html'), 'utf8');
  const live = fs.readFileSync(path.join(root, 'explorer/explorer.html'), 'utf8');
  assert.match(html, /data-theme="dark"/);
  assert.match(html, /\/shared\/shear-chrome\.css/);
  assert.match(html, /\/shared\/shear-chrome\.js/);
  assert.match(html, /https:\/\/shear\.digital\/css\/saas-dark\.css/);
  assert.match(html, /hidden on chain/);
  assert.match(html, /staged beside the live explorer/);
  assert.match(html, /id="tx-search"/);
  assert.match(html, /id="q"/);
  assert.equal(live.includes('staged beside the live explorer'), false);
  assert.equal(live.includes('explorer/ram/public_view.js'), false);
});
