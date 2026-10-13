import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { newIdentity, destOpeningFromView, spendDestOf, hash20FromAddress } from '../../crypto/address.js';
import { noteCommitOfDest20, sealCoinbaseNote } from '../../crypto/note.js';
import { handleWalletApi } from '../../pool/src/wallet_api.js';
import { createRpc } from '../src/rpc.js';

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

  it('pool notes and node notes return the blob and omit a stand-in', async () => {
    assert.ok(note.rangeProof.length > 64);
    assert.equal(note.rangeProof[0], 2);
    const want = Buffer.from(note.rangeProof).toString('hex');
    const pool = handleWalletApi(
      url(`/api/wallet/notes?address=${encodeURIComponent(dest)}&open=${encodeURIComponent(open)}`),
      'GET',
      {},
      { store },
    );
    assert.equal(pool.status, 200);
    const pooled = pool.json.notes.filter((n) => n.kind === 'pot' && n.rangeProof);
    assert.equal(pooled.length, 1);
    assert.equal(pooled[0].rangeProof, want);
    assert.equal(pool.json.notes.some((n) => n.rangeProof === true), false);
    assert.equal(pool.json.notes.find((n) => n.kind === 'hash').rangeProof, undefined);

    rpc = createRpc({ store, port: 0, host: '127.0.0.1' });
    const addr = await rpc.listen();
    const res = await fetch(
      `http://127.0.0.1:${addr.port}/notes?address=${encodeURIComponent(dest)}&open=${encodeURIComponent(open)}`,
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    const nodePots = body.notes.filter((n) => n.kind === 'pot' && n.rangeProof);
    assert.equal(nodePots.length, 1);
    assert.equal(nodePots[0].rangeProof, want);
    assert.equal(body.notes.some((n) => n.rangeProof === true), false);
    assert.equal(body.notes.find((n) => n.kind === 'hash').rangeProof, undefined);
  });
});
