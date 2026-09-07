import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MAGIC_MAINNET, MAGIC_TESTNET } from '../../crypto/asert.js';
import { HEADER_LEN } from '../../crypto/shear_hash.js';
import { createStore } from '../src/store.js';
import { startNode } from '../src/node.js';

describe('createStore magic', () => {
  it('mainnet store accepts shear-v1 envelopes and rejects shear-testnet-v2', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-store-mn-'));
    const store = createStore(dir, { magic: MAGIC_MAINNET });
    assert.equal(store.magic, MAGIC_MAINNET);
    const header = Buffer.alloc(HEADER_LEN);
    header[0] = 1;
    const reject = store.append({
      header,
      magic: MAGIC_TESTNET,
      txs: [{ coinbase: true }],
    });
    assert.equal(reject.ok, false);
    assert.equal(reject.reason, 'foreign_magic');
    const acceptPath = store.append({
      header,
      magic: MAGIC_MAINNET,
      txs: [{ coinbase: true }],
    });
    assert.notEqual(acceptPath.reason, 'foreign_magic');
    const tn = createStore(fs.mkdtempSync(path.join(os.tmpdir(), 'shear-store-tn-')), { magic: MAGIC_TESTNET });
    const tnRejects = tn.append({
      header,
      magic: MAGIC_MAINNET,
      txs: [{ coinbase: true }],
    });
    assert.equal(tnRejects.reason, 'foreign_magic');
  });

  it('startNode({ network: "mainnet" }) threads shear-v1 into createStore', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-node-mn-'));
    const started = await startNode({
      network: 'mainnet',
      dataDir: dir,
      p2pPort: 0,
      rpcPort: 0,
      seeds: [],
    });
    assert.equal(started.magic, MAGIC_MAINNET);
    assert.equal(started.store.magic, MAGIC_MAINNET);
    const header = Buffer.alloc(HEADER_LEN);
    header[0] = 1;
    const reject = started.store.append({
      header,
      magic: MAGIC_TESTNET,
      txs: [{ coinbase: true }],
    });
    assert.equal(reject.reason, 'foreign_magic');
    started.p2p.close();
    await started.rpc.close();
  });
});
