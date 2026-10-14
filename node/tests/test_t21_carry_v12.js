import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newIdentity } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { VERSION, decodeHeader, encodeHeader } from '../../crypto/header.js';
import { GENESIS_BITS_PACKED, TARGET_BLOCK_INTERVAL_MS, asertNextBits } from '../../crypto/asert.js';
import { nonceWithShareTarget, noteCommitOfShare, rememberLiveSharePow, shareWorkKey } from '../../crypto/share_batch.js';
import { t21ShareNc } from '../../crypto/t21.js';
import { GENESIS_PREV, buildTemplate, verifyBlock } from '../src/chain.js';
import { planT21Round, t21LabelBook, t21LoginVoucher } from '../src/t21_template.js';
import { t21CarryBook, withCarry } from '../src/t21_carry.js';

const magic = 'shear-testnet-v12';

function tmpDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `t21-${tag}-`));
}

function lab(nc, payee, units, { count = 1, carried = false } = {}) {
  return { nc, payee, units: BigInt(units), count, carried };
}

const ncsOf = (rows) => rows.map((l) => l.nc);

describe('T21 carry: planT21Round fills slots by units and never cuts a label', () => {
  it('Sybil vouchers cannot take the payee slots from the hashers (MF-3)', () => {
    const sybils = Array.from({ length: 300 }, (_, i) => lab(`s${String(i).padStart(3, '0')}`, `sy${i}`, 1));
    const honest = [lab('h1', 'A', 1000), lab('h2', 'B', 900), lab('h3', 'C', 800)];
    const got = planT21Round({ labels: [...sybils, ...honest], payeeMax: 171 });
    assert.deepEqual(ncsOf(got.take).slice(0, 3), ['h1', 'h2', 'h3']);
    assert.equal(got.payees, 171);
    assert.equal(got.later.length, 132);
    assert.ok(got.later.every((l) => l.reason === 'payee_cap' && l.units === 1n));
  });

  it('a payee with several labels counts its total units', () => {
    const got = planT21Round({
      labels: [lab('x1', 'X', 40), lab('x2', 'X', 40), lab('y1', 'Y', 70)],
      payeeMax: 1,
    });
    assert.deepEqual(ncsOf(got.take).sort(), ['x1', 'x2']);
    assert.deepEqual(got.later.map((l) => [l.nc, l.reason]), [['y1', 'payee_cap']]);
  });

  it('units past the unit cap are deferred whole, not scaled (MF-1)', () => {
    const labels = [lab('a', 'A', 600), lab('b', 'B', 500), lab('c', 'C', 300), lab('d', 'D', 200)];
    const got = planT21Round({ labels, unitMax: 1000n });
    assert.deepEqual(ncsOf(got.take), ['a', 'c']);
    assert.equal(got.units, 900n);
    assert.deepEqual(got.later.map((l) => [l.nc, l.reason, l.units]), [['b', 'hash_units', 500n], ['d', 'hash_units', 200n]]);
    const budget = planT21Round({ labels, unitBudget: 800n });
    assert.deepEqual(ncsOf(budget.take), ['a', 'd']);
    assert.ok(budget.later.every((l) => l.reason === 'hash_budget'));
  });

  it('the share cap counts raw shares and moves a label whole', () => {
    const got = planT21Round({ labels: [lab('a', 'A', 90, { count: 3 }), lab('b', 'B', 50, { count: 2 }), lab('c', 'C', 10, { count: 1 })], shareMax: 4 });
    assert.deepEqual(ncsOf(got.take), ['a', 'c']);
    assert.equal(got.shares, 4);
    assert.deepEqual(got.later.map((l) => [l.nc, l.reason]), [['b', 'share_cap']]);
  });

  it('expiring carry goes before fresh shares of any size', () => {
    const got = planT21Round({
      labels: [lab('big', 'F', 10_000), lab('old', 'O', 1, { carried: true }), lab('old2', 'P', 5, { carried: true })],
      payeeMax: 2,
    });
    assert.deepEqual(ncsOf(got.take), ['old2', 'old']);
    assert.deepEqual(got.later.map((l) => [l.nc, l.reason]), [['big', 'payee_cap']]);
  });

  it('the finder payee holds a slot before any share payee', () => {
    const got = planT21Round({ labels: [lab('a', 'A', 5), lab('b', 'B', 4)], payeeMax: 2, finderPayee: 'F' });
    assert.deepEqual(ncsOf(got.take), ['a']);
    const own = planT21Round({ labels: [lab('a', 'A', 5), lab('f', 'F', 1)], payeeMax: 2, finderPayee: 'F' });
    assert.deepEqual(ncsOf(own.take).sort(), ['a', 'f']);
  });
});

/* ---------- carry book on synthetic blocks ---------- */

function fakeHeader(prev, n) {
  return encodeHeader({
    version: VERSION,
    prevBlockHash: prev,
    merkleRoot: Buffer.alloc(32, n),
    continuityRoot: Buffer.alloc(32, n + 1),
    timestamp: BigInt(1_700_000_000_000 + n),
    bits: GENESIS_BITS_PACKED,
    nonce: 0n,
    baseFee: 1n,
  });
}

function fakeBlock(prevHash, height, n, { shareBatch = [], E = [] } = {}) {
  const header = fakeHeader(prevHash, n);
  return {
    hash: Buffer.alloc(32, n),
    header,
    height,
    shareBatch,
    txs: [{ coinbase: true, cbForm: 'cb-v3', t21: { shares: E.map((e) => ({ w: '1', E: e })) } }],
  };
}

/** A share mined on `header`, labelled by E's note commit. */
function fakeShare(header, low, E) {
  return { noteCommit: t21ShareNc(magic, E), nonce: nonceWithShareTarget(low, 12), lz: 12, shareBits: 12, creditedShareBits: 12, verifiedHeader: header };
}

const keyOf = (s) => shareWorkKey(s.verifiedHeader, s.nonce);
const keys = (list) => list.map(keyOf).sort();

describe('T21 carry: the carry book follows the tip, a reorg, and a restart', () => {
  const E = (n) => Buffer.alloc(32, n);

  it('carry is the parent round minus what the tip paid, by work key and by label', () => {
    const g = fakeBlock(GENESIS_PREV, 1, 1);
    const shares = [1, 2, 3, 4].map((n) => fakeShare(g.header, BigInt(n), E(10 + n)));
    const book = t21CarryBook();
    book.noteRound(g, shares);
    const b2 = fakeBlock(g.hash, 2, 2, { shareBatch: [shares[0]], E: [E(11), E(12)] });
    // shares[1] is not in b2's batch but its label is spent there: E may not repeat.
    assert.deepEqual(keys(book.carryFor(b2, magic)), keys([shares[2], shares[3]]));
    assert.ok(book.carryFor(b2, magic).every((s) => s.proofSlot === undefined));
  });

  it('a reorg to a sibling brings back what the orphan paid', () => {
    const g = fakeBlock(GENESIS_PREV, 1, 1);
    const shares = [1, 2, 3].map((n) => fakeShare(g.header, BigInt(n), E(20 + n)));
    const book = t21CarryBook();
    book.noteRound(g, shares);
    const orphan = fakeBlock(g.hash, 2, 2, { shareBatch: shares.slice(0, 2), E: [E(21), E(22)] });
    const sibling = fakeBlock(g.hash, 2, 3, { shareBatch: [shares[2]], E: [E(23)] });
    assert.deepEqual(keys(book.carryFor(orphan, magic)), keys([shares[2]]));
    assert.deepEqual(keys(book.carryFor(sibling, magic)), keys(shares.slice(0, 2)));
  });

  it('the file brings the carry and the counters back after a restart', () => {
    const dir = tmpDir('carry');
    const file = path.join(dir, 't21-carry.json');
    const g = fakeBlock(GENESIS_PREV, 1, 1);
    const shares = [1, 2].map((n) => fakeShare(g.header, BigInt(n), E(30 + n)));
    t21CarryBook({ file }).noteRound(g, shares);
    const b2 = fakeBlock(g.hash, 2, 2);
    const again = t21CarryBook({ file });
    assert.deepEqual(keys(again.carryFor(b2, magic)), keys(shares));
    const got = again.carryFor(b2, magic)[0];
    assert.ok(Buffer.isBuffer(got.verifiedHeader) && Buffer.isBuffer(got.noteCommit) && typeof got.nonce === 'bigint');
    assert.equal(fs.statSync(file).mode & 0o077, 0);
  });

  it('settleTip counts expired carry once and flags an empty batch while shares are held (MF-4)', () => {
    const g = fakeBlock(GENESIS_PREV, 1, 1);
    const shares = [1, 2].map((n) => fakeShare(g.header, BigInt(n), E(40 + n)));
    const book = t21CarryBook();
    book.noteRound(g, shares);
    const b2 = fakeBlock(g.hash, 2, 2);
    book.noteRound(b2, [fakeShare(b2.header, 9n, E(49))]);
    const b3 = fakeBlock(b2.hash, 3, 3);
    const first = book.settleTip(b3, b2, magic);
    assert.equal(first.expired.length, 2);
    assert.equal(first.emptyHeld, true);
    book.settleTip(b3, b2, magic);
    assert.equal(book.stats().expiredShares, 2);
    assert.equal(book.stats().emptyHeld, 1);
    const paid = fakeBlock(b2.hash, 3, 4, { shareBatch: shares, E: [E(41), E(42)] });
    const ok = book.settleTip(paid, b2, magic);
    assert.equal(ok.expired.length, 0);
    assert.equal(ok.emptyHeld, false);
  });

  it('withCarry puts carry first and drops a repeat work key', () => {
    const g = fakeBlock(GENESIS_PREV, 1, 1);
    const a = fakeShare(g.header, 1n, E(51));
    const b = fakeShare(g.header, 2n, E(52));
    assert.deepEqual(keys(withCarry([a], [b, { ...a }])), keys([a, b]));
    assert.equal(keyOf(withCarry([a], [b])[0]), keyOf(a));
  });

  it('the label book keeps every label and its opening across a restart', () => {
    const dir = tmpDir('labels');
    const file = path.join(dir, 'labels.log');
    const book = t21LabelBook({ magic, keep: 3, file });
    const v = t21LoginVoucher(Buffer.alloc(32, 7));
    const issued = [book.issue(v), book.issue(v), book.issue(v), book.issue(v)];
    const again = t21LabelBook({ magic, keep: 3, file });
    assert.equal(again.labelOf(issued[0].noteCommit.toString('hex')), null);
    for (const l of issued.slice(1)) {
      const a = book.labelOf(l.noteCommit.toString('hex'));
      const b = again.labelOf(l.noteCommit.toString('hex'));
      assert.equal(b.beta, a.beta);
      assert.equal(b.ell, a.ell);
      assert.ok(b.E.equals(a.E));
      assert.ok(Buffer.from(b.voucher.B).equals(Buffer.from(a.voucher.B)));
    }
    assert.equal(fs.statSync(file).mode & 0o077, 0);
    assert.equal(t21LabelBook({ magic: 'other', file }).size(), 0);
  });
});

/* ---------- consecutive full cb-v3 blocks through buildTemplate and verifyBlock ---------- */

const NOW = 1_700_000_000_000;

function minerDest() {
  const id = newIdentity();
  return destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
}

function sealGenesis() {
  const feeTo = minerDest();
  const genesis = buildTemplate({ prev: GENESIS_PREV, height: 1, miner: feeTo, bits: GENESIS_BITS_PACKED, now: NOW, potShares: [], poolDest: feeTo });
  const block = {
    header: genesis.header, txs: genesis.txs, shareBatch: [], miner: feeTo, poolDest: feeTo,
    aLeaves: genesis.aLeaves, bLeaves: genesis.bLeaves, weight: genesis.weight, height: 1,
  };
  const sealed = verifyBlock(block, null, { trustedPowHash: Buffer.alloc(32, 0).fill(1, 31), nowMs: NOW + 1_000 });
  assert.equal(sealed.ok, true, sealed.reason);
  const out = { ...block, hash: sealed.hash, feeTo, supply: sealed.supplyState };
  out.chain = [out];
  return out;
}

/** A labelled share mined on `on`'s header. Its PoW is cached as the pool would have checked it. */
function mineShare(book, secret, on, low, bits) {
  for (let ctr = 0; ctr < 64; ctr += 1) {
    const label = book.issue(t21LoginVoucher(Buffer.alloc(32, secret), ctr));
    if (!label) continue;
    const s = {
      noteCommit: label.noteCommit,
      nonce: nonceWithShareTarget(low, bits),
      lz: bits,
      shareBits: bits,
      creditedShareBits: bits,
      verifiedHeader: on.header,
    };
    rememberLiveSharePow(on.header, s.nonce, { noteCommit: label.noteCommit, shareBits: bits, lz: bits });
    return s;
  }
  throw new Error('voucher');
}

/** What store.template does for cb-v3: settle the tip, add its carry first, build, record the round. */
function mineChild({ parent, grand, carry, labels, fresh, t21 = {}, n = 0 }) {
  const height = parent.height + 1;
  const when = NOW + (height - 1) * TARGET_BLOCK_INTERVAL_MS + n;
  const bits = asertNextBits({
    anchorBits: GENESIS_BITS_PACKED, anchorTimeMs: NOW, anchorHeight: 1, blockTimeMs: when, blockHeight: height,
    parentTimeMs: Number(decodeHeader(Buffer.from(parent.header)).timestamp),
  }).packed;
  const settled = grand ? carry.settleTip(parent, grand, magic) : { expired: [], emptyHeld: false };
  const carried = carry.carryFor(parent, magic);
  const miner = minerDest();
  const tpl = buildTemplate({
    prev: parent.hash, prevHeader: parent.header, prevBlock: parent, height, miner, bits, now: when,
    shareBatch: withCarry(carried, fresh), poolDest: parent.feeTo, parentBlocks: parent.chain,
    t21: { magic, labelOf: labels.labelOf, ...t21 },
  });
  carry.noteRound(parent, [...tpl.shareBatch, ...tpl.t21Later].filter((s) => s.proofSlot === 0));
  const block = {
    header: tpl.header, txs: tpl.txs, shareBatch: tpl.shareBatch, miner, poolDest: parent.feeTo,
    aLeaves: tpl.aLeaves, bLeaves: tpl.bLeaves, weight: tpl.weight, height,
  };
  const tag = Buffer.alloc(32);
  tag[29] = height;
  tag[30] = n;
  tag[31] = 2;
  const verdict = verifyBlock(block, parent, {
    trustedPowHash: tag, skipSharePow: true, nowMs: when + 1_000, genesisMs: NOW, poolDest: parent.feeTo,
    grandparentHeader: grand?.header || null, parentSupply: parent.supply, evmHistory: parent.chain,
  });
  assert.equal(verdict.ok, true, verdict.reason);
  const out = { ...block, hash: verdict.hash, feeTo: parent.feeTo, supply: verdict.supplyState };
  out.chain = [...parent.chain, out];
  return { block: out, tpl, settled, carried };
}

const paidKeys = (block) => block.shareBatch.map(keyOf);

describe('T21 carry: nothing is lost across consecutive full blocks, a restart, and a reorg', () => {
  it('leftovers go first in the next block until every share is paid once', () => {
    const dir = tmpDir('e2e');
    const labelFile = path.join(dir, 'labels.log');
    const carryFile = path.join(dir, 't21-carry.json');
    let labels = t21LabelBook({ magic, file: labelFile });
    let carry = t21CarryBook({ file: carryFile });
    const full = { shareMax: 4 };
    const g = sealGenesis();
    const onG = [26, 25, 24, 23, 22, 21, 20].map((bits, i) => mineShare(labels, 10 + i, g, BigInt(100 + i), bits));

    // Block 2: seven fresh shares, room for four. The three smallest wait.
    const b2 = mineChild({ parent: g, grand: null, carry, labels, fresh: onG, t21: full });
    assert.deepEqual(paidKeys(b2.block).sort(), keys(onG.slice(0, 4)));
    assert.deepEqual(keys(b2.tpl.t21Later), keys(onG.slice(4)));
    assert.ok(b2.tpl.t21Later.every((s) => s.deferReason === 'share_cap' && s.proofSlot === 0));
    assert.equal(b2.tpl.t21Expired.length, 0);

    // Block 3: the three carried go first, ahead of larger fresh shares; one fresh share fits.
    const onB2 = [27, 24, 22].map((bits, i) => mineShare(labels, 30 + i, b2.block, BigInt(200 + i), bits));
    const b3 = mineChild({ parent: b2.block, grand: g, carry, labels, fresh: onB2, t21: full });
    assert.deepEqual(keys(b3.carried), keys(onG.slice(4)));
    assert.deepEqual(paidKeys(b3.block).sort(), keys([...onG.slice(4), onB2[0]]));
    assert.ok(b3.block.shareBatch.filter((s) => onG.slice(4).some((o) => keyOf(o) === keyOf(s))).every((s) => s.proofSlot === 1));
    assert.deepEqual(keys(b3.tpl.t21Later), keys(onB2.slice(1)));
    assert.equal(b3.tpl.t21Expired.length, 0);

    // Restart: both books come back from disk.
    labels = t21LabelBook({ magic, file: labelFile });
    carry = t21CarryBook({ file: carryFile });

    // Block 4: the carry from block 3's round is paid after the restart.
    const b4 = mineChild({ parent: b3.block, grand: b2.block, carry, labels, fresh: [], t21: full });
    assert.deepEqual(paidKeys(b4.block).sort(), keys(onB2.slice(1)));
    assert.equal(b4.settled.expired.length, 0);
    assert.equal(b4.tpl.t21Later.length, 0);

    const all = [...onG, ...onB2].map(keyOf).sort();
    const paid = [b2, b3, b4].flatMap((b) => paidKeys(b.block)).sort();
    assert.deepEqual(paid, all);
    assert.equal(carry.stats().expiredShares, 0);

    // A sibling of block 3 that pays no share although the template held carry (MF-4).
    const empty = mineChild({ parent: b2.block, grand: g, carry, labels, fresh: onB2, t21: { shareMax: 0 }, n: 7 });
    assert.equal(empty.block.txs[0].t21.shares.length, 0);
    assert.deepEqual(empty.tpl.t21Flags, ['empty_batch_held']);
    assert.deepEqual(keys(empty.tpl.t21Expired), keys(onG.slice(4)));

    // Reorg onto the empty sibling: what the orphaned block 3 paid from block 2's round is carry again.
    const b4r = mineChild({ parent: empty.block, grand: b2.block, carry, labels, fresh: [], t21: full });
    assert.deepEqual(keys(b4r.carried), keys(onB2));
    assert.deepEqual(paidKeys(b4r.block).sort(), keys(onB2));
    assert.equal(b4r.settled.emptyHeld, true);
    assert.deepEqual(keys(b4r.settled.expired), keys(onG.slice(4)));
    assert.equal(carry.stats().emptyHeld, 1);
    for (const s of b4r.block.txs[0].t21.shares) {
      assert.ok(labels.labelOf(t21ShareNc(magic, s.E).toString('hex')));
    }
    assert.ok(b4r.block.shareBatch.every((s) => labels.labelOf(noteCommitOfShare(s).toString('hex'))));
  });
});
