/**
 * 131a: a hidden output does not carry a value opening.
 * Any amount. Coinbase and reserve receipts keep theirs until T21.
 * A send cannot borrow a public kind label to keep the opening.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../src/store.js';
import { digestTx, headerHash } from '../src/chain.js';
import { decodeHeader, encodeHeader } from '../../crypto/header.js';
import { merkleRoot } from '../../crypto/merkle.js';
import { compactTx } from '../../crypto/chronoflux.js';
import { admitMempool, emptyMempool } from '../../crypto/mempool.js';
import { sealNote } from '../../crypto/note.js';
import { freshStealthDest, newIdentity } from '../../crypto/address.js';
import { handleWalletApi } from '../../pool/src/wallet_api.js';

const T0 = 1_700_000_000_000;
const AMOUNTS = [1, 2 ** 20, 2 ** 40];
const HIDDEN = ['send', 'change', 'dummy', 'transfer'];
const PUBLIC_COINBASE = ['pot', 'hash', 'pool-fee', 'finder-fee', 'reserve-fee'];
const PUBLIC_RESERVE = ['lock', 'vote', 'withdraw'];

let powTag = 1;
function easyPowHash() {
  const h = Buffer.alloc(32);
  h[4] = powTag & 0xff;
  h[5] = (powTag >> 8) & 0xff;
  h[6] = (powTag >> 16) & 0xff;
  powTag += 1;
  return h;
}

function asBlock(tpl) {
  return {
    header: tpl.header,
    txs: tpl.txs,
    samples: tpl.samples || [],
    shareBatch: tpl.shareBatch || [],
    miner: tpl.miner,
    aLeaves: tpl.aLeaves,
    bLeaves: tpl.bLeaves,
    rootA: tpl.rootA,
    rootB: tpl.rootB,
    weight: tpl.weight,
  };
}

function withTxs(tpl, txs) {
  const decoded = decodeHeader(Buffer.from(tpl.header));
  decoded.merkleRoot = merkleRoot(txs.map((tx) => digestTx(tx)));
  return asBlock({ ...tpl, header: encodeHeader(decoded), txs });
}

function opening(amount, kind) {
  const note = sealNote(amount, { dest20: Buffer.alloc(20, 4), kind: 'send' });
  assert.ok(note.commit);
  assert.ok(note.valueProof && note.valueProof.R && note.valueProof.z);
  assert.equal(note.valueProof.v, amount);
  if (kind == null) {
    const row = { ...note };
    delete row.kind;
    return row;
  }
  return { ...note, kind };
}

function hiddenTx(kind, amount) {
  return {
    id: `open-${kind || 'none'}-${amount}`,
    kind: 'send',
    vout: [opening(amount, kind)],
  };
}

describe('v12 hidden outputs carry no value opening', () => {
  it('strips the opening from every hidden kind and keeps it on public receipts', () => {
    assert.ok(AMOUNTS.length >= 3);
    assert.ok(AMOUNTS.every((n) => Number.isSafeInteger(n) && n > 0));
    assert.equal(new Set(AMOUNTS).size, AMOUNTS.length);
    for (const amount of AMOUNTS) {
      for (const kind of HIDDEN) {
        const sealed = compactTx(hiddenTx(kind, amount));
        const row = sealed.vout[0];
        assert.equal(Object.prototype.hasOwnProperty.call(row, 'valueProof'), false, kind);
        assert.equal(row.nanos, undefined);
        assert.ok(row.commit);
      }
      const unlabeled = compactTx(hiddenTx(null, amount));
      assert.equal(Object.prototype.hasOwnProperty.call(unlabeled.vout[0], 'valueProof'), false);
      const bare = compactTx({
        kind: 'send',
        vout: [{ kind: 'send', nanos: amount, valueProof: { R: Buffer.alloc(32, 1), z: Buffer.alloc(32, 2), v: amount } }],
      });
      assert.equal(Object.prototype.hasOwnProperty.call(bare.vout[0], 'valueProof'), false);
      for (const kind of PUBLIC_COINBASE) {
        const sealed = compactTx({
          coinbase: true,
          height: 1,
          vout: [opening(amount, kind)],
        });
        assert.equal(sealed.vout[0].valueProof.v, amount, kind);
        assert.ok(sealed.vout[0].valueProof.R);
        assert.ok(sealed.vout[0].valueProof.z);
      }
      for (const kind of PUBLIC_RESERVE) {
        const sealed = compactTx({
          kind,
          vout: [opening(amount, kind), opening(amount, 'send')],
        });
        assert.equal(sealed.vout[0].valueProof.v, amount, kind);
        assert.equal(Object.prototype.hasOwnProperty.call(sealed.vout[1], 'valueProof'), false);
      }
      const borrowed = compactTx({
        kind: 'send',
        vout: [opening(amount, 'pot')],
      });
      assert.equal(Object.prototype.hasOwnProperty.call(borrowed.vout[0], 'valueProof'), false);
    }
  });

  it('rejects the opening on queue, mempool, append, and a fork, for any amount', async () => {
    const id = newIdentity();
    const dest = freshStealthDest(id).dest;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-vopen-'));
    const store = createStore(dir);
    try {
      for (const amount of AMOUNTS) {
        for (const kind of [...HIDDEN, null, 'pot']) {
          const tx = hiddenTx(kind, amount);
          const pooled = admitMempool(emptyMempool(), tx);
          assert.equal(pooled.ok, false);
          assert.equal(pooled.reason, 'value_open');
          const queued = store.queueTx(tx);
          assert.equal(queued.ok, false);
          assert.equal(queued.reason, 'value_open');
          const clean = {
            id: `clean-${kind || 'none'}-${amount}`,
            kind: 'send',
            vout: [(() => {
              const row = opening(amount, kind);
              delete row.valueProof;
              return row;
            })()],
          };
          const cleanQueue = store.queueTx(clean);
          assert.notEqual(cleanQueue.reason, 'value_open');
        }
        const receipt = {
          id: `lock-${amount}`,
          kind: 'lock',
          vout: [opening(amount, 'lock')],
        };
        assert.notEqual(admitMempool(emptyMempool(), receipt).reason, 'value_open');
        const change = {
          id: `lock-change-${amount}`,
          kind: 'lock',
          vout: [opening(amount, 'lock'), opening(amount, 'send')],
        };
        assert.equal(admitMempool(emptyMempool(), change).reason, 'value_open');
      }
      const first = store.template({ miner: dest, shareBits: 4, now: T0 });
      const honest = await Promise.resolve(store.append(asBlock(first.tpl), {
        trustedPowHash: easyPowHash(),
        skipSharePow: true,
      }));
      assert.equal(honest.ok, true, `${honest.reason || ''} ${honest.error || ''}`);
      const tipHeight = store.tip().height;
      const next = store.template({ miner: dest, shareBits: 4, now: T0 + 90_000 });
      const denied = await Promise.resolve(store.append(
        withTxs(next.tpl, [...next.tpl.txs, hiddenTx('send', AMOUNTS[0])]),
        { trustedPowHash: easyPowHash(), skipSharePow: true },
      ));
      assert.equal(denied.ok, false);
      assert.equal(denied.reason, 'value_open');
      assert.equal(store.tip().height, tipHeight);
      const sibling = withTxs(first.tpl, [...first.tpl.txs, hiddenTx('dummy', AMOUNTS[1])]);
      sibling.hash = headerHash(sibling.header);
      const forked = await Promise.resolve(store.ingest([sibling], {
        trustedPowHash: easyPowHash(),
        skipSharePow: true,
      }));
      assert.equal(forked.ok, false);
      assert.equal(forked.reason, 'value_open');
      assert.equal(store.tip().height, tipHeight);
      const url = new URL('http://127.0.0.1/api/wallet/send');
      const note = opening(AMOUNTS[2], 'send');
      const fat = handleWalletApi(url, 'POST', {
        from: dest,
        to: dest,
        amount: 1,
        kind: 'send',
        sig: Buffer.alloc(64, 7).toString('hex'),
        spendPub: Buffer.alloc(32, 8).toString('hex'),
        vin: [{ commit: Buffer.alloc(32, 1) }],
        vout: [note],
        admit_proof: {
          blob: Buffer.from([3, 1]),
          spendTag: Buffer.alloc(32, 2),
          cTilde: Buffer.alloc(32, 3),
        },
      }, { store, miners: new Map(), queueSend: () => { throw new Error('queued'); } });
      assert.equal(fat.status, 400);
      assert.equal(fat.json.reason, 'value_open');
      const row = { ...note };
      delete row.valueProof;
      const quiet = handleWalletApi(url, 'POST', {
        to: dest,
        kind: 'send',
        sig: Buffer.alloc(64, 9).toString('hex'),
        spendPub: Buffer.alloc(32, 8).toString('hex'),
        vin: [{ commit: Buffer.alloc(32, 1) }],
        vout: [row],
        admit_proof: {
          blob: Buffer.from([3, 1]),
          spendTag: Buffer.alloc(32, 4),
          cTilde: Buffer.alloc(32, 5),
        },
      }, { store, miners: new Map(), queueSend: () => { throw new Error('queued'); } });
      assert.notEqual(quiet.json.reason, 'bad_send');
      assert.notEqual(quiet.json.reason, 'value_open');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
