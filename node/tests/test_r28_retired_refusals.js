// R28: every payout mechanism R28 (D1, D2), option 2 and the levy as built
// retired is refused by verify, not merely unused. Each case takes an honest
// block that verifies and adds one retired thing, resealed so the header
// commits it; verify must refuse it with the named reason.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { newIdentity, freshStealthDest, hash20FromAddress } from '../../crypto/address.js';
import { GENESIS_BITS_PACKED } from '../../crypto/asert.js';
import { decodeHeader, encodeHeader } from '../../crypto/header.js';
import { poolFeeDest } from '../../crypto/levy.js';
import { merkleRoot } from '../../crypto/merkle.js';
import { excessOf, noteCommitOfDest20, sealCoinbaseNote } from '../../crypto/note.js';
import { GENESIS_PREV, buildTemplate, digestTx, verifyBlock } from '../src/chain.js';

const TRUSTED = Buffer.alloc(32);
const T0 = 1_700_000_000_000;

function destOf() {
  return freshStealthDest(newIdentity()).dest;
}

function honest() {
  const miner = destOf();
  const tpl = buildTemplate({ prev: GENESIS_PREV, height: 1, miner, bits: GENESIS_BITS_PACKED, now: T0 });
  return { miner, tpl };
}

function blockOf(tpl, txs, extra = {}) {
  const decoded = decodeHeader(Buffer.from(tpl.header));
  return {
    header: encodeHeader({ ...decoded, merkleRoot: merkleRoot(txs.map(digestTx)) }),
    height: 1,
    txs,
    shareBatch: tpl.shareBatch || [],
    aLeaves: tpl.aLeaves,
    bLeaves: tpl.bLeaves,
    rootA: tpl.rootA,
    rootB: tpl.rootB,
    weight: tpl.weight,
    ...extra,
  };
}

function verdict(block) {
  return verifyBlock(block, null, { trustedPowHash: TRUSTED });
}

/** The honest coinbase plus one explicit output, excess rebound. */
function withOutput(tpl, note) {
  const cb = tpl.txs[0];
  const vout = (cb.vout || []).concat([note]);
  return [{ ...cb, vout, excess: excessOf(vout) }, ...tpl.txs.slice(1)];
}

describe('R28 refuses the payout mechanisms it retired', () => {
  it('the honest block verifies (control)', () => {
    const { tpl } = honest();
    const got = verdict(blockOf(tpl, tpl.txs));
    assert.equal(got.ok, true, got.reason);
  });

  it('a coinbase pot note to the miner, and a pot labelled with another dest, are blunote_vout (D1, D2)', () => {
    const { miner, tpl } = honest();
    const own20 = Buffer.from(hash20FromAddress(miner));
    const pot = sealCoinbaseNote(100_000_000_000, { kind: 'pot', dest20: own20 });
    assert.equal(verdict(blockOf(tpl, withOutput(tpl, pot))).reason, 'blunote_vout');
    const victim20 = Buffer.from(hash20FromAddress(destOf()));
    const labelled = { ...pot, noteCommit: noteCommitOfDest20(victim20) };
    assert.equal(verdict(blockOf(tpl, withOutput(tpl, labelled))).reason, 'blunote_vout');
  });

  it('a coinbase hash-bonus note and a pool-fee note are blunote_vout (D2; the fee is the coinbase key\'s implicit note)', () => {
    const { miner, tpl } = honest();
    const hash = sealCoinbaseNote(256, { kind: 'hash', dest20: Buffer.from(hash20FromAddress(miner)) });
    assert.equal(verdict(blockOf(tpl, withOutput(tpl, hash))).reason, 'blunote_vout');
    const fee = sealCoinbaseNote(1_000_000_000, { kind: 'pool-fee', dest20: Buffer.from(hash20FromAddress(poolFeeDest())) });
    assert.equal(verdict(blockOf(tpl, withOutput(tpl, fee))).reason, 'blunote_vout');
  });

  it('a custody or pull-book pot payout is blunote_vout (D2: no coinbase pot to custody)', () => {
    const { tpl } = honest();
    const custody = destOf();
    const pot = sealCoinbaseNote(99_000_000_000, { kind: 'pot', dest20: Buffer.from(hash20FromAddress(custody)) });
    assert.equal(verdict(blockOf(tpl, withOutput(tpl, pot))).reason, 'blunote_vout');
    // A template asked for a custody dest names no output at all.
    const asked = buildTemplate({
      prev: GENESIS_PREV, height: 1, miner: destOf(), bits: GENESIS_BITS_PACKED, now: T0,
      hashBonusCustodyDest: custody, poolDest: custody,
    });
    assert.equal(asked.txs[0].vout.length, 0);
  });

  it('an aimed finder-fee note to a chosen miner is blunote_vout (levy as built)', () => {
    const { tpl } = honest();
    const aimed = sealCoinbaseNote(1_000, { kind: 'finder-fee', dest20: Buffer.from(hash20FromAddress(destOf())) });
    assert.equal(verdict(blockOf(tpl, withOutput(tpl, aimed))).reason, 'blunote_vout');
  });

  it('payee leaves by dest are blunote_leaves (D2: shares pay by draw)', () => {
    const { miner, tpl } = honest();
    const d20 = Buffer.from(hash20FromAddress(miner));
    const leaf = { dest20: d20, noteCommit: noteCommitOfDest20(d20), count: 256 };
    assert.equal(verdict(blockOf(tpl, tpl.txs, { aLeaves: [leaf] })).reason, 'blunote_leaves');
  });

  it('spill rows and spill credits are hash_spill (D2: no spill)', () => {
    const { miner, tpl } = honest();
    const row = { dest: miner, nonce: 1n, lz: 8, shareBits: 8, proofSlot: 1 };
    assert.equal(verdict(blockOf(tpl, tpl.txs, { hashSpill: [row] })).reason, 'hash_spill');
    assert.equal(verdict(blockOf(tpl, tpl.txs, { hashSpillCredits: [{ noteCommit: Buffer.alloc(32, 1), nanos: 5n }] })).reason, 'hash_spill');
  });

  // Russell 28 Oct ("Code fix now"): verify refuses an owed-ledger or
  // hash-credit field as blunote_owed, read on the rows as given, so a field
  // compaction would strip is refused, not dropped and then accepted. At
  // 1eb24147 and 1f6740f1 every case here was accepted.
  it('a block or coinbase carrying owed rows or a hash-credit record is blunote_owed (D2: no owed ledger)', () => {
    const { miner, tpl } = honest();
    const d20 = Buffer.from(hash20FromAddress(miner));
    const credit = { noteCommit: noteCommitOfDest20(d20), dest20: d20, nanos: 5n, sinceHeight: 1 };
    const cb = tpl.txs[0];
    const withCb = (extra) => blockOf(tpl, [{ ...cb, ...extra }, ...tpl.txs.slice(1)]);
    const cases = [
      ['block hashCredits', blockOf(tpl, tpl.txs, { hashCredits: [credit] })],
      ['block hashCredits empty', blockOf(tpl, tpl.txs, { hashCredits: [] })],
      ['block hashCreditPacked', blockOf(tpl, tpl.txs, { hashCreditPacked: 'aa' })],
      ['coinbase hashOwedRoot', withCb({ hashOwedRoot: Buffer.alloc(32, 7) })],
      ['coinbase hashCreditRoot', withCb({ hashCreditRoot: Buffer.alloc(32, 7) })],
      ['coinbase hashOwed rows', withCb({ hashOwed: [credit] })],
      ['coinbase hashOwedRest rows', withCb({ hashOwedRest: [credit] })],
      ['coinbase hashOwedLocal rows', withCb({ hashOwedLocal: [credit] })],
      ['coinbase hashCredits rows', withCb({ hashCredits: [credit] })],
      ['coinbase hashDustNanos', withCb({ hashDustNanos: '5' })],
      ['coinbase hashOwedOverflowNanos', withCb({ hashOwedOverflowNanos: '5' })],
      ['coinbase hashAcceptedUnits', withCb({ hashAcceptedUnits: '0' })],
      ['coinbase hashBonusUnit', withCb({ hashBonusUnit: 1 })],
    ];
    const seen = {};
    for (const [label, block] of cases) {
      const got = verdict(block);
      seen[label] = got.ok ? 'ACCEPTED' : got.reason;
    }
    for (const [label] of cases) assert.equal(seen[label], 'blunote_owed', `${label}: ${JSON.stringify(seen)}`);
  });
});
