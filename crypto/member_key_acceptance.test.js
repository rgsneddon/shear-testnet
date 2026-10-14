/**
 * Node acceptance of FS-1 membership rows. An unknown members[] key, a
 * body-secret name, or a members value that is not an array is unsigned.
 * Stage 0 still rejects a v3 flow send before that check. Ships at genesis
 * or as a coordinated upgrade, never rolling. This file does not skip.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GENESIS_BITS_PACKED } from './asert.js';
import { encodeHeader } from './header.js';
import { merkleRoot } from './merkle.js';
import { emptyMempool, admitMempool } from './mempool.js';
import { BODY_SECRET_KEYS, MEMBER_KEYS, unsignedBodyField } from './spend.js';
import { createStore } from '../node/src/store.js';
import { GENESIS_PREV, digestTx, verifyBlock, verifyLoadedChain } from '../node/src/chain.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const WHEN = 1_700_000_000_000;

function dartMemberKeys() {
  const ledger = fs.readFileSync(path.join(root, 'wallet/lib/shear_ledger.dart'), 'utf8');
  const match = ledger.match(/postedMemberKeys = <String>\{([^}]+)\}/);
  assert.ok(match, 'postedMemberKeys missing');
  return new Set(match[1].match(/'([^']+)'/g).map((quoted) => quoted.slice(1, -1)));
}

function row() {
  return { commit: 'aa', hash: 'bb', side: 'L', anchor: 'cc', root: 'dd' };
}

function v3Send(extra = {}) {
  const blob = Buffer.alloc(160, 9);
  blob[0] = 3;
  const tag = Buffer.from(blob.subarray(1, 33));
  const cTilde = Buffer.alloc(32, 5);
  return {
    id: 'gated-send',
    kind: 'send',
    nanos: 1,
    fee: 0,
    anchor: 8,
    vin: [{ commit: cTilde }],
    vout: [{ kind: 'send', nanos: 1 }],
    admit_proof: { v: 3, blob, spendTag: tag, cTilde },
    spendTag: tag,
    ...extra,
  };
}

function reloadBlock(tx) {
  const coinbase = { coinbase: true, kind: 'coinbase' };
  const txs = [coinbase, tx];
  const header = encodeHeader({
    prevBlockHash: GENESIS_PREV,
    merkleRoot: merkleRoot(txs.map(digestTx)),
    continuityRoot: Buffer.alloc(32),
    timestamp: WHEN,
    bits: GENESIS_BITS_PACKED,
  });
  return {
    height: 1,
    header,
    hash: Buffer.alloc(32, 1),
    txs,
  };
}

describe('FS-1 member key acceptance', () => {
  it('MEMBER_KEYS matches the wallet postedMemberKeys allow-list', () => {
    assert.deepEqual(dartMemberKeys(), MEMBER_KEYS);
    for (const secret of ['t', 'r', 'opening', 'seed', 'spendSeed', 'blind', 'alpha', 'gamma', ...BODY_SECRET_KEYS]) {
      assert.equal(MEMBER_KEYS.has(secret), false, secret);
    }
  });

  it('an unknown member key is unsigned and the allow-listed row is not', () => {
    assert.equal(unsignedBodyField({ members: [row()] }), null);
    assert.equal(unsignedBodyField({ members: [] }), null);
    assert.equal(unsignedBodyField({ admit_proof: { v: 1, members: [row()] } }), null);
    const nested = unsignedBodyField({
      admit_proof: { v: 3, members: [{ commit: 'aa', blind: 'ee' }] },
    });
    assert.equal(nested && nested.reason, 'unsigned');
    const top = unsignedBodyField({
      members: [{ side: 'L', hash: 'bb', gamma: 'ff' }],
    });
    assert.equal(top && top.reason, 'unsigned');
  });

  it('admit_proofs[i].members rejects an unknown key and keeps a clean sibling', () => {
    assert.equal(unsignedBodyField({
      admit_proofs: [
        { v: 1, members: [row()] },
        { v: 1, members: [row()] },
      ],
    }), null);
    const second = unsignedBodyField({
      admit_proofs: [
        { v: 1, members: [row()] },
        { v: 1, members: [{ commit: 'aa', blind: 'ee' }] },
      ],
    });
    assert.equal(second && second.reason, 'unsigned');
    const first = unsignedBodyField({
      admit_proofs: [
        { v: 1, members: [{ hash: 'bb', seed: 'ss' }] },
        { v: 1, members: [row()] },
      ],
    });
    assert.equal(first && first.reason, 'unsigned');
  });

  it('a body-secret name on a membership row is unsigned and is still skipped on the tx body', () => {
    assert.equal(unsignedBodyField({ seed: 'body', privateKey: 'k', V: 1, C: 2 }), null);
    for (const secret of BODY_SECRET_KEYS) {
      const top = unsignedBodyField({ members: [{ ...row(), [secret]: 'x' }] });
      assert.equal(top && top.reason, 'unsigned', secret);
      const nested = unsignedBodyField({
        admit_proof: { v: 1, members: [{ commit: 'aa', [secret]: 'x' }] },
      });
      assert.equal(nested && nested.reason, 'unsigned', `admit_proof ${secret}`);
      const listed = unsignedBodyField({
        admit_proofs: [{ v: 1, members: [row()] }, { v: 1, members: [{ [secret]: 'x' }] }],
      });
      assert.equal(listed && listed.reason, 'unsigned', `admit_proofs ${secret}`);
    }
  });

  it('a members value that is not an array is unsigned', () => {
    for (const bad of ['not-an-array', { commit: 'aa' }, 1, null, true]) {
      assert.equal(unsignedBodyField({ members: bad })?.reason, 'unsigned', String(bad));
      assert.equal(unsignedBodyField({
        admit_proof: { v: 1, members: bad },
      })?.reason, 'unsigned', `admit_proof ${String(bad)}`);
      assert.equal(unsignedBodyField({
        admit_proofs: [{ v: 1, members: [row()] }, { v: 1, members: bad }],
      })?.reason, 'unsigned', `admit_proofs ${String(bad)}`);
    }
  });

  it('mempool, block, and reload reject the member faults, and Stage 0 still rejects first', () => {
    const secretRow = { members: [{ ...row(), seed: 'leaked', privateKey: 'k', V: 1, C: 2 }] };
    const notArray = { members: { seed: 'leaked' } };
    const listed = {
      admit_proofs: [
        { v: 1, members: [row()] },
        { v: 1, members: [{ commit: 'aa', seed: 'leaked' }] },
      ],
    };
    for (const tx of [secretRow, notArray, listed]) {
      assert.equal(admitMempool(emptyMempool(), tx).reason, 'unsigned');
      assert.equal(verifyBlock({ txs: [tx] }, null).reason, 'unsigned');
      assert.equal(verifyLoadedChain([reloadBlock(tx)], {
        trustStoredHash: true,
        nowMs: WHEN,
        genesisHash: '',
      }).reason, 'unsigned');
    }

    const gated = v3Send({ members: [{ seed: 'leaked', privateKey: 'k' }] });
    assert.equal(unsignedBodyField(gated).reason, 'unsigned');
    assert.equal(admitMempool(emptyMempool(), gated).reason, 'send_unavailable');
    assert.equal(verifyBlock({ txs: [gated] }, null).reason, 'send_unavailable');
    const stub = { txs: [gated], header: Buffer.alloc(80), hash: Buffer.alloc(32) };
    assert.equal(verifyLoadedChain([stub]).reason, 'send_unavailable');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-member-reload-'));
    try {
      const store = createStore(dir);
      assert.equal(store.queueTx(secretRow).reason, 'unsigned');
      assert.equal(store.queueTx(gated).reason, 'send_unavailable');
      assert.equal(store.mempool.length, 0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }

    const book = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-member-book-'));
    try {
      fs.writeFileSync(path.join(book, 'chain.jsonl'), `${JSON.stringify({
        header: Buffer.alloc(80, 1).toString('hex'),
        hash: Buffer.alloc(32, 2).toString('hex'),
        height: 1,
        txs: [gated],
      })}\n`);
      assert.throws(() => createStore(book), /send_unavailable/);
    } finally {
      fs.rmSync(book, { recursive: true, force: true });
    }
  });
});
