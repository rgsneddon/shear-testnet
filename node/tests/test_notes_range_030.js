import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { newIdentity, destOpeningFromView, spendDestOf, hash20FromAddress } from '../../crypto/address.js';
import { noteCommitOfDest20, sealCoinbaseNote } from '../../crypto/note.js';
import { handleWalletApi } from '../../pool/src/wallet_api.js';
import { createRpc } from '../src/rpc.js';
import { compactChainBlock } from '../../crypto/chronoflux.js';

function url(path) {
  return new URL(`http://127.0.0.1${path}`);
}

describe('inbox 030 notes carry the range proof', () => {
  const alice = newIdentity();
  const dest = spendDestOf(alice.spendPub);
  const open = destOpeningFromView(alice.viewKey, alice.spendPub);
  const note = sealCoinbaseNote(7_000_000, {
    dest20: hash20FromAddress(dest),
    kind: 'pot',
  });
  const bare = {
    kind: 'hash',
    noteCommit: noteCommitOfDest20(hash20FromAddress(dest)),
    commit: Buffer.alloc(32, 8),
    valueProof: note.valueProof,
    rEph: Buffer.alloc(32, 5),
    rCt: Buffer.alloc(32, 6),
  };
  const store = {
    blocks: [{
      height: 2,
      hash: Buffer.alloc(32, 3),
      txs: [{
        coinbase: true,
        vout: [note, bare, { ...note, kind: 'pot', rangeProof: true }],
      }],
    }],
  };
  let rpc;

  after(async () => {
    if (rpc) await rpc.close();
  });

  it('the compact block an owner scans carries the blob; a stand-in is never a blob', () => {
    assert.ok(note.rangeProof.length > 64);
    assert.equal(note.rangeProof[0], 2);
    const want = Buffer.from(note.rangeProof).toString('hex');
    const want20 = Buffer.from(noteCommitOfDest20(hash20FromAddress(dest))).toString('hex');
    const row = JSON.parse(JSON.stringify(compactChainBlock(store.blocks[0]), (_k, v) => (
      v && v.type === 'Buffer' && Array.isArray(v.data) ? Buffer.from(v.data).toString('hex') : v
    )));
    const mine = row.txs[0].vout.filter((o) => o.noteCommit === want20);
    const pots = mine.filter((n) => n.kind === 'pot' && n.rangeProof && n.rangeProof !== true);
    assert.equal(pots.length, 1);
    assert.equal(pots[0].rangeProof, want);
    assert.equal(mine.filter((n) => typeof n.rangeProof === 'string').length, 1);
    assert.equal(mine.find((n) => n.kind === 'hash').rangeProof, undefined);
  });

  it('pool and node no longer serve notes by dest (AL-5)', async () => {
    const pool = handleWalletApi(
      url(`/api/wallet/notes?address=${encodeURIComponent(dest)}&open=${encodeURIComponent(open)}`),
      'GET',
      {},
      { store },
    );
    assert.equal(pool.status, 404);
    rpc = createRpc({ store, port: 0, host: '127.0.0.1' });
    const addr = await rpc.listen();
    const res = await fetch(
      `http://127.0.0.1:${addr.port}/notes?address=${encodeURIComponent(dest)}&open=${encodeURIComponent(open)}`,
    );
    assert.equal(res.status, 404);
    assert.equal((await res.json()).notes, undefined);
  });
});
