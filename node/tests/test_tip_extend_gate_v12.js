import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MAGIC_MAINNET, MAGIC_TESTNET } from '../../crypto/reserve_books.js';
import { MAGIC_REGTEST } from '../../crypto/regtest_bits.js';
import {
  P2P_FAIL_DISCONNECT,
  isFinalIngestFail,
  recordIngestFail,
  rejectUnprovenTipExtend,
} from '../src/p2p.js';
import { createStore } from '../src/store.js';
import { createRegtestStore } from './regtest_store.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const driver = path.join(here, 'pow_worker_driver.mjs');
const faultUrl = pathToFileURL(path.join(here, 'fixtures', 'hash_lane_fault.mjs')).href;

function runDriver(fault) {
  const env = { ...process.env, NODE_OPTIONS: `--import=${faultUrl}`, SHEAR_TEST_LANE_FAULT: fault };
  if (fault === 'hang') env.SHEAR_HASH_WORKER_TIMEOUT_MS = '1500';
  const out = spawnSync(process.execPath, [driver], { cwd: repo, env, encoding: 'utf8', timeout: 300_000 });
  assert.equal(out.status, 0, `${fault}: ${out.stderr}`);
  const line = out.stdout.trim().split('\n').pop();
  return JSON.parse(line);
}

function scoredUntilBan(reason) {
  const rec = {};
  for (let i = 1; i <= P2P_FAIL_DISCONNECT + 2; i += 1) {
    if (recordIngestFail(rec, reason)) return { banAt: i, rec };
  }
  return { banAt: 0, rec };
}

function scratch(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), tag));
}

describe('v12 tip-extend header gate', () => {
  it('a healthy lane rejects an invalid tip extension as pow and accepts an honest one', { timeout: 300_000 }, () => {
    const got = runDriver('none');
    assert.equal(got.invalid.ok, false);
    assert.equal(got.invalid.reason, 'pow');
    assert.equal(got.honest.ok, true, got.honest.reason);
    assert.equal(got.tipAfter, got.tipBefore + 1);
    assert.equal(isFinalIngestFail('pow'), true);
    assert.equal(scoredUntilBan('pow').banAt, P2P_FAIL_DISCONNECT);
  });

  for (const fault of ['crash', 'native', 'hang']) {
    it(`a ${fault} hash lane is pow_worker for honest and invalid blocks and never scores the peer`, { timeout: 300_000 }, () => {
      const got = runDriver(fault);
      for (const side of ['invalid', 'honest']) {
        assert.equal(got[side].ok, false, `${fault} ${side}`);
        assert.equal(got[side].reason, 'pow_worker', `${fault} ${side}: ${got[side].reason}`);
      }
      assert.equal(got.tipAfter, got.tipBefore);
      assert.equal(isFinalIngestFail('pow_worker'), false);
      const scored = scoredUntilBan('pow_worker');
      assert.equal(scored.banAt, 0);
      assert.equal(Number(scored.rec.expensiveFails || 0), 0);
    });
  }

  it('the gate uses the book magic, mainnet included', () => {
    const mainnet = createStore(scratch('shear-gate-mainnet-'), { magic: MAGIC_MAINNET });
    assert.equal(mainnet.magic, MAGIC_MAINNET);
    assert.equal(mainnet.tipExtendPowOpts().magic, MAGIC_MAINNET);
    const testnet = createStore(scratch('shear-gate-testnet-'));
    assert.equal(testnet.tipExtendPowOpts().magic, MAGIC_TESTNET);
    const regtest = createRegtestStore(scratch('shear-gate-regtest-'), { bits: 4 });
    assert.equal(regtest.tipExtendPowOpts().magic, MAGIC_REGTEST);

    const src = fs.readFileSync(new URL('../src/p2p.js', import.meta.url), 'utf8');
    const at = src.indexOf('export async function rejectUnprovenTipExtend');
    assert.ok(at >= 0);
    const body = src.slice(at, src.indexOf('\n}\n', at));
    assert.doesNotMatch(body, /MAGIC_TESTNET/);
    assert.match(body, /store\.tipExtendPowReason\(block\)/);
    assert.match(body, /magic: store\.magic/);
  });

  it('rejectUnprovenTipExtend asks the store gate for a mainnet book', async () => {
    const tipHash = Buffer.alloc(32, 0x31);
    const header = Buffer.alloc(128);
    tipHash.copy(header, 4);
    const asked = [];
    const store = {
      magic: MAGIC_MAINNET,
      blocks: [{ hash: tipHash, header: Buffer.alloc(128, 1), height: 1 }],
      tip() { return this.blocks[0]; },
      tipExtendPowReason(block) {
        asked.push({ block, magic: this.magic });
        return Promise.resolve({ applies: true, reason: 'pow' });
      },
    };
    const got = await rejectUnprovenTipExtend(store, { header });
    assert.equal(got.reason, 'pow');
    assert.equal(asked.length, 1);
    assert.equal(asked[0].magic, MAGIC_MAINNET);
  });
});
