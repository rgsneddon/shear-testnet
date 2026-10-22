/**
 * Leaf-vote, withdraw, lock, and an FS-1 spend post three admit-proof keys:
 * blob, cTilde, spendTag. Any other key is unsigned in the mempool and in
 * a block. compactTx rebuilds those three and does not copy the rest.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RESERVE_PROGRAM } from '../../crypto/asert.js';
import { admitMempool, emptyMempool } from '../../crypto/mempool.js';
import { compactTx } from '../../crypto/chronoflux.js';
import { admitKeysRejected } from '../../crypto/spend.js';
import { decodeHeader, encodeHeader } from '../../crypto/header.js';
import { merkleRoot } from '../../crypto/merkle.js';
import { setHashBackend } from '../../crypto/shear_hash.js';
import { newIdentity, encodeDest, destCommitFromSpendPub } from '../../crypto/address.js';
import { GENESIS_BITS_PACKED } from '../../crypto/asert.js';
import { GENESIS_PREV, buildTemplate, digestTx, verifyBlock } from '../src/chain.js';
import { createStore } from '../src/store.js';

try { setHashBackend('jit'); } catch { /* interpreter */ }

const NOW = 1_700_000_000_000;
const PORTAL = 'ab'.repeat(32);
const BANNED = ['t', 'r', 'commit', 'pseudo', 'seed', 'notAWireKey'];

function proof(extra = {}) {
  return {
    blob: Buffer.from([0xf1, 1, 2, 3]),
    cTilde: Buffer.alloc(32, 4),
    spendTag: Buffer.alloc(32, 5),
    ...extra,
  };
}

function body(kind, extraProof) {
  return {
    id: `admit-${kind}`,
    kind,
    programId: RESERVE_PROGRAM,
    portalId: PORTAL,
    nanos: 1,
    fee: 0,
    vin: [],
    vout: [{ kind, nanos: 1, dest20: Buffer.alloc(20, 6) }],
    fs1: Buffer.from([0xf1, 1]),
    admit_proofs: [proof(extraProof)],
  };
}

function minerDest() {
  const id = newIdentity();
  return encodeDest(destCommitFromSpendPub(id.spendPub), id.admitBase);
}

function carry(who, tx) {
  const tpl = buildTemplate({
    prev: GENESIS_PREV,
    height: 1,
    miner: who,
    finderDest: who,
    txs: [],
    bits: GENESIS_BITS_PACKED,
    now: NOW,
  });
  const txs = [tpl.txs[0], tx];
  const decoded = decodeHeader(Buffer.from(tpl.header));
  const header = encodeHeader({
    version: decoded.version,
    prevBlockHash: decoded.prevBlockHash,
    merkleRoot: merkleRoot(txs.map(digestTx)),
    continuityRoot: decoded.continuityRoot,
    timestamp: decoded.timestamp,
    bits: decoded.bits,
    nonce: decoded.nonce,
    baseFee: decoded.baseFee,
  });
  return {
    header,
    txs,
    samples: tpl.samples,
    shareBatch: tpl.shareBatch || [],
    miner: who,
    height: 1,
    weight: tpl.weight,
  };
}

describe('strict admit proof keys', () => {
  const who = minerDest();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-admit-keys-'));
  const store = createStore(dir);

  it('refuses t, r, commit, pseudo, seed, and an unknown key in the mempool and in a block', () => {
    try {
      const clean = body('withdraw');
      assert.equal(admitKeysRejected(clean), null);
      for (const key of BANNED) {
        for (const kind of ['withdraw', 'lock', 'leaf-vote']) {
          const tx = body(kind, { [key]: Buffer.alloc(32, 9) });
          const named = admitKeysRejected(tx);
          assert.equal(named && named.reason, 'unsigned', `${kind} ${key}`);
          const pooled = admitMempool(emptyMempool(), tx, { height: 2 });
          assert.equal(pooled.ok, false, `${kind} ${key} mempool`);
          assert.equal(pooled.reason, 'unsigned', `${kind} ${key} mempool ${pooled.reason}`);
          const queued = store.queueTx(structuredClone(tx));
          assert.equal(queued.ok, false, `${kind} ${key} queue`);
          assert.equal(queued.reason, 'unsigned', `${kind} ${key} queue ${queued.reason}`);
          const block = verifyBlock(carry(who, tx), null, { probeBody: true, magic: 'shear-testnet-v12' });
          assert.equal(block.ok, false, `${kind} ${key} block`);
          assert.equal(block.reason, 'unsigned', `${kind} ${key} block ${block.reason}`);
        }
        const send = {
          id: 'admit-send',
          kind: 'send',
          fee: 0,
          vin: [],
          vout: [],
          fs1: Buffer.from([0xf1, 1]),
          admit_proofs: [proof({ [key]: Buffer.alloc(32, 8) })],
        };
        const pooled = admitMempool(emptyMempool(), send, { height: 2 });
        assert.equal(pooled.ok, false, `send ${key}`);
        assert.equal(pooled.reason, 'unsigned', `send ${key} ${pooled.reason}`);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('compactTx keeps exactly blob, cTilde, and spendTag', () => {
    const tx = body('lock', {
      t: Buffer.alloc(32, 1),
      r: Buffer.alloc(32, 2),
      commit: Buffer.alloc(32, 3),
      pseudo: Buffer.alloc(32, 4),
      seed: Buffer.alloc(32, 5),
      notAWireKey: 1,
      admit_proof: true,
      v: 3,
    });
    const sealed = compactTx(tx);
    const keys = Object.keys(sealed.admit_proofs[0]).sort();
    assert.deepEqual(keys, ['blob', 'cTilde', 'spendTag']);
    assert.equal(admitKeysRejected(sealed), null);
  });
});
