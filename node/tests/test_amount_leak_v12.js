/**
 * PA 101 amount-leak items AL-1..AL-7. A hidden output names its amount only
 * as C, a range proof, and amtCt to the dest. Vectors spread v over
 * {1, 10^9, 2^32+7, 2^53-1, a round SHE grid value} and the hidden kinds.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  sealHiddenNote, sealNote, sealCoinbaseNote, openNoteAmount, unwrapAmount, verifyRange,
  noteCommitOfDest20, asU8, AMOUNT_CT_BYTES,
} from '../../crypto/note.js';
import { admitBaseScalar } from '../../crypto/admit.js';
import { newIdentity, encodeDest, hash20FromAddress } from '../../crypto/address.js';
import {
  compactTx, admitWireTx, compactChainBlock, valueOpenRejected, amountFieldRejected,
  COMPACT_TX_KEYS, OUTPUT_AMOUNT_KEYS, TX_AMOUNT_KEYS,
} from '../../crypto/chronoflux.js';
import { attachDummyOuts } from '../../crypto/dummy.js';
import { txDigestV3 } from '../../crypto/admit_v3.js';
import { mempoolRow, MEMPOOL_SECRET_KEYS } from '../../crypto/mempool.js';
import { handleWalletApi, AMOUNT_ROUTES, SEND_HINT_KEYS } from '../../pool/src/wallet_api.js';
import { AMOUNT_METHODS, AMOUNT_PATHS } from '../src/rpc.js';
import { NANOS_PER_SHE } from '../../crypto/asert.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const AMOUNTS = [1n, 10n ** 9n, 2n ** 32n + 7n, 2n ** 53n - 1n, 25n * BigInt(NANOS_PER_SHE)];
const HIDDEN_KINDS = ['send', 'change', 'transfer'];
const VAL_V1_KEYS = new Set(['valueProof', 'R_vp', 'z', 'R', 'v']);

function owner() {
  const id = newIdentity();
  const dest20 = hash20FromAddress(id.address);
  return { id, dest20, address: encodeDest(dest20, id.admitBase), x: admitBaseScalar(id.spendSeed) };
}

function hiddenOut(v, kind, who) {
  return sealHiddenNote(v, { dest20: who.dest20, kind, admitBase: who.id.admitBase });
}

function hiddenTx(v, kind, who) {
  const o = hiddenOut(v, kind, who);
  delete o.r;
  return { id: `h-${kind}-${v}`, kind: 'send', fee: 1000, vin: [{ dest20: who.dest20 }], vout: [o] };
}

function plain(x) {
  return JSON.parse(JSON.stringify(x, (_k, val) => (typeof val === 'bigint' ? val.toString() : val)));
}

/** Every key path in a JSON value. */
function keyPaths(x, at = '', out = []) {
  if (Array.isArray(x)) x.forEach((y, i) => keyPaths(y, `${at}[${i}]`, out));
  else if (x && typeof x === 'object') {
    for (const [k, y] of Object.entries(x)) {
      out.push({ key: k, path: `${at}.${k}` });
      keyPaths(y, `${at}.${k}`, out);
    }
  }
  return out;
}

function noAmountKeys(json, label) {
  for (const { key, path: p } of keyPaths(json)) {
    assert.ok(!OUTPUT_AMOUNT_KEYS.includes(key) && !TX_AMOUNT_KEYS.includes(key), `${label}: ${p}`);
    assert.ok(!VAL_V1_KEYS.has(key), `${label}: val-v1 material at ${p}`);
    assert.ok(key !== 'r' && key !== 't', `${label}: blind at ${p}`);
  }
}

describe('AL-1 decoder: a hidden output names no amount', () => {
  const who = owner();
  it('accepts the canonical (C,P,R,vt,amtCt,RP) output', () => {
    for (const v of AMOUNTS) {
      for (const kind of HIDDEN_KINDS) assert.equal(valueOpenRejected(hiddenTx(v, kind, who)), null);
    }
  });
  it('rejects nanos/amount/v/value on a hidden output, present or empty', () => {
    for (const v of AMOUNTS) {
      for (const kind of HIDDEN_KINDS) {
        for (const k of OUTPUT_AMOUNT_KEYS) {
          for (const val of [Number(v), String(v), '', 0]) {
            const tx = hiddenTx(v, kind, who);
            tx.vout[0][k] = val;
            assert.equal(amountFieldRejected(tx)?.reason, 'amount_field', `${kind} ${k}=${val}`);
            assert.equal(valueOpenRejected(tx)?.reason, 'amount_field');
          }
        }
      }
    }
  });
  it('rejects top-level nanos/amount/changeNanos on a hidden-kind tx', () => {
    for (const k of TX_AMOUNT_KEYS) {
      const tx = hiddenTx(10n ** 9n, 'send', who);
      tx[k] = '';
      assert.equal(valueOpenRejected(tx)?.reason, 'amount_field', k);
    }
  });
  it('rejects a valueProof on a hidden output (value_open)', () => {
    for (const v of AMOUNTS) {
      const tx = hiddenTx(v, 'send', who);
      tx.vout[0].valueProof = sealNote(v, { dest20: who.dest20 }).valueProof;
      assert.equal(valueOpenRejected(tx)?.reason, 'value_open');
    }
  });
  it('rejects an amtCt that is not 8 bytes', () => {
    for (const n of [0, 7, 9, 32]) {
      const tx = hiddenTx(1n, 'send', who);
      tx.vout[0].amtCt = Buffer.alloc(n);
      assert.equal(valueOpenRejected(tx)?.reason, 'amount_ct', `len ${n}`);
    }
  });
  it('rejects nanos beside a committed coinbase row', () => {
    const o = sealCoinbaseNote(5000, { dest20: who.dest20, kind: 'pot' });
    const tx = { coinbase: true, vout: [{ ...o, nanos: 5000 }] };
    assert.equal(amountFieldRejected(tx)?.reason, 'amount_field');
    assert.equal(amountFieldRejected({ coinbase: true, vout: [o] }), null);
  });
  it('leaves public-amount kinds alone', () => {
    const tx = { kind: 'lock', vout: [{ kind: 'lock', nanos: 5, dest20: who.dest20 }], nanos: 5 };
    assert.equal(amountFieldRejected(tx), null);
  });
});

describe('AL-2 no shear-note-val-v1 material on hidden outputs', () => {
  const who = owner();
  it('sealHiddenNote carries no valueProof and a valid range proof', () => {
    for (const v of AMOUNTS) {
      for (const kind of HIDDEN_KINDS) {
        const o = hiddenOut(v, kind, who);
        assert.equal(o.valueProof, undefined);
        assert.ok(verifyRange(o.commit, o.rangeProof));
        assert.equal(Buffer.from(asU8(o.amtCt)).length, AMOUNT_CT_BYTES);
      }
    }
  });
  it('the serialised hidden output gives an amount oracle nothing to test', () => {
    for (const v of AMOUNTS) {
      const wire = plain(compactTx(hiddenTx(v, 'send', who)));
      const out = wire.vout[0];
      for (const k of VAL_V1_KEYS) assert.equal(out[k], undefined, k);
    }
  });
  it('flow sends from attachDummyOuts are sealed hidden notes', () => {
    const tx = attachDummyOuts({
      kind: 'send', nanos: 10 ** 9, fee: 1000, from: who.address, to: who.address,
      vin: [{ address: who.address }],
      vout: [{ address: who.address, nanos: 10 ** 9, kind: 'send' }],
    });
    assert.equal(tx.nanos, undefined);
    const send = tx.vout.find((o) => o.kind === 'send');
    assert.equal(send.valueProof, undefined);
    assert.equal(send.nanos, undefined);
    assert.equal(openNoteAmount(send, who.x).v, 10n ** 9n);
  });
  it('coinbase payout rows still open v (BLOCKED on T21; pinned exception)', () => {
    const o = sealCoinbaseNote(5000, { dest20: who.dest20, kind: 'hash' });
    assert.equal(o.valueProof.v, 5000);
  });
});

describe('AL-3 submit takes a serialised tx, never an amount hint', () => {
  const who = owner();
  const url = new URL('http://127.0.0.1/api/wallet/send');
  function sealedBody() {
    const tx = hiddenTx(10n ** 9n, 'send', who);
    return {
      kind: 'send', fee: 10 ** 6, vin: tx.vin,
      vout: plain([...tx.vout, sealNote(0, { dest20: Buffer.alloc(20, 9), kind: 'dummy' })]),
      admit_proof: { admit_proof: true, v: 2 }, sig: 'aa', spendPub: 'bb',
    };
  }
  it('rejects every hint key with send_hint', () => {
    for (const k of SEND_HINT_KEYS) {
      const body = { ...sealedBody(), [k]: k === 'open' ? 'x' : 1 };
      let queued = 0;
      const out = handleWalletApi(url, 'POST', body, { store: {}, miners: new Map(), queueSend() { queued += 1; return { id: 'x' }; } });
      assert.equal(out.status, 400, k);
      assert.equal(out.json.reason, 'send_hint', k);
      assert.equal(queued, 0);
    }
  });
  it('the FS-1 send gate still answers first', () => {
    const body = { ...sealedBody(), nanos: 5, admit_proof: { admit_proof: true, v: 3 } };
    const out = handleWalletApi(url, 'POST', body, { store: {}, miners: new Map(), queueSend() { return { id: 'x' }; } });
    assert.equal(out.json.reason, 'send_unavailable');
  });
  it('a from/to/amount quote is not a send', () => {
    const out = handleWalletApi(url, 'POST', { kind: 'send', from: who.address, to: who.address, amount: 1 }, { store: {}, miners: new Map() });
    assert.equal(out.status, 400);
  });
});

describe('AL-4 wire and disk forms come from the canonical layout', () => {
  const who = owner();
  it('compactTx copies only COMPACT_TX_KEYS', () => {
    const tx = { ...hiddenTx(2n ** 32n + 7n, 'send', who), nanos: 1, amount: 1, changeNanos: 1, secretNote: 'x', paintedOwedNanos: 9 };
    for (const k of Object.keys(compactTx(tx))) assert.ok(COMPACT_TX_KEYS.includes(k), k);
    noAmountKeys(plain(compactTx(tx)), 'compactTx');
    noAmountKeys(plain(admitWireTx({ ...tx, spendPub: Buffer.alloc(32) })), 'admitWireTx');
  });
  it('COMPACT_TX_KEYS names no amount', () => {
    for (const k of [...TX_AMOUNT_KEYS, ...OUTPUT_AMOUNT_KEYS, 'r', 't', 'open', 'paintedOwedNanos']) {
      assert.ok(!COMPACT_TX_KEYS.includes(k), k);
    }
  });
  it('compactChainBlock carries amtCt and no amount for a hidden send', () => {
    const tx = hiddenTx(2n ** 53n - 1n, 'send', who);
    const row = plain(compactChainBlock({ height: 2, txs: [tx] }));
    noAmountKeys(row.txs, 'compactChainBlock');
    assert.ok(row.txs[0].vout[0].amtCt);
  });
});

describe('AL-5 no RPC route returns a per-output amount', () => {
  it('wallet notes/balance/history are gone from the pool API', () => {
    for (const p of AMOUNT_ROUTES) {
      const out = handleWalletApi(new URL(`http://127.0.0.1${p}?address=x&open=y`), 'GET', {}, { store: {}, miners: new Map() });
      assert.equal(out.status, 404, p);
      assert.equal(out.json.reason, 'route');
    }
  });
  it('node RPC refuses the amount methods and paths', () => {
    for (const m of ['getnotes', 'notes', 'getbalance', 'balance', 'gethistory', 'history']) assert.ok(AMOUNT_METHODS.has(m));
    for (const p of ['/notes', '/api/wallet/notes', '/balance', '/api/wallet/balance', '/history', '/api/wallet/history']) {
      assert.ok(AMOUNT_PATHS.has(p), p);
    }
    const src = fs.readFileSync(path.join(ROOT, 'node/src/rpc.js'), 'utf8');
    for (const gone of ['notesForAddress', 'noteValueNanos', 'walletHistoryFor', 'spendableNanos(']) {
      assert.ok(!src.includes(gone), gone);
    }
  });
});

describe('AL-6 the mempool holds the canonical row', () => {
  const who = owner();
  it('drops blinds, openings, and hints from the held row', () => {
    const o = hiddenOut(10n ** 9n, 'send', who);
    const tx = {
      kind: 'send', fee: 1, r: 'aa', t: 'bb', open: 'cc', paintedOwedNanos: 4,
      vin: [{ dest20: who.dest20, r: 'dd', open: 'ee' }], vout: [o],
    };
    const row = mempoolRow(tx, 1, 'send');
    for (const k of MEMPOOL_SECRET_KEYS) {
      assert.equal(row[k], undefined, k);
      assert.equal(row.vin[0][k], undefined, `vin ${k}`);
      assert.equal(row.vout[0][k], undefined, `vout ${k}`);
    }
    assert.ok(o.r, 'caller copy untouched');
    noAmountKeys(plain(row), 'mempoolRow');
  });
});

describe('AL-7 the owner recovers v from amtCt alone', () => {
  it('round-trips every vector and checks C', () => {
    const who = owner();
    for (const v of AMOUNTS) {
      for (const kind of HIDDEN_KINDS) {
        const o = plain(compactTx(hiddenTx(v, kind, who)).vout[0]);
        const got = openNoteAmount(o, who.x);
        assert.equal(got?.v, v, `${kind} ${v}`);
      }
    }
  });
  it('a wrong key or a tampered ciphertext opens nothing', () => {
    const who = owner();
    const other = owner();
    const o = hiddenOut(2n ** 32n + 7n, 'send', who);
    assert.equal(openNoteAmount(o, other.x), null);
    const bad = Buffer.from(asU8(o.amtCt));
    bad[0] ^= 1;
    assert.equal(openNoteAmount({ ...o, amtCt: bad }, who.x), null);
    const extra = Buffer.concat([Buffer.from(asU8(o.noteCommit)), Buffer.from(asU8(o.commit))]);
    assert.notEqual(unwrapAmount(o.rEph, o.amtCt, other.x, extra), 2n ** 32n + 7n);
  });
  it('txDigestV3 binds amtCt, and is unchanged without it', () => {
    const who = owner();
    const tx = hiddenTx(10n ** 9n, 'send', who);
    const d0 = txDigestV3(tx);
    const flipped = Buffer.from(asU8(tx.vout[0].amtCt));
    flipped[3] ^= 0x80;
    const d1 = txDigestV3({ ...tx, vout: [{ ...tx.vout[0], amtCt: flipped }] });
    assert.notDeepEqual(Buffer.from(d0), Buffer.from(d1));
    const bare = { ...tx.vout[0] };
    delete bare.amtCt;
    const d2 = txDigestV3({ ...tx, vout: [bare] });
    const d3 = txDigestV3({ ...tx, vout: [{ ...bare, amtCt: '' }] });
    assert.deepEqual(Buffer.from(d2), Buffer.from(d3));
    assert.equal(noteCommitOfDest20(who.dest20).length, 32);
  });
});
