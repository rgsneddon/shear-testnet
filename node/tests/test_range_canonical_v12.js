import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../src/store.js';
import { verifyBlock, digestTx } from '../src/chain.js';
import { decodeHeader, encodeHeader } from '../../crypto/header.js';
import { merkleRoot } from '../../crypto/merkle.js';
import { sealNote, verifyRange } from '../../crypto/note.js';
import { admitMempool, emptyMempool } from '../../crypto/mempool.js';
import { newIdentity, hash20FromAddress } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';

const RANGE_BITS = 64;
const NEED = 1 + 32 + RANGE_BITS * 32 + RANGE_BITS * 192 + 64;
// Curve25519 L. Adding it to a canonical scalar is the non-canonical twin.
const L = Buffer.from([
  0xed, 0xd3, 0xf5, 0x5c, 0x1a, 0x63, 0x12, 0x58,
  0xd6, 0x9c, 0xf7, 0xa2, 0xde, 0xf9, 0xde, 0x14,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10,
]);

function addL(buf, at) {
  const out = Buffer.from(buf);
  let carry = 0;
  for (let i = 0; i < 32; i += 1) {
    const sum = out[at + i] + L[i] + carry;
    out[at + i] = sum & 0xff;
    carry = sum >> 8;
  }
  assert.equal(carry, 0);
  return out;
}

function who() {
  const id = newIdentity();
  return destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
}

function easyPowHash() {
  const h = Buffer.alloc(32);
  h[4] = 7;
  return h;
}

describe('v12 range proofs are exact length and canonical', () => {
  it('verifyRange and admitMempool reject a malleated proof for any amount', () => {
    const dest = who();
    const amounts = [0, 1, 2_000_000_000, 100_000_000_000];
    for (const amount of amounts) {
      const note = sealNote(amount, { dest20: hash20FromAddress(dest), kind: 'lock' });
      const proof = Buffer.from(note.rangeProof);
      assert.equal(proof.length, NEED, String(amount));
      assert.equal(verifyRange(note.commit, proof), true, String(amount));
      const bad = [
        Buffer.concat([proof, Buffer.from([0])]),
        proof.subarray(0, proof.length - 1),
        addL(proof, NEED - 32),
        addL(proof, 1 + 32 + RANGE_BITS * 32 + 64),
      ];
      for (const pr of bad) {
        assert.equal(verifyRange(note.commit, pr), false, String(amount));
      }
      const tx = (rangeProof) => ({
        kind: 'lock',
        from: dest,
        to: dest,
        nanos: amount,
        fee: 0,
        vin: [{ address: dest }],
        vout: [{ ...note, kind: 'lock', address: dest, rangeProof }],
      });
      const honest = admitMempool(emptyMempool(), tx(proof), { baseFee: 1 });
      assert.notEqual(honest.reason, 'range_proof', JSON.stringify(honest));
      for (const pr of bad) {
        const parked = admitMempool(emptyMempool(), tx(pr), { baseFee: 1 });
        assert.equal(parked.ok, false);
        assert.equal(parked.reason, 'range_proof', String(amount));
      }
    }
  });

  it('verifyBlock rejects a trailing-byte range proof', () => {
    const dest = who();
    const amount = 1;
    const note = sealNote(amount, { dest20: hash20FromAddress(dest), kind: 'lock' });
    const proof = Buffer.from(note.rangeProof);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-range-'));
    const store = createStore(dir);
    const t0 = 1_700_000_000_000;
    const tpl = store.template({ miner: dest, shareBits: 4, now: t0 }).tpl;
    const tx = {
      kind: 'lock',
      from: dest,
      to: dest,
      nanos: amount,
      fee: 0,
      vin: [{ address: dest }],
      vout: [{
        ...note,
        kind: 'lock',
        address: dest,
        rangeProof: Buffer.concat([proof, Buffer.from([1])]),
      }],
    };
    const txs = tpl.txs.concat([tx]);
    const decoded = decodeHeader(Buffer.from(tpl.header));
    decoded.merkleRoot = merkleRoot(txs.map(digestTx));
    const got = verifyBlock({
      header: encodeHeader(decoded),
      txs,
      samples: tpl.samples,
      shareBatch: [],
      miner: dest,
    }, null, {
      trustedPowHash: easyPowHash(),
      skipSharePow: true,
      nowMs: t0,
      genesisMs: t0,
      reserveState: { portals: {}, epochBps: 0 },
    });
    assert.equal(got.ok, false);
    assert.equal(got.reason, 'range_proof');
  });
});
