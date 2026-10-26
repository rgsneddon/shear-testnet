/**
 * COINBASE_NC=dest-bound (Russell 26 Oct, from height 0). A coinbase output's
 * noteCommit is the label a node credits it by (note_ledger.js), so on every
 * output but a hasher payout it must be the one its own dest20 derives, and a
 * row with no dest20 carries none. Before this, a miner could label its own
 * pot with another dest's noteCommit, keep spending it, and that dest's
 * Spendable on the node and pool rose by a sum it could never spend.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newIdentity, freshStealthDest, hash20FromAddress } from '../../crypto/address.js';
import { decodeHeader, encodeHeader } from '../../crypto/header.js';
import { merkleRoot } from '../../crypto/merkle.js';
import { noteCommitOfDest20, sealCoinbaseNote } from '../../crypto/note.js';
import { MAGIC_REGTEST, regtestBitsOverride } from '../../crypto/regtest_bits.js';
import { SPENDABLE_CONFIRMATIONS } from '../../crypto/asert.js';
import { coinbaseLabelRejected, digestTx } from '../src/chain.js';
import { createNoteLedger } from '../src/note_ledger.js';
import { createRegtestStore } from './regtest_store.js';
import { closeMineWorkers, mineHeaderParallel } from './mine_worker.mjs';

const T0 = 1_700_000_000_000;
const MAX_TRIES = 8_192;

after(() => closeMineWorkers());

function regtestStore(tag) {
  return createRegtestStore(fs.mkdtempSync(path.join(os.tmpdir(), tag)), { bits: 4 });
}

function templateOf(store, miner) {
  const parent = store.tip();
  const now = parent ? Number(decodeHeader(Buffer.from(parent.header)).timestamp) + 90_000 : T0;
  return store.template({ miner, bits: regtestBitsOverride(MAGIC_REGTEST), shareBits: 4, now }).tpl;
}

async function sealed(tpl, txs) {
  const head = decodeHeader(Buffer.from(tpl.header));
  const found = await mineHeaderParallel(encodeHeader({ ...head, merkleRoot: merkleRoot(txs.map((tx) => digestTx(tx))) }), tpl.bits, MAX_TRIES, 1);
  assert.ok(found && found.block, 'need pow');
  return {
    header: found.header, txs, samples: tpl.samples, shareBatch: tpl.shareBatch || [], miner: tpl.miner,
    aLeaves: tpl.aLeaves, bLeaves: tpl.bLeaves, rootA: tpl.rootA, rootB: tpl.rootB, weight: tpl.weight,
  };
}

/** The coinbase with its first pot labelled `label`, dest20 untouched. */
function relabel(tpl, label) {
  const cb = tpl.txs[0];
  const at = cb.vout.findIndex((o) => String(o.kind || '') === 'pot');
  assert.ok(at >= 0, 'the template pays a pot');
  const vout = cb.vout.map((o, i) => (i === at ? { ...o, noteCommit: Buffer.from(label) } : o));
  return [{ ...cb, vout }, ...tpl.txs.slice(1)];
}

describe('a coinbase label is bound to its own dest20', () => {
  it('coinbaseLabelRejected: honest, another dest, no dest20, hasher payouts', () => {
    const own = Buffer.alloc(20, 7);
    const other = Buffer.alloc(20, 9);
    const honest = { kind: 'pot', dest20: own, noteCommit: noteCommitOfDest20(own) };
    assert.equal(coinbaseLabelRejected([honest]), null);
    for (const kind of ['pot', 'pool-fee', 'finder-fee', 'reserve-fee']) {
      assert.deepEqual(coinbaseLabelRejected([{ ...honest, kind, noteCommit: noteCommitOfDest20(other) }]), { ok: false, reason: 'coinbase_output' }, kind);
    }
    // No dest20: no label, else refused. Nothing derives one.
    assert.equal(coinbaseLabelRejected([{ kind: 'pot' }]), null);
    assert.deepEqual(coinbaseLabelRejected([{ kind: 'pot', noteCommit: noteCommitOfDest20(own) }]), { ok: false, reason: 'coinbase_output' });
    assert.deepEqual(coinbaseLabelRejected([{ kind: 'pot', dest20: Buffer.alloc(19, 7), noteCommit: noteCommitOfDest20(own) }]), { ok: false, reason: 'coinbase_output' });
    // A hasher payout keeps the Tree-A match: a hash row, or a row whose label is a share leaf.
    assert.equal(coinbaseLabelRejected([{ kind: 'hash', dest20: own, noteCommit: noteCommitOfDest20(other) }]), null);
    const leaf = noteCommitOfDest20(other);
    assert.equal(coinbaseLabelRejected([{ kind: 'pot', dest20: own, noteCommit: leaf }], new Set([leaf.toString('hex')])), null);
  });

  it('a block labelling its reward with another dest\'s noteCommit is refused; the honest block appends', async () => {
    const store = regtestStore('shear-nc-');
    const miner = freshStealthDest(newIdentity()).dest;
    const victim = freshStealthDest(newIdentity()).dest;
    const victimLabel = noteCommitOfDest20(hash20FromAddress(victim));
    const tpl = templateOf(store, miner);
    assert.equal(coinbaseLabelRejected(tpl.txs[0].vout), null, 'the honest template is dest-bound');
    const painted = await sealed(tpl, relabel(tpl, victimLabel));
    const refused = await Promise.resolve(store.append(painted));
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, 'coinbase_output');
    assert.equal(store.tip(), null, 'the tip is kept');
    const honest = await sealed(tpl, tpl.txs);
    const got = await Promise.resolve(store.append(honest));
    assert.equal(got.ok, true, got.reason);
    for (let i = 0; i < SPENDABLE_CONFIRMATIONS + 1; i += 1) {
      const next = templateOf(store, miner);
      const more = await Promise.resolve(store.append(await sealed(next, next.txs)));
      assert.equal(more.ok, true, more.reason);
    }
    // The victim was never paid, and the miner's matured pots are its own.
    assert.equal(store.spendableNanos(victim), 0);
    assert.ok(store.spendableNanos(miner) > 0, 'the miner is credited its own pots');
  });

  it('the node ledger never credits a label to a dest it was not derived from (second guard)', () => {
    const ownAddr = freshStealthDest(newIdentity()).dest;
    const own = hash20FromAddress(ownAddr);
    const victim = freshStealthDest(newIdentity()).dest;
    const pot = sealCoinbaseNote(250_000_000, { dest20: own, kind: 'pot' });
    const paintedPot = { ...pot, dest20: own, noteCommit: noteCommitOfDest20(hash20FromAddress(victim)) };
    const blocks = Array.from({ length: SPENDABLE_CONFIRMATIONS + 2 }, (_, i) => ({
      height: i + 1,
      hash: Buffer.alloc(32, i + 1),
      txs: [{ coinbase: true, vout: i === 0 ? [paintedPot] : [] }],
    }));
    const ledger = createNoteLedger();
    ledger.sync(blocks);
    // Mempool admission reads this figure (store.destSpendableNanos), as the
    // pool's wallet API does: neither ever sees the painted sum.
    assert.equal(ledger.spendable(victim, blocks.length), 0, 'the painted label credits the victim nothing');
    assert.equal(ledger.spendable(ownAddr, blocks.length), 0, 'nor anyone: the row is credited by no label');
    // Control: the same pot under its own label is its owner's, in full.
    const honestBlocks = blocks.map((b, i) => (i === 0 ? { ...b, txs: [{ coinbase: true, vout: [{ ...pot, dest20: own }] }] } : b));
    const honestLedger = createNoteLedger();
    honestLedger.sync(honestBlocks);
    assert.equal(honestLedger.spendable(ownAddr, blocks.length), 250_000_000);
    assert.equal(honestLedger.spendable(victim, blocks.length), 0);
  });
});
