// R28 BluNotes through the real store: a block seated with real shares
// keeps its compact record, a restart reloads it from chain.bin, the paid
// notes join the store's admit set, and the next template names the parent
// record root. Share PoW is real ShearHash-v3 and the store re-hashes it.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { setHashBackend, shearHash, meetsTarget, leadingZeroBits } from '../../crypto/shear_hash.js';
import { setNonce } from '../../crypto/header.js';
import { POOL_FEE_BPS, SHARE_FLOOR_BITS } from '../../crypto/asert.js';
import { pointBytes } from '../../crypto/note.js';
import { admitBasePub, admitPubIndex } from '../../crypto/admit.js';
import { bindNonce, decodeRecord, oneTimeKey, recordRoot, scanPub } from '../../crypto/blunote.js';
import { createStore } from '../src/store.js';

try { setHashBackend('jit'); } catch { /* interpreter */ }

const MINER = 'ssa1qfqhuqrvxe63785jttt6t35fjs8r7heus2zweyv22twndy8mkcyjqs6c03jaql5q64ragqs6hx6drwr4ddddqwre9sv';
const T0 = 1_700_000_000_000;

function wallet() {
  const seed = randomBytes(32);
  return { B: pointBytes(admitBasePub(seed)), Y: scanPub(seed) };
}

function mineShare(owner, header) {
  for (;;) {
    const k = oneTimeKey(owner);
    for (let c = 0; c < 256; c += 1) {
      const nonce = bindNonce(header, k.R, k.P, c, SHARE_FLOOR_BITS);
      const rx = shearHash(setNonce(Buffer.from(header), nonce));
      if (!meetsTarget(rx, SHARE_FLOOR_BITS)) continue;
      return {
        shareR: k.R, shareP: k.P, viewTag: k.tag, nonce, lz: leadingZeroBits(rx),
        shareBits: SHARE_FLOOR_BITS, proofSlot: 0, verifiedHeader: Buffer.from(header),
      };
    }
  }
}

function asBlock(tpl) {
  return {
    header: tpl.header,
    txs: tpl.txs,
    shareBatch: tpl.shareBatch || [],
    aLeaves: tpl.aLeaves,
    bLeaves: tpl.bLeaves,
    rootA: tpl.rootA,
    rootB: tpl.rootB,
    weight: tpl.weight,
  };
}

let powTag = 1;
function pow() {
  const h = Buffer.alloc(32);
  h.writeUInt32LE(powTag++, 4);
  return h;
}

describe('R28 BluNotes in the store', () => {
  it('keeps each record, reloads it, joins the paid notes and binds the parent root', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-r28-store-'));
    const pool = wallet();
    const feeKey = () => {
      const k = oneTimeKey(pool);
      return { R: k.R, P: k.P, viewTag: k.tag };
    };
    try {
      const store = createStore(dir);
      const g = store.template({ miner: MINER, now: T0, feeKey: feeKey(), feeBps: POOL_FEE_BPS });
      let got = await Promise.resolve(store.append(asBlock(g.tpl), { trustedPowHash: pow() }));
      assert.equal(got.ok, true, got.reason);
      const tip1 = store.tip();
      assert.ok(tip1.blunoteRecord, 'genesis keeps its record');
      const miner = wallet();
      const shares = [mineShare(miner, tip1.header), mineShare(miner, tip1.header)];
      const t2 = store.template({ miner: MINER, now: T0 + 90_000, shareBatch: shares, feeKey: feeKey(), feeBps: POOL_FEE_BPS });
      assert.equal(t2.tpl.shareBatch.length, 2);
      assert.equal(Buffer.from(t2.tpl.txs[0].blunote.prev).toString('hex'), recordRoot(Buffer.from(tip1.blunoteRecord, 'hex')).toString('hex'));
      got = await Promise.resolve(store.append(asBlock(t2.tpl), { trustedPowHash: pow() }));
      assert.equal(got.ok, true, got.reason);
      const tip2 = store.tip();
      const rec = decodeRecord(Buffer.from(tip2.blunoteRecord, 'hex'));
      assert.equal(rec.n, 2);
      const winners = rec.winners.map((w) => w.P.toString('hex'));
      assert.ok(winners.length >= 1);
      // The paid notes are in the store's admit set.
      const known = admitPubIndex(store.fluxset());
      for (const p of winners) assert.ok(known.has(p), 'winner note joined the admit set');
      if (typeof store.close === 'function') store.close();
      // Restart: chain.bin brings the records back, and the admit set with them.
      const again = createStore(dir);
      assert.equal(again.tip().height, 2);
      assert.equal(again.tip().blunoteRecord, tip2.blunoteRecord);
      const knownAgain = admitPubIndex(again.fluxset());
      for (const p of winners) assert.ok(knownAgain.has(p), 'winner note reloaded into the admit set');
      // A template on the reloaded tip names the right parent root.
      const t3 = again.template({ miner: MINER, now: T0 + 180_000, feeKey: feeKey(), feeBps: POOL_FEE_BPS });
      assert.equal(Buffer.from(t3.tpl.txs[0].blunote.prev).toString('hex'), recordRoot(Buffer.from(tip2.blunoteRecord, 'hex')).toString('hex'));
      got = await Promise.resolve(again.append(asBlock(t3.tpl), { trustedPowHash: pow() }));
      assert.equal(got.ok, true, got.reason);
      if (typeof again.close === 'function') again.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
