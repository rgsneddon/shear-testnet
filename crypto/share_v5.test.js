import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { packShareV5, unpackShareV5, shareRowJson, ENC_SHARE_V5, ENC_SHARE } from './pack.js';
import { noteCommitOfDest20 } from './note.js';
import { encodeDest } from './address.js';
import {
  noteCommitOfShare,
  verifyShareBatch,
  nonceWithShareTarget,
  rememberLiveSharePow,
  clearLiveSharePow,
  unitsForShare,
} from './share_batch.js';

describe('ENC_SHARE v5', () => {
  it('round-trips note_commit || nonce || lz || view_tag; v4 type stays 4', () => {
    const noteCommit = randomBytes(32);
    const packed = packShareV5({ noteCommit, nonce: 9n, lz: 8, viewTag: 0xab });
    assert.equal(packed[12], ENC_SHARE_V5);
    assert.notEqual(ENC_SHARE_V5, ENC_SHARE);
    const row = unpackShareV5(packed);
    assert.equal(row.noteCommit.equals(noteCommit), true);
    assert.equal(row.nonce, 9n);
    assert.equal(row.lz, 8);
    assert.equal(row.viewTag[0], 0xab);
    const noTag = unpackShareV5(packShareV5({ noteCommit, nonce: 1n, lz: 12 }));
    assert.equal(noTag.viewTag, null);
  });

  it('shareRowJson persists note_commit only, never dest20', () => {
    const dest20 = randomBytes(20);
    const dest = encodeDest(dest20);
    const nc = noteCommitOfDest20(dest20);
    const row = shareRowJson({ dest, dest20, noteCommit: nc, nonce: 7n, lz: 8 });
    assert.equal(row.dest, undefined);
    assert.equal(row.dest20, undefined);
    assert.equal(row.noteCommit, nc.toString('hex'));
    assert.equal(row.nonce, '7');
    const wire = JSON.parse(JSON.stringify(row));
    const got = noteCommitOfShare(wire);
    assert.equal(got.length, 32);
    assert.equal(got.equals(nc), true);
    const unstamped = verifyShareBatch({
      parentHeader: Buffer.alloc(128),
      shares: [wire],
      skipPow: true,
    });
    assert.equal(unstamped.ok, false);
    assert.equal(unstamped.reason, 'share_target');
    const stampedNonce = nonceWithShareTarget(7n, 8);
    clearLiveSharePow();
    assert.equal(rememberLiveSharePow(Buffer.alloc(128), stampedNonce, {
      noteCommit: nc,
      shareBits: 8,
      lz: 8,
    }), true);
    const v = verifyShareBatch({
      parentHeader: Buffer.alloc(128),
      shares: [{ ...wire, nonce: stampedNonce.toString(), shareBits: 8, proofSlot: 0 }],
      skipPow: true,
    });
    assert.equal(v.ok, true, v.reason);
    assert.equal(v.units, unitsForShare(8));
    const historic = JSON.parse(JSON.stringify({ noteCommit: '', nonce: '7', lz: 8 }));
    const old = verifyShareBatch({
      parentHeader: Buffer.alloc(128),
      shares: [historic],
      skipPow: true,
    });
    assert.equal(old.ok, false);
    assert.equal(old.reason, 'share_target');
  });
});
