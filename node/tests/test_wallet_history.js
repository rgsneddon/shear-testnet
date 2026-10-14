import { EventEmitter } from 'node:events';
import http from 'node:http';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { newIdentity, spendDestOf, hash20FromAddress, destOpeningFromView } from '../../crypto/address.js';
import { sealCoinbaseNote, noteCommitOfDest20 } from '../../crypto/note.js';
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
  it('serves no history route; the owner finds its notes by noteCommit in compact blocks', async () => {
    const alice = newIdentity();
    const bob = newIdentity();
    const mine = spendDestOf(alice.spendPub);
    const other = spendDestOf(bob.spendPub);
    const mineOpen = destOpeningFromView(alice.viewKey, alice.spendPub);
    const bobOpen = destOpeningFromView(bob.viewKey, bob.spendPub);
    const mineNote = sealCoinbaseNote(2 * NANOS_PER_SHE, {
      dest20: hash20FromAddress(mine),
      kind: 'pot',
    });
    const hashNote = sealCoinbaseNote(256, {
      dest20: hash20FromAddress(mine),
      kind: 'hash',
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
      txs: [{ coinbase: true, vout: Array.isArray(vout) ? vout : [vout] }],
    });
    const store = new EventEmitter();
    store.blocks = [
      block(7, [mineNote, hashNote]),
      block(8, young),
      block(200, foreign),
    ];
    store.tip = () => ({ height: 15, header, hash });
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
      // AL-5: history is owner-side. No route returns it, opened or not.
      for (const q of [
        `/api/wallet/history?address=${encodeURIComponent(mine)}`,
        `/api/wallet/history?address=${encodeURIComponent(mine)}&open=${encodeURIComponent(mineOpen)}`,
        `/history?address=${encodeURIComponent(other)}&open=${encodeURIComponent(bobOpen)}`,
        `/gethistory?address=${encodeURIComponent(other)}`,
      ]) {
        const got = await getJson(addr.port, q);
        assert.equal(got.status, 404, q);
        assert.equal(got.json.reason, 'route');
        assert.equal(got.json.txs, undefined);
        assert.equal(got.json.balance, undefined);
        assert.equal(got.json.notes, undefined);
      }
      // The owner scans compact blocks by noteCommit and finds its rows only.
      const want = noteCommitOfDest20(hash20FromAddress(mine)).toString('hex');
      const blocks = (await getJson(addr.port, '/blocks?from=1&to=200')).json.blocks || [];
      const heights = [];
      for (const b of blocks) {
        for (const tx of b.txs || []) {
          for (const o of tx.vout || []) if (o.noteCommit === want) heights.push(Number(b.height));
        }
      }
      assert.deepEqual([...new Set(heights)].sort((x, y) => x - y), [7, 8]);
    } finally {
      await rpc.close();
    }
  });
});
