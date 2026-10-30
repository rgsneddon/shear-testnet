/**
 * Ruling 6 (Russell, 28 Oct): a wallet proves a block body it reads against
 * a header it verified. GET /block?wire=1 serves the p2p frame and, per tx,
 * the core half of the merkle leaf. The wallet hashes the canonical body
 * itself: sha256(domain || core || sha256('shear-tx-body-v2' || canon(body)))
 * must be digestTx of that row, and the leaves must give the header's
 * merkle root. A changed body or a wrong core gives another root.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { encodeDest } from '../../crypto/address.js';
import { createStore } from '../src/store.js';
import { createRpc, wireTxCores } from '../src/rpc.js';
import { decodeHeader } from '../../crypto/header.js';
import { merkleRoot } from '../../crypto/merkle.js';
import { canonicalHash } from '../../crypto/canonical_row.js';
import { decodeWireBlock } from '../src/p2p.js';
import { digestTx } from '../src/chain.js';

let powTag = 1;
function mineOne(store, dest) {
  const parent = store.tip();
  const now = parent
    ? Number(decodeHeader(Buffer.from(parent.header)).timestamp) + 90_000
    : Date.now() - 3_600_000;
  const { tpl } = store.template({ miner: dest, now });
  const pow = Buffer.alloc(32, 0);
  pow[31] = powTag;
  powTag += 1;
  return store.append({
    header: tpl.header,
    txs: tpl.txs,
    samples: tpl.samples,
    miner: dest,
    aLeaves: tpl.aLeaves,
    bLeaves: tpl.bLeaves,
    rootA: tpl.rootA,
    rootB: tpl.rootB,
    weight: tpl.weight,
  }, { trustedPowHash: pow, skipSharePow: true });
}

function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') }));
    }).on('error', reject);
  });
}

/** The wallet's reading of a wire row: {$hex} is bytes, nothing else is revived. */
function walletBody(v) {
  if (Array.isArray(v)) return v.map(walletBody);
  if (v && typeof v === 'object') {
    const keys = Object.keys(v);
    if (keys.length === 1 && keys[0] === '$hex' && /^([0-9a-f]{2})*$/.test(v.$hex)) return Buffer.from(v.$hex, 'hex');
    const out = {};
    for (const k of keys) out[k] = walletBody(v[k]);
    return out;
  }
  return v;
}

function walletLeaf(row, coreHex) {
  const body = walletBody(row);
  if (String(body.kind || '') !== 'withdraw') delete body.id;
  return createHash('sha256')
    .update(Buffer.from('shear-tx-digest-v2'))
    .update(Buffer.from(coreHex, 'hex'))
    .update(canonicalHash('shear-tx-body-v2', body))
    .digest();
}

describe('wire block txCores (ruling 6)', () => {
  it('each wire row and its core give digestTx, and the leaves give the header root', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-wire-core-'));
    const store = createStore(dir);
    const dest = encodeDest(Buffer.alloc(20, 3));
    for (let i = 0; i < 3; i += 1) assert.equal(mineOne(store, dest).ok, true);
    const rpc = createRpc({ store, port: 0, host: '127.0.0.1' });
    const bound = await rpc.listen();
    const base = `http://127.0.0.1:${bound.port}`;
    try {
      for (let h = 1; h <= 3; h += 1) {
        const wired = await get(`${base}/block?height=${h}&wire=1`);
        assert.equal(wired.status, 200);
        assert.equal(wired.json.ok, true);
        const rows = wired.json.txs;
        assert.ok(Array.isArray(rows) && rows.length >= 1, 'a coinbase at least');
        assert.equal(wired.json.txCores.length, rows.length, 'one core per tx');
        const peer = decodeWireBlock(wired.json);
        const leaves = rows.map((row, i) => walletLeaf(row, wired.json.txCores[i]));
        for (let i = 0; i < rows.length; i += 1) {
          assert.ok(leaves[i].equals(digestTx(peer.txs[i])), `h=${h} tx ${i}: the wallet leaf is digestTx`);
        }
        const root = Buffer.from(decodeHeader(Buffer.from(wired.json.header, 'hex')).merkleRoot);
        assert.ok(merkleRoot(leaves).equals(root), `h=${h}: the leaves give the header root`);
        // The cores are the ones the stored block hashes to.
        const stored = store.blocks[h - 1];
        assert.deepEqual(wired.json.txCores, wireTxCores(store.servableBlock ? store.servableBlock(stored).txs : stored.txs));

        // A wrong core is not a pass.
        const badCore = wired.json.txCores.slice();
        badCore[0] = Buffer.alloc(32, 7).toString('hex');
        const withBadCore = rows.map((row, i) => walletLeaf(row, badCore[i]));
        assert.equal(merkleRoot(withBadCore).equals(root), false, 'a wrong core fails the root');

        // A changed output is not a pass, even with the served core.
        const bent = JSON.parse(JSON.stringify(rows));
        const out = bent[0].vout[0];
        const c = Buffer.from(out.commit.$hex, 'hex');
        c[0] ^= 1;
        out.commit = { $hex: c.toString('hex') };
        const withBent = bent.map((row, i) => walletLeaf(row, wired.json.txCores[i]));
        assert.equal(merkleRoot(withBent).equals(root), false, 'a changed output fails the root');
      }
    } finally {
      await rpc.close();
    }
  });
});
