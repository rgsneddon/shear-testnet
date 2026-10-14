/**
 * Grep guard for AMOUNT=confidential. Fails when a plaintext amount field
 * reappears on a public surface: an RPC/explorer route, the wire or disk tx
 * form, or the submit route. The only outputs that may open v are pinned
 * below; adding one needs a consensus sign-off.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sealHiddenNote, sealNote, sealCoinbaseNote } from '../crypto/note.js';
import { compactChainBlock, admitWireTx, COMPACT_TX_KEYS } from '../crypto/chronoflux.js';
import { newIdentity, hash20FromAddress } from '../crypto/address.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

/** Pinned: coinbase payout rows (BLOCKED on T21) and public reserve receipts. */
const OPEN_V_COINBASE_KINDS = ['pot', 'hash', 'pool-fee', 'finder-fee', 'reserve-fee'];
const OPEN_V_RESERVE_KINDS = ['lock', 'vote', 'withdraw', 'pool-withdraw', 'b-spend'];
const AMOUNT_KEYS = new Set(['nanos', 'amount', 'changeNanos', 'v', 'value', 'valueProof', 'R_vp', 'paintedOwedNanos']);

const PUBLIC_SURFACES = [
  'node/src/rpc.js',
  'pool/src/wallet_api.js',
  'node/src/help.js',
];

function plain(x) {
  return JSON.parse(JSON.stringify(x, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
}

function walk(x, visit, at = '') {
  if (Array.isArray(x)) x.forEach((y, i) => walk(y, visit, `${at}[${i}]`));
  else if (x && typeof x === 'object') {
    for (const [k, y] of Object.entries(x)) {
      visit(k, `${at}.${k}`);
      walk(y, visit, `${at}.${k}`);
    }
  }
}

describe('public surfaces name no plaintext amount', () => {
  it('source: no route copies valueProof.v or a per-dest amount into a response', () => {
    const banned = [
      /valueProof\s*\?\s*\{\s*R\s*:/,
      /\bv\s*:\s*o\.valueProof\.v\b/,
      /\bnotesForAddress\b/,
      /\bnoteValueNanos\b/,
      /\bwalletHistoryFor\b/,
      /url\.pathname\s*===\s*'\/api\/wallet\/(notes|balance|history)'/,
      /path\s*===\s*'\/api\/wallet\/(notes|balance|history)'/,
    ];
    for (const f of PUBLIC_SURFACES) {
      const src = read(f);
      for (const re of banned) assert.ok(!re.test(src), `${f} matches ${re}`);
    }
    // The pool's own admin ledger may read spendable; the node RPC answers no one's.
    assert.ok(!/\.spendableNanos\(/.test(read('node/src/rpc.js')), 'rpc.js reads spendableNanos');
  });

  it('source: the help text advertises no amount route', () => {
    assert.ok(!/\/api\/wallet\/(notes|balance|history)/.test(read('node/src/help.js')));
  });

  it('wire: the compact tx key list carries no amount', () => {
    for (const k of COMPACT_TX_KEYS) assert.ok(!AMOUNT_KEYS.has(k), k);
  });

  it('disk + wire: only pinned kinds open v in a compact block', () => {
    const id = newIdentity();
    const d20 = hash20FromAddress(id.address);
    const hidden = sealHiddenNote(10 ** 9, { dest20: d20, kind: 'send', admitBase: id.admitBase });
    delete hidden.r;
    const change = sealHiddenNote(2 ** 32 + 7, { dest20: d20, kind: 'change', admitBase: id.admitBase });
    delete change.r;
    const dummy = sealNote(0, { dest20: Buffer.alloc(20, 5), kind: 'dummy' });
    delete dummy.r;
    const cb = {
      coinbase: true,
      vout: OPEN_V_COINBASE_KINDS.map((kind, i) => {
        const o = sealCoinbaseNote(1000 + i, { dest20: d20, kind });
        delete o.r;
        return o;
      }),
    };
    const send = { id: 's', kind: 'send', fee: 1, vin: [{ dest20: d20 }], vout: [hidden, change, dummy] };
    const block = plain(compactChainBlock({ height: 3, txs: [cb, send] }));
    const wire = plain(admitWireTx(send));
    const leaks = [];
    for (const [label, txs] of [['block', block.txs], ['wire', [wire]]]) {
      for (const tx of txs) {
        walk(tx, (k, p) => {
          if (p.includes('.vout[')) return;
          if (AMOUNT_KEYS.has(k)) leaks.push(`${label} top ${p}`);
        });
        for (const o of tx.vout || []) {
          const kind = String(o.kind || '');
          if (tx.coinbase && OPEN_V_COINBASE_KINDS.includes(kind)) continue;
          if (OPEN_V_RESERVE_KINDS.includes(kind)) continue;
          walk(o, (k, p) => {
            if (k === 'v' && kind === 'dummy' && String(o.valueProof?.v) === '0') return;
            if (k === 'valueProof' && kind === 'dummy' && String(o.valueProof?.v) === '0') return;
            if ((k === 'R' || k === 'z') && kind === 'dummy') return;
            if (AMOUNT_KEYS.has(k)) leaks.push(`${label} ${kind}${p}`);
          });
        }
      }
    }
    assert.deepEqual(leaks, []);
  });
});
