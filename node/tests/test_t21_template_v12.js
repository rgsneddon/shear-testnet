import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { newIdentity } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { decodeHeader } from '../../crypto/header.js';
import {
  GENESIS_BITS_PACKED, MAX_HASH_UNITS_PER_BLOCK, TARGET_BLOCK_INTERVAL_MS, asertNextBits, shareCreditMaxBits,
} from '../../crypto/asert.js';
import { advanceHashOwed } from '../../crypto/hash_owed.js';
import { clearLiveSharePow, nonceWithShareTarget, noteCommitOfShare, rememberLiveSharePow } from '../../crypto/share_batch.js';
import { isT21Coinbase, t21ShareNc } from '../../crypto/t21.js';
import { CB_SHARE_MAX, W_HASH_MAX } from '../../crypto/t21_params.js';
import { cbV3WeightFor, payeeCapLive, txVerifyWeight } from '../../crypto/block_budget.js';
import { GENESIS_PREV, buildTemplate, verifyBlock } from '../src/chain.js';
import { t21LabelBook, t21LoginVoucher } from '../src/t21_template.js';

const magic = 'shear-testnet-v12';

function minerDest() {
  const id = newIdentity();
  return destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
}

function labelledShare(book, voucher, low, bits, header) {
  const label = book.issue(voucher);
  return {
    noteCommit: label.noteCommit,
    nonce: nonceWithShareTarget(low, bits),
    lz: bits,
    shareBits: bits,
    creditedShareBits: bits,
    verifiedHeader: header,
  };
}

function sealGenesis(now) {
  const feeTo = minerDest();
  const genesis = buildTemplate({ prev: GENESIS_PREV, height: 1, miner: feeTo, bits: GENESIS_BITS_PACKED, now, potShares: [], poolDest: feeTo });
  const block = {
    header: genesis.header, txs: genesis.txs, shareBatch: [], miner: feeTo, poolDest: feeTo,
    aLeaves: genesis.aLeaves, bLeaves: genesis.bLeaves, weight: genesis.weight, height: 1,
  };
  const sealed = verifyBlock(block, null, { trustedPowHash: Buffer.alloc(32, 0).fill(1, 31), nowMs: now + 1_000 });
  assert.equal(sealed.ok, true, sealed.reason);
  return { ...block, hash: sealed.hash, feeTo };
}

function childOf(parent, now, { shareBatch, t21, miner }) {
  const when = now + TARGET_BLOCK_INTERVAL_MS;
  const q = asertNextBits({
    anchorBits: GENESIS_BITS_PACKED, anchorTimeMs: now, anchorHeight: 1, blockTimeMs: when, blockHeight: 2,
    parentTimeMs: Number(decodeHeader(Buffer.from(parent.header)).timestamp),
  });
  clearLiveSharePow();
  for (const row of shareBatch) {
    rememberLiveSharePow(parent.header, row.nonce, { noteCommit: noteCommitOfShare(row), shareBits: row.shareBits, lz: row.lz });
  }
  const tpl = buildTemplate({
    prev: parent.hash, prevHeader: parent.header, prevBlock: parent, height: 2, miner, bits: q.packed, now: when,
    shareBatch, poolDest: parent.feeTo, t21,
  });
  const block = {
    header: tpl.header, txs: tpl.txs, shareBatch: tpl.shareBatch || [], miner, poolDest: parent.feeTo,
    aLeaves: tpl.aLeaves, bLeaves: tpl.bLeaves, weight: tpl.weight, height: 2,
  };
  const tag = Buffer.alloc(32);
  tag[31] = 2;
  const verdict = verifyBlock(block, parent, {
    trustedPowHash: tag, skipSharePow: true, nowMs: when + 1_000, genesisMs: now, poolDest: parent.feeTo,
  });
  return { tpl, block, verdict };
}

describe('T21 template: buildTemplate builds a cb-v3 coinbase consensus accepts', () => {
  it('pays labelled shares through cb-v3 and drops unlabelled ones from the batch', () => {
    const now = 1_700_000_000_000;
    const parent = sealGenesis(now);
    const book = t21LabelBook({ magic });
    const alice = t21LoginVoucher(Buffer.alloc(32, 1));
    const bob = t21LoginVoucher(Buffer.alloc(32, 2));
    const bits = shareCreditMaxBits() - 4;
    const stray = { ...labelledShare(book, alice, 9n, bits, parent.header), noteCommit: Buffer.alloc(32, 5) };
    const shareBatch = [
      labelledShare(book, alice, 4n, bits, parent.header),
      labelledShare(book, bob, 5n, bits, parent.header),
      labelledShare(book, alice, 6n, bits, parent.header),
      stray,
    ];
    const { tpl, block, verdict } = childOf(parent, now, {
      shareBatch, miner: minerDest(), t21: { magic, labelOf: book.labelOf },
    });
    assert.equal(isT21Coinbase(block.txs[0]), true);
    assert.equal(tpl.shareBatch.length, 3);
    assert.equal(block.txs[0].t21.shares.length, 3);
    for (const s of block.txs[0].t21.shares) assert.ok(book.labelOf(t21ShareNc(magic, s.E).toString('hex')));
    assert.equal(verdict.ok, true, verdict.reason);
  });

  it('caps template shares at shareMax and still verifies', () => {
    const now = 1_700_000_000_000;
    const parent = sealGenesis(now);
    const book = t21LabelBook({ magic });
    const v = t21LoginVoucher(Buffer.alloc(32, 3));
    const bits = shareCreditMaxBits() - 4;
    const shareBatch = [1n, 2n, 3n, 4n].map((n) => labelledShare(book, v, n, bits, parent.header));
    const { tpl, block, verdict } = childOf(parent, now, {
      shareBatch, miner: minerDest(), t21: { magic, labelOf: book.labelOf, shareMax: 2 },
    });
    assert.equal(tpl.shareBatch.length, 2);
    assert.equal(block.txs[0].t21.shares.length, 2);
    assert.equal(verdict.ok, true, verdict.reason);
  });

  it('carries the pot in an empty cb-v3 round', () => {
    const now = 1_700_000_000_000;
    const parent = sealGenesis(now);
    const book = t21LabelBook({ magic });
    const { block, verdict } = childOf(parent, now, { shareBatch: [], miner: minerDest(), t21: { magic, labelOf: book.labelOf } });
    assert.equal(block.txs[0].t21.shares.length, 0);
    assert.equal(verdict.ok, true, verdict.reason);
  });

  it('estimates the coinbase weight it will produce', () => {
    assert.equal(cbV3WeightFor(0), 300 + 2 * 60);
    assert.equal(cbV3WeightFor(10), 300 + 12 * 60 + 30);
    assert.equal(cbV3WeightFor(1e9), 300 + (payeeCapLive() + 2) * 60 + 3 * CB_SHARE_MAX);
    assert.ok(cbV3WeightFor(1e9) >= txVerifyWeight({ coinbase: true, cbForm: 'cb-v3', vout: [], t21: { shares: [] } }));
  });

  it('the hash ledger step takes W into the series and needs an empty owed map', () => {
    const block = { txs: [{ coinbase: true, cbForm: 'cb-v3', t21: { shares: [{ w: '3' }, { w: '5' }] } }] };
    const series = [];
    const got = advanceHashOwed({ owedIn: [], acceptedSeries: series, block });
    assert.equal(got.ok, true, got.reason);
    assert.deepEqual(series, [8n]);
    const owed = [{ noteCommit: Buffer.alloc(32, 1), dest20: Buffer.alloc(20, 1), nanos: 1n, sinceHeight: 1 }];
    assert.equal(advanceHashOwed({ owedIn: owed, acceptedSeries: [], block }).reason, 'hash_owed');
    // cb-v3 credits full units: past the legacy 2^28 is fine, past W_HASH_MAX is not.
    const wide = { txs: [{ coinbase: true, cbForm: 'cb-v3', t21: { shares: [{ w: String(MAX_HASH_UNITS_PER_BLOCK + 1) }] } }] };
    assert.equal(advanceHashOwed({ owedIn: [], acceptedSeries: [], block: wide }).ok, true);
    const fat = { txs: [{ coinbase: true, cbForm: 'cb-v3', t21: { shares: [{ w: String(W_HASH_MAX + 1n) }] } }] };
    assert.equal(advanceHashOwed({ owedIn: [], acceptedSeries: [], block: fat }).reason, 'hash_units');
  });

  it('the label book rotates labels and refuses a bad voucher', () => {
    const book = t21LabelBook({ magic, keep: 2 });
    const v = t21LoginVoucher(Buffer.alloc(32, 4));
    const a = book.issue(v);
    const b = book.issue(v);
    assert.notEqual(a.noteCommit.toString('hex'), b.noteCommit.toString('hex'));
    book.issue(v);
    assert.equal(book.labelOf(a.noteCommit.toString('hex')), null);
    assert.ok(book.labelOf(b.noteCommit.toString('hex')));
    assert.equal(book.issue({ ...v, lambda: Buffer.alloc(32, 9) }), null);
  });
});
