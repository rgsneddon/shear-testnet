import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { encodeDest, hash20FromAddress, newIdentity } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { VERSION, decodeHeader, encodeHeader } from '../../crypto/header.js';
import { GENESIS_BITS_PACKED, TARGET_BLOCK_INTERVAL_MS, asertNextBits } from '../../crypto/asert.js';
import { nonceWithShareTarget, noteCommitOfShare, rememberLiveSharePow, shareWorkKey } from '../../crypto/share_batch.js';
import { payeeCapLive } from '../../crypto/block_budget.js';
import { T21_OWED_GLOBAL, T21_OWED_MAX, T21_OWED_TTL, T21_SETTLE_WINDOW } from '../../crypto/t21_params.js';
import { t21ShareNc } from '../../crypto/t21.js';
import { GENESIS_PREV, buildTemplate, verifyBlock } from '../src/chain.js';
import { assertNotEmptyHeld, planT21Round, t21LabelBook, t21LoginVoucher } from '../src/t21_template.js';
import { t21CarryBook, withCarry } from '../src/t21_carry.js';

const magic = 'shear-testnet-v12';

function tmpDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `t21-${tag}-`));
}

function lab(nc, payee, units, { count = 1, carried = false } = {}) {
  return { nc, payee, units: BigInt(units), count, carried };
}

const ncsOf = (rows) => rows.map((l) => l.nc);

const owedRow = (nc, payee, units, since) => ({ nc, payee, units: BigInt(units), w: BigInt(units), since, owed: true });

describe('T21 carry: planT21Round fills slots by units, defers in-block, and never cuts a label', () => {
  it('Sybil vouchers cannot take the payee slots from the hashers (MF-3)', () => {
    const sybils = Array.from({ length: 300 }, (_, i) => lab(`s${String(i).padStart(3, '0')}`, `sy${i}`, 1));
    const honest = [lab('h1', 'A', 1000), lab('h2', 'B', 900), lab('h3', 'C', 800)];
    const got = planT21Round({ labels: [...sybils, ...honest], payeeMax: 171 });
    assert.deepEqual(ncsOf(got.pay).slice(0, 3), ['h1', 'h2', 'h3']);
    assert.equal(got.payees, 171);
    // Past the cap the labels stay in the batch as deferred rows; none leaves the block.
    assert.equal(got.defer.length, 132);
    assert.ok(got.defer.every((l) => l.reason === 'payee_cap' && l.units === 1n));
    assert.equal(got.later.length, 0);
    assert.equal(got.batch.length, 303);
  });

  it('a payee with several labels counts its total units', () => {
    const got = planT21Round({
      labels: [lab('x1', 'X', 40), lab('x2', 'X', 40), lab('y1', 'Y', 70)],
      payeeMax: 1,
    });
    assert.deepEqual(ncsOf(got.pay).sort(), ['x1', 'x2']);
    assert.deepEqual(got.defer.map((l) => [l.nc, l.reason]), [['y1', 'payee_cap']]);
  });

  it('a round past the hash budget or the hash cap is rejected, with no leftover list', () => {
    const labels = [lab('a', 'A', 600), lab('b', 'B', 500), lab('c', 'C', 300), lab('d', 'D', 200)];
    const budget = planT21Round({ labels, unitBudget: 800n });
    assert.equal(budget.reject, 'hash_budget');
    assert.deepEqual(budget.later, []);
    assert.equal(budget.defer.length, 0);
    const pay = planT21Round({ labels, payMax: 1000n });
    assert.equal(pay.reject, 'hash_units');
    assert.deepEqual(pay.later, []);
    const batch = planT21Round({ labels, unitMax: 1000n });
    assert.equal(batch.reject, 'hash_units');
    assert.deepEqual(batch.batch, []);
  });

  it('the share cap rejects the round instead of moving a label out', () => {
    const got = planT21Round({ labels: [lab('a', 'A', 90, { count: 3 }), lab('b', 'B', 50, { count: 2 }), lab('c', 'C', 10, { count: 1 })], shareMax: 4 });
    assert.equal(got.reject, 'share_cap');
    assert.deepEqual(got.later, []);
    assert.equal(got.pay.length, 0);
  });

  it('slots fill largest-units first; a carried flag does not jump the queue', () => {
    const got = planT21Round({
      labels: [lab('big', 'F', 10_000), lab('old', 'O', 1, { carried: true }), lab('old2', 'P', 5, { carried: true })],
      payeeMax: 2,
    });
    assert.deepEqual(ncsOf(got.pay), ['big', 'old2']);
    assert.deepEqual(got.defer.map((l) => [l.nc, l.reason]), [['old', 'payee_cap']]);
    assert.deepEqual(got.later, []);
  });

  it('a finder label does not reserve a payee slot', () => {
    const got = planT21Round({ labels: [lab('a', 'A', 5), lab('b', 'B', 4)], payeeMax: 2, finderPayee: 'F' });
    assert.deepEqual(ncsOf(got.pay).sort(), ['a', 'b']);
    const own = planT21Round({ labels: [lab('a', 'A', 5), lab('f', 'F', 1)], payeeMax: 2, finderPayee: 'F' });
    assert.deepEqual(ncsOf(own.pay).sort(), ['a', 'f']);
  });

  it('owed rows settle outside the payee cap, oldest first', () => {
    const owed = [owedRow('o1', 'O', 3, 10), owedRow('o2', 'P', 2, 11)];
    const got = planT21Round({ labels: [lab('a', 'A', 1000), lab('b', 'B', 900)], owed, payeeMax: 3 });
    assert.deepEqual(ncsOf(got.pay), ['o1', 'o2', 'a', 'b']);
    assert.equal(got.defer.length, 0);
    const tight = planT21Round({ labels: [lab('a', 'A', 1000)], owed, payeeMax: 1 });
    assert.deepEqual(ncsOf(tight.pay), ['o1', 'o2', 'a']);
    assert.equal(tight.kept.length, 0);
    assert.equal(tight.defer.length, 0);
  });

  it('defer payees past the quota stay in this round instead of the node-local later list', () => {
    const labels = [lab('a', 'A', 9), lab('b', 'B', 8), lab('c', 'C', 7)];
    const got = planT21Round({ labels, payeeMax: 1, owedRoom: 1 });
    assert.equal(got.reject, null);
    assert.deepEqual(ncsOf(got.pay).sort(), ['a', 'c']);
    assert.deepEqual(ncsOf(got.defer), ['b']);
    assert.equal(got.later.length, 0);
    const one = planT21Round({ labels, payeeMax: 1, owedRoom: 2 });
    assert.equal(one.reject, null);
    assert.deepEqual(ncsOf(one.pay), ['a']);
    assert.deepEqual(ncsOf(one.defer), ['b', 'c']);
    assert.equal(one.later.length, 0);
    const full = Array.from({ length: T21_OWED_GLOBAL }, (_, i) => owedRow(`k${String(i).padStart(5, '0')}`, `K${i}`, 1, 1));
    const capped = planT21Round({
      labels: [lab('a', 'A', 9), lab('b', 'B', 8)], owed: full, payeeMax: 1, height: 2, settleFit: 0, owedRoom: T21_OWED_GLOBAL,
    });
    assert.equal(capped.reject, null);
    assert.equal(capped.defer.length, 0);
    assert.equal(capped.later.length, 0);
    assert.deepEqual(ncsOf(capped.pay).sort(), ['a', 'b']);
  });

  it('overflow for a payee the producer already escrowed folds into that row', () => {
    const producer = 'pool';
    const owed = [];
    for (let p = 0; p < 8; p += 1) {
      for (let i = 0; i < T21_OWED_MAX; i += 1) {
        const payee = p === 0 && i === 0 ? 'A' : `P${p}-${i}`;
        owed.push({ ...owedRow(`r${p}-${String(i).padStart(4, '0')}`, payee, 1, 1), by: p === 0 ? producer : `sybil-${p}` });
      }
    }
    assert.equal(owed.length, T21_OWED_GLOBAL);
    const got = planT21Round({
      labels: [lab('big', 'B', 100), lab('more', 'A', 5), lab('fresh', 'C', 4)],
      owed,
      payeeMax: 1,
      producer,
      height: 2,
      settleFit: 0,
      owedRoom: T21_OWED_MAX,
    });
    assert.equal(got.reject, null);
    assert.equal(got.later.length, 0);
    assert.equal(got.defer.length, 0);
    assert.deepEqual(ncsOf(got.pay).sort(), ['big', 'fresh']);
    assert.deepEqual(got.folds.map((l) => [l.nc, l.into, l.reason]), [['more', 'r0-0000', 'fold']]);
    assert.ok(got.batch.some((l) => l.nc === 'more'));
  });

  it('a seated producer under its quota still seals a row when the other seats are full', () => {
    const producer = 'honest';
    const owed = [{ ...owedRow('mine', 'M', 1, 1), by: producer }];
    for (let p = 0; p < 7; p += 1) {
      for (let i = 0; i < T21_OWED_MAX; i += 1) {
        owed.push({ ...owedRow(`q${p}-${String(i).padStart(4, '0')}`, `Q${p}-${i}`, 1, 1), by: `sy${p}` });
      }
    }
    const got = planT21Round({
      labels: [lab('a', 'A', 9), lab('b', 'B', 8)],
      owed,
      payeeMax: 1,
      producer,
      height: 2,
      settleFit: 0,
    });
    assert.equal(got.later.length, 0);
    assert.deepEqual(ncsOf(got.pay), ['a']);
    assert.deepEqual(ncsOf(got.defer), ['b']);
    const ninth = planT21Round({
      labels: [lab('a', 'A', 9), lab('b', 'B', 8)],
      owed,
      payeeMax: 1,
      producer: 'ninth',
      height: 2,
      settleFit: 0,
    });
    assert.equal(ninth.defer.length, 0);
    assert.equal(ninth.later.length, 0);
    assert.deepEqual(ncsOf(ninth.pay).sort(), ['a', 'b']);
  });

  it('a block settles its due prefix and still pays fresh hashers in the same blocks', () => {
    const fit = payeeCapLive();
    const since = 10;
    const start = since + (T21_OWED_TTL - T21_SETTLE_WINDOW);
    const dueRows = (n, tag) => Array.from({ length: n }, (_, i) => owedRow(`${tag}${String(i).padStart(5, '0')}`, `P${i % 7}`, 1, since));
    for (const n of [0, 1, 1024, 1024 * 8]) {
      let left = dueRows(n, 'd');
      let height = start;
      let steps = 0;
      if (n === 0) {
        const open = planT21Round({
          labels: [lab('a', 'A', 10)], owed: [], payeeMax: 2, height: start, settleFit: fit,
        });
        assert.deepEqual(ncsOf(open.pay), ['a']);
      }
      while (left.length) {
        const plan = planT21Round({
          labels: [lab('a', 'A', 10), lab('b', 'B', 9)],
          owed: left,
          payeeMax: 2,
          height,
          settleFit: fit,
        });
        assert.equal(plan.reject, null);
        const settled = plan.pay.filter((p) => p.owed);
        const fresh = plan.pay.filter((p) => !p.owed);
        assert.equal(settled.length, Math.min(fit, left.length));
        assert.deepEqual(ncsOf(fresh).sort(), ['a', 'b']);
        assert.equal(plan.later.length, 0);
        const paid = new Set(settled.map((p) => p.nc));
        left = left.filter((o) => !paid.has(o.nc));
        height += 1;
        steps += 1;
        assert.ok(steps <= T21_SETTLE_WINDOW);
      }
      assert.equal(left.length, 0);
      assert.ok(height <= since + T21_OWED_TTL + 1);
    }
    const idle = dueRows(1, 'z');
    const atTtl = planT21Round({ labels: [], owed: idle, height: since + T21_OWED_TTL, settleFit: fit });
    assert.equal(atTtl.pay.filter((p) => p.owed).length, 1);
  });

  it('1,024 rows falling due at once still pay fresh hashers in those blocks', () => {
    const fit = payeeCapLive();
    const since = 10;
    let left = Array.from({ length: 1024 }, (_, i) => owedRow(`d${String(i).padStart(5, '0')}`, `P${i}`, 1, since));
    let height = since + (T21_OWED_TTL - T21_SETTLE_WINDOW);
    const seen = new Set();
    while (left.length) {
      const plan = planT21Round({
        labels: [lab('h1', 'H1', 20), lab('h2', 'H2', 10)],
        owed: left,
        payeeMax: fit,
        height,
        settleFit: fit,
        producer: 'honest',
      });
      assert.equal(plan.reject, null);
      assert.equal(plan.later.length, 0);
      const fresh = plan.pay.filter((p) => !p.owed);
      assert.deepEqual(ncsOf(fresh).sort(), ['h1', 'h2']);
      for (const l of fresh) seen.add(l.nc);
      const paid = new Set(plan.pay.filter((p) => p.owed).map((p) => p.nc));
      assert.equal(paid.size, Math.min(fit, left.length));
      left = left.filter((o) => !paid.has(o.nc));
      height += 1;
    }
    assert.deepEqual([...seen].sort(), ['h1', 'h2']);
    assert.ok(height <= since + T21_OWED_TTL + 1);
  });

  it('eight sybil producers filling 8,192 rows due together cannot blank honest hashers', () => {
    const fit = payeeCapLive();
    const since = 10;
    const owed = [];
    for (let p = 0; p < 8; p += 1) {
      for (let i = 0; i < T21_OWED_MAX; i += 1) {
        owed.push({ ...owedRow(`s${p}-${String(i).padStart(4, '0')}`, `S${p}-${i}`, 1, since), by: `sybil-${p}` });
      }
    }
    assert.equal(owed.length, T21_OWED_GLOBAL);
    const honest = [lab('h1', 'H1', 50), lab('h2', 'H2', 40), lab('h3', 'H3', 30)];
    let left = owed;
    let height = since + (T21_OWED_TTL - T21_SETTLE_WINDOW);
    const credited = new Set();
    while (left.length) {
      const plan = planT21Round({
        labels: honest,
        owed: left,
        payeeMax: fit,
        height,
        settleFit: fit,
        producer: 'honest',
      });
      assert.equal(plan.reject, null);
      assert.equal(plan.later.length, 0);
      const fresh = plan.pay.filter((p) => !p.owed);
      assert.deepEqual(ncsOf(fresh).sort(), ['h1', 'h2', 'h3']);
      for (const l of fresh) credited.add(l.nc);
      const settled = plan.pay.filter((p) => p.owed);
      assert.equal(settled.length, Math.min(fit, left.length));
      const paid = new Set(settled.map((p) => p.nc));
      left = left.filter((o) => !paid.has(o.nc));
      height += 1;
      assert.ok(height <= since + T21_OWED_TTL + 1);
    }
    assert.deepEqual([...credited].sort(), ['h1', 'h2', 'h3']);
  });

  it('a round that can pay nothing defers nothing; a payable one never publishes empty (MF-4)', () => {
    const none = planT21Round({ labels: [lab('a', 'A', 9)], payeeMax: 0 });
    assert.equal(none.pay.length, 0);
    assert.equal(none.defer.length, 0);
    assert.deepEqual(none.unplaced.map((l) => [l.nc, l.reason]), [['a', 'payee_cap']]);
    assert.deepEqual(none.later, []);
    assert.doesNotThrow(() => assertNotEmptyHeld(none, { payeeMax: 0 }));
    // A plan that held a payable label and paid none is a template bug.
    const forged = { pay: [], kept: [], later: [{ ...lab('a', 'A', 9), reason: 'payee_cap' }] };
    assert.throws(() => assertNotEmptyHeld(forged, { payeeMax: 171 }), /t21_empty_batch/);
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

/** Pool blocks put the producer admit base on the miner dest. Escrow rows bind `by` to it. */
function producerMiner() {
  const id = newIdentity();
  return encodeDest(hash20FromAddress(id.address), id.admitBase);
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
  const miner = producerMiner();
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

describe('T21 carry: the share cap rejects the round', () => {
  it('seven shares into a four-share template throw share_cap and publish nothing', () => {
    const labels = t21LabelBook({ magic });
    const carry = t21CarryBook();
    const g = sealGenesis();
    const onG = [26, 25, 24, 23, 22, 21, 20].map((bits, i) => mineShare(labels, 10 + i, g, BigInt(100 + i), bits));
    assert.throws(() => mineChild({ parent: g, grand: null, carry, labels, fresh: onG, t21: { shareMax: 4 } }), (err) => err.reason === 'share_cap' || err.message === 'share_cap');
    assert.equal(carry.stats().expiredShares, 0);
  });
});

describe('T21 payee-cap escrow: sealed value is paid by any producer, including after the label is evicted', () => {
  it('overflow is one escrow row from this round, settled after the label book drops it, and again on a reorg', () => {
    const labels = t21LabelBook({ magic, keep: 3 });
    const carry = t21CarryBook();
    const g = sealGenesis();
    const unitsOf = (s) => 1n << BigInt(s.shareBits);
    const small = mineShare(labels, 60, g, 500n, 22);
    const large = [mineShare(labels, 61, g, 501n, 26), mineShare(labels, 62, g, 502n, 25)];
    const escrowNc = noteCommitOfShare(small).toString('hex');
    const escrowE = Buffer.from(labels.labelOf(escrowNc).E);

    const b2 = mineChild({ parent: g, grand: null, carry, labels, fresh: [...large, small], t21: { payeeMax: 2 } });
    const owed = b2.block.txs[0].t21.owed;
    assert.equal(owed.length, 1);
    assert.equal(owed[0].shares.length, 1);
    assert.equal(owed[0].since, 2);
    assert.ok(Buffer.from(owed[0].shares[0].E).equals(escrowE));
    assert.equal(BigInt(owed[0].hash), unitsOf(small));
    assert.equal(b2.tpl.t21Later.length, 0);
    assert.ok(b2.block.supply.escrow > 0n);
    assert.equal(b2.block.supply.escrow, BigInt(owed[0].pot) + BigInt(owed[0].hash));

    labels.issue(t21LoginVoucher(Buffer.alloc(32, 99)));
    assert.equal(labels.labelOf(escrowNc), null);

    const b3 = mineChild({ parent: b2.block, grand: g, carry, labels, fresh: [], t21: { payeeMax: 2 } });
    assert.equal(b3.block.txs[0].t21.shares.length, 0);
    assert.equal(b3.block.txs[0].t21.owed, undefined);
    assert.equal(b3.tpl.t21OwedPaid.length, 1);
    const settle = b3.block.txs[0].vout.find((o) => o.kind === 'settle');
    assert.ok(settle);
    assert.ok(Buffer.from(settle.B).equals(Buffer.from(owed[0].B)));
    assert.equal(b3.block.supply.escrow, 0n);
    assert.equal(b3.block.supply.mintedPot - b2.block.supply.mintedPot, BigInt(owed[0].pot));
    assert.equal(b3.block.supply.mintedHash - b2.block.supply.mintedHash, BigInt(owed[0].hash));

    const b3r = mineChild({ parent: b2.block, grand: g, carry, labels, fresh: [], t21: { payeeMax: 2 }, n: 5 });
    assert.equal(b3r.block.supply.escrow, 0n);
    assert.equal(b3r.block.supply.mintedHash - b2.block.supply.mintedHash, BigInt(owed[0].hash));
    assert.notEqual(b3r.block.hash.toString('hex'), b3.block.hash.toString('hex'));
  });

  it('a share on a label that is already owed is refused, not paid twice', () => {
    const labels = t21LabelBook({ magic });
    const carry = t21CarryBook();
    const g = sealGenesis();
    const onG = [24, 23, 22].map((bits, i) => mineShare(labels, 80 + i, g, BigInt(700 + i), bits));
    const b2 = mineChild({ parent: g, grand: null, carry, labels, fresh: onG, t21: { payeeMax: 1 } });
    const owedNc = noteCommitOfShare(onG[2]);
    const again = {
      noteCommit: owedNc, nonce: nonceWithShareTarget(800n, 21), lz: 21, shareBits: 21, creditedShareBits: 21,
      verifiedHeader: b2.block.header,
    };
    rememberLiveSharePow(b2.block.header, again.nonce, { noteCommit: owedNc, shareBits: 21, lz: 21 });
    const b3 = mineChild({ parent: b2.block, grand: g, carry, labels, fresh: [again], t21: { payeeMax: 171 } });
    assert.deepEqual(b3.tpl.t21Refused.map((s) => s.deferReason), ['label_owed']);
    assert.equal(b3.block.txs[0].t21.shares.length, 0);
    assert.equal(b3.tpl.t21OwedPaid.length, 2);
    assert.equal(b3.block.txs[0].t21.owed, undefined);
  });
});
