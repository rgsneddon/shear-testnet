import { EventEmitter } from 'node:events';
import http from 'node:http';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { newIdentity, spendDestOf, hash20FromAddress } from '../../crypto/address.js';
import { sealCoinbaseNote } from '../../crypto/note.js';
import { NANOS_PER_SHE } from '../../crypto/asert.js';
import { createRpc } from '../src/rpc.js';

function getJson(port, path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
      });
    }).on('error', reject);
  });
}

describe('wallet history from the book', () => {
  it('lists every sealed note for the dest once and drops a mismatched explorer id', async () => {
    const mine = spendDestOf(newIdentity().spendPub);
    const other = spendDestOf(newIdentity().spendPub);
    const mineNote = sealCoinbaseNote(2 * NANOS_PER_SHE, {
      dest20: hash20FromAddress(mine),
      kind: 'pot',
    });
    const young = sealCoinbaseNote(2252, {
      dest20: hash20FromAddress(mine),
      kind: 'pot',
    });
    const foreign = sealCoinbaseNote(9 * NANOS_PER_SHE, {
      dest20: hash20FromAddress(other),
      kind: 'pot',
    });
    const header = Buffer.alloc(128, 0x11);
    const hash = Buffer.alloc(32, 0x22);
    const block = (height, vout) => ({
      height,
      hash,
      header,
      txs: [{ coinbase: true, vout: [vout] }],
    });
    const store = new EventEmitter();
    store.blocks = [
      block(7, mineNote),
      block(8, young),
      block(200, foreign),
    ];
    store.tip = () => ({ height: 12, header, hash });
    store.historyFor = (address) => (String(address) === mine
      ? [{
          id: `${hash.toString('hex')}-cb-0`,
          kind: 'coinbase',
          from: 'coinbase',
          to: mine,
          nanos: 2 * NANOS_PER_SHE,
          height: 7,
          confirmed: true,
        }]
      : []);
    const rpc = createRpc({ store, port: 0, host: '127.0.0.1' });
    const addr = await rpc.listen();
    try {
      const own = await getJson(addr.port, `/api/wallet/history?address=${encodeURIComponent(mine)}`);
      assert.equal(own.status, 200);
      const txs = own.json.txs;
      assert.equal(txs.length, 2);
      const byHeight = new Map(txs.map((t) => [t.height, t]));
      assert.equal(byHeight.get(7).id, `blockfound:7:${mine}`);
      assert.equal(byHeight.get(7).confirmed, true);
      assert.equal(byHeight.get(7).nanos, 2 * NANOS_PER_SHE);
      assert.equal(byHeight.get(8).id, `blockfound:8:${mine}`);
      assert.equal(byHeight.get(8).confirmed, false);
      assert.equal(byHeight.get(8).nanos, 2252);
      assert.equal(txs.some((t) => String(t.id).includes('-cb-')), false);
      assert.equal(txs.some((t) => t.height === 200), false);
      assert.equal(JSON.stringify(txs).includes(other), false);

      const foreignHist = await getJson(addr.port, `/api/wallet/history?address=${encodeURIComponent(other)}`);
      assert.deepEqual(foreignHist.json.txs.map((t) => t.height), [200]);
      assert.equal(foreignHist.json.txs[0].id, `blockfound:200:${other}`);
      assert.equal(JSON.stringify(foreignHist.json.txs).includes(mine), false);
    } finally {
      await rpc.close();
    }
  });
});
