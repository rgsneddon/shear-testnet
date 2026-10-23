import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { HASH_BONUS_NANOS } from './asert.js';
import { noteCommitOfDest20 } from './note.js';
import { nonceWithShareTarget, retainedUnitsByCommit, unitsForShare } from './share_batch.js';
import {
  ATTEST_WINDOW,
  FLOOR_PER_PROD,
  OPEN_WINDOW,
  admitLate,
  capUnitsForProd,
  challengerBondNanos,
  collectWindow,
  commitmentId,
  finalizeRound,
  openFraud,
  preferTip,
  producerIdFromPublicKey,
  proveLeaf,
  retainProRata,
  sampleLeafCount,
  sealRound,
  signShareCommitment,
  timelyRoot,
} from './share_commit_018e.js';

const UNIT = BigInt(HASH_BONUS_NANOS);

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { publicKey, privateKey, id: producerIdFromPublicKey(publicKey) };
}

function boundLeaf(destByte, bits) {
  const dest20 = Buffer.alloc(20, destByte);
  const units = BigInt(unitsForShare(bits));
  const noteCommit = noteCommitOfDest20(dest20);
  return { dest20, bits, units, noteCommit, noteHex: noteCommit.toString('hex') };
}

function inflatedLeaf(destByte, bits, claimedUnits) {
  const leaf = boundLeaf(destByte, bits);
  return { ...leaf, units: BigInt(claimedUnits) };
}

function attest(producer, parentHash, roundHeight, leaves) {
  const body = {
    producerId: producer.id,
    parentHash,
    roundHeight,
    leaves,
  };
  return {
    body,
    sig: signShareCommitment(producer.privateKey, body),
    publicKey: producer.publicKey,
    id: commitmentId(body),
  };
}

function windowBlocks(parentHeight, parentHash, steps) {
  const blocks = [];
  let prev = parentHash;
  for (let i = 0; i < steps.length; i += 1) {
    const height = parentHeight + 1 + i;
    const hash = `canon-${parentHeight}-${height}`;
    blocks.push({
      height,
      hash,
      parentHash: prev,
      attested: steps[i],
    });
    prev = hash;
  }
  return blocks;
}

function sealOf(blocks, includedIds, opts = {}) {
  return sealRound({
    parentHeight: opts.parentHeight ?? 10,
    parentHash: opts.parentHash ?? 'parent-p',
    blocks,
    includedIds,
    scMempoolRoot: opts.scMempoolRoot,
    feeBps: opts.feeBps ?? 0,
    capUnitsBlock: opts.capUnitsBlock ?? 1_000_000,
    work: opts.work ?? 1,
    window: opts.window,
    headerSeed: opts.headerSeed,
  });
}

describe('018e inbox share-commitment seal', () => {
  it('Timely* only grows across the attest window and W_a is at least 2', () => {
    assert.ok(ATTEST_WINDOW >= 2);
    const parentHeight = 40;
    const parentHash = 'parent-grow';
    const a = keypair();
    const b = keypair();
    const first = attest(a, parentHash, parentHeight, [boundLeaf(1, 8)]);
    const second = attest(b, parentHash, parentHeight, [boundLeaf(2, 10)]);
    const blocks = windowBlocks(parentHeight, parentHash, [[first], [second]]);
    const collected = collectWindow({ parentHeight, parentHash, blocks, window: ATTEST_WINDOW });
    assert.equal(collected.ok, true);
    assert.deepEqual(collected.timelyIds, [first.id, second.id]);
    const sealed = sealOf(blocks, [first.id, second.id], { parentHeight, parentHash, capUnitsBlock: 1_000_000 });
    assert.equal(sealed.ok, true);
    assert.deepEqual(sealed.timelyIds, [first.id, second.id]);
    const short = sealOf(blocks, [first.id, second.id], { parentHeight, parentHash, window: 1 });
    assert.equal(short.ok, false);
    assert.equal(short.reason, 'window_short');
  });

  it('omitting one foreign timely commitment invalidates the seal', () => {
    const parentHash = 'parent-omit-one';
    const producers = [keypair(), keypair(), keypair()];
    const rows = producers.map((producer, i) => attest(producer, parentHash, 10, [boundLeaf(10 + i, 8)]));
    const blocks = windowBlocks(10, parentHash, [rows.slice(0, 2), rows.slice(2)]);
    const omitted = sealOf(blocks, [rows[0].id, rows[1].id], { parentHash });
    assert.equal(omitted.ok, false);
    assert.equal(omitted.reason, 'omit_timely');
    assert.deepEqual(omitted.missingIds, [rows[2].id]);
    assert.equal(omitted.retainedUnits, 0n);
    assert.equal(omitted.provEscrowNanos, 0n);
    assert.equal(omitted.owedDeltaNanos, 0n);
    assert.equal(omitted.hashMintedNanos, 0n);
  });

  it('omitting many foreign timely commitments invalidates the seal', () => {
    const parentHash = 'parent-omit-many';
    const producers = [keypair(), keypair(), keypair(), keypair()];
    const rows = producers.map((producer, i) => attest(producer, parentHash, 12, [boundLeaf(20 + i, 9)]));
    const blocks = windowBlocks(12, parentHash, [rows.slice(0, 2), rows.slice(2)]);
    const omitted = sealOf(blocks, [rows[0].id], { parentHash, parentHeight: 12 });
    assert.equal(omitted.ok, false);
    assert.equal(omitted.reason, 'omit_timely');
    assert.equal(omitted.missingIds.length, 3);
    assert.ok(omitted.missingIds.includes(rows[1].id));
    assert.ok(omitted.missingIds.includes(rows[2].id));
    assert.ok(omitted.missingIds.includes(rows[3].id));
    assert.equal(omitted.provEscrowNanos, 0n);
    assert.equal(omitted.owedDeltaNanos, 0n);
  });

  it('omitting all timely commitments invalidates the seal', () => {
    const parentHash = 'parent-omit-all';
    const producers = [keypair(), keypair(), keypair()];
    const rows = producers.map((producer, i) => attest(producer, parentHash, 15, [boundLeaf(30 + i, 8)]));
    const blocks = windowBlocks(15, parentHash, [[rows[0], rows[1]], [rows[2]]]);
    const omitted = sealOf(blocks, [], { parentHash, parentHeight: 15 });
    assert.equal(omitted.ok, false);
    assert.equal(omitted.reason, 'omit_timely');
    assert.equal(omitted.missingIds.length, 3);
    assert.equal(omitted.retainedUnits, 0n);
    assert.equal(omitted.hashMintedNanos, 0n);
    assert.equal(omitted.owedDeltaNanos, 0n);
  });

  it('a friends-only set under a binding cap does not overpay', () => {
    const parentHash = 'parent-friends';
    const parentHeight = 18;
    const cap = 1000n;
    const friend = keypair();
    const foreign = keypair();
    const friendLeaf = boundLeaf(4, 10);
    const foreignLeaf = boundLeaf(5, 10);
    assert.equal(friendLeaf.units, 1024n);
    const friendRow = attest(friend, parentHash, parentHeight, [friendLeaf]);
    const foreignRow = attest(foreign, parentHash, parentHeight, [foreignLeaf]);
    const blocks = windowBlocks(parentHeight, parentHash, [[friendRow], [foreignRow]]);
    const honest = sealOf(blocks, [friendRow.id, foreignRow.id], { parentHash, parentHeight, capUnitsBlock: cap });
    const thin = sealOf(blocks, [friendRow.id], { parentHash, parentHeight, capUnitsBlock: cap });
    assert.equal(honest.ok, true);
    assert.equal(honest.prodStar, 2);
    assert.equal(honest.capUnitsProd, capUnitsForProd(2, cap));
    assert.notEqual(honest.capUnitsProd, capUnitsForProd(1, cap));
    const capProd = capUnitsForProd(honest.prodStar, cap);
    const honestKept = (friendLeaf.units * capProd) / friendLeaf.units;
    assert.equal(honest.retainedByDest.get(friendLeaf.noteHex), honestKept);
    assert.equal(honest.retainedByDest.get(foreignLeaf.noteHex), honestKept);
    const thinBug = retainProRata(new Map([[friendLeaf.noteHex, friendLeaf.units]]), capUnitsForProd(1, cap));
    assert.ok(thinBug.retained.get(friendLeaf.noteHex) > honest.retainedByDest.get(friendLeaf.noteHex));
    assert.equal(thin.ok, false);
    assert.equal(thin.reason, 'omit_timely');
    assert.equal(thin.retainedUnits, 0n);
    assert.equal(thin.provEscrowNanos, 0n);
    assert.equal(thin.owedDeltaNanos, 0n);
    assert.equal(thin.retainedByDest.get(friendLeaf.noteHex), undefined);
  });

  it('CapUnits_prod is Prod* after nulls, not the size of a thin pre-seal set', () => {
    const parentHash = 'parent-prod';
    const rows = [keypair(), keypair(), keypair()].map((producer, i) => (
      attest(producer, parentHash, 10, [boundLeaf(40 + i, 8)])
    ));
    const blocks = windowBlocks(10, parentHash, [rows.slice(0, 2), rows.slice(2)]);
    const full = sealOf(blocks, rows.map((row) => row.id), { parentHash, capUnitsBlock: 900 });
    assert.equal(full.ok, true);
    assert.equal(full.prodStar, 3);
    assert.equal(full.capUnitsProd, capUnitsForProd(3, 900));
    assert.equal(full.capUnitsProd, FLOOR_PER_PROD > 300n ? FLOOR_PER_PROD : 300n);
    const thin = sealOf(blocks, [rows[0].id], { parentHash, capUnitsBlock: 900 });
    assert.equal(thin.ok, false);
    assert.equal(thin.provEscrowNanos, 0n);
  });

  it('a late commitment after the window does not redistribute a capped pie', () => {
    const parentHash = 'parent-late-cap';
    const parentHeight = 22;
    const cap = 1000n;
    const a = keypair();
    const b = keypair();
    const lateProducer = keypair();
    const leafA = boundLeaf(6, 10);
    const leafB = boundLeaf(7, 10);
    const rowA = attest(a, parentHash, parentHeight, [leafA]);
    const rowB = attest(b, parentHash, parentHeight, [leafB]);
    const blocks = windowBlocks(parentHeight, parentHash, [[rowA], [rowB]]);
    const sealed = sealOf(blocks, [rowA.id, rowB.id], { parentHash, parentHeight, capUnitsBlock: cap });
    assert.equal(sealed.ok, true);
    assert.equal(sealed.retainedUnits, cap);
    const lateLeaf = boundLeaf(8, 10);
    const late = attest(lateProducer, parentHash, parentHeight, [lateLeaf]);
    const after = admitLate(sealed, late);
    assert.equal(after.lateAdmittedUnits, 0n);
    assert.equal(after.redistributed, false);
    assert.deepEqual(after.retainedByDest, sealed.retainedByDest);
    assert.equal(after.provEscrowNanos, sealed.provEscrowNanos);
    assert.equal(after.owedDeltaNanos, sealed.owedDeltaNanos);
    assert.equal(after.hashMintedNanos, sealed.hashMintedNanos);
    assert.equal(after.retainedByDest.get(lateLeaf.noteHex), undefined);
  });

  it('a late commitment takes only unused headroom when the cap is not binding', () => {
    const parentHash = 'parent-late-room';
    const parentHeight = 24;
    const cap = 3000n;
    const a = keypair();
    const b = keypair();
    const leafA = boundLeaf(11, 10);
    const leafB = boundLeaf(12, 10);
    const rowA = attest(a, parentHash, parentHeight, [leafA]);
    const rowB = attest(b, parentHash, parentHeight, [leafB]);
    const blocks = windowBlocks(parentHeight, parentHash, [[rowA], [rowB]]);
    const sealed = sealOf(blocks, [rowA.id, rowB.id], { parentHash, parentHeight, capUnitsBlock: cap });
    assert.equal(sealed.ok, true);
    assert.ok(sealed.retainedUnits < cap);
    const beforeA = sealed.retainedByDest.get(leafA.noteHex);
    const beforeB = sealed.retainedByDest.get(leafB.noteHex);
    const lateLeaf = boundLeaf(13, 10);
    const late = attest(keypair(), parentHash, parentHeight, [lateLeaf]);
    const after = admitLate(sealed, late);
    const headroom = cap - sealed.retainedUnits;
    const expectLate = lateLeaf.units > headroom ? headroom : lateLeaf.units;
    assert.equal(after.lateAdmittedUnits, expectLate);
    assert.ok(expectLate > 0n);
    assert.ok(expectLate < lateLeaf.units);
    assert.equal(after.redistributed, false);
    assert.equal(after.retainedByDest.get(leafA.noteHex), beforeA);
    assert.equal(after.retainedByDest.get(leafB.noteHex), beforeB);
    assert.equal(after.owedDeltaNanos, sealed.owedDeltaNanos);
    assert.equal(after.provEscrowNanos, sealed.provEscrowNanos);
  });

  it('equivocation nulls both commitments and Prod* excludes them', () => {
    const parentHash = 'parent-equiv';
    const parentHeight = 28;
    const cheat = keypair();
    const honest = keypair();
    const left = attest(cheat, parentHash, parentHeight, [boundLeaf(14, 8)]);
    const right = attest(cheat, parentHash, parentHeight, [boundLeaf(15, 9)]);
    assert.notEqual(left.id, right.id);
    const goodLeaf = boundLeaf(16, 8);
    const good = attest(honest, parentHash, parentHeight, [goodLeaf]);
    const blocks = windowBlocks(parentHeight, parentHash, [[left, right], [good]]);
    const sealed = sealOf(blocks, [left.id, right.id, good.id], {
      parentHash,
      parentHeight,
      capUnitsBlock: 1_000_000,
    });
    assert.equal(sealed.ok, true);
    assert.equal(sealed.prodStar, 1);
    assert.ok(sealed.nulledProducers.includes(cheat.id));
    assert.equal(sealed.retainedByDest.get(boundLeaf(14, 8).noteHex), undefined);
    assert.equal(sealed.retainedByDest.get(boundLeaf(15, 9).noteHex), undefined);
    assert.equal(sealed.retainedByDest.get(goodLeaf.noteHex), goodLeaf.units);
    assert.equal(sealed.byCommitment.has(left.id), false);
    assert.equal(sealed.byCommitment.has(right.id), false);
    const dropped = sealOf(blocks, [right.id, good.id], { parentHash, parentHeight });
    assert.equal(dropped.ok, false);
    assert.equal(dropped.reason, 'omit_timely');
  });

  it('a fraud opening claws the escrow and pays the challenger from the bond', () => {
    const parentHash = 'parent-fraud';
    const parentHeight = 33;
    const cheat = keypair();
    const honest = keypair();
    const challenger = keypair();
    const honestLeaf = boundLeaf(17, 8);
    const claimed = 1024n;
    const fake = inflatedLeaf(18, 8, claimed);
    assert.equal(proveLeaf(fake).ok, false);
    assert.equal(proveLeaf(honestLeaf).ok, true);
    const fraud = attest(cheat, parentHash, parentHeight, [fake]);
    const good = attest(honest, parentHash, parentHeight, [honestLeaf]);
    const blocks = windowBlocks(parentHeight, parentHash, [[fraud], [good]]);
    const sealed = sealOf(blocks, [fraud.id, good.id], { parentHash, parentHeight, capUnitsBlock: 1_000_000 });
    assert.equal(sealed.ok, true);
    assert.equal(sealed.byCommitment.get(fraud.id).escrowNanos, claimed * UNIT);
    const opened = openFraud(sealed, { commitmentId: fraud.id, challengerId: challenger.id });
    assert.equal(opened.clawed, true);
    assert.equal(opened.fraudEscrowNanos, 0n);
    assert.equal(opened.clawedEscrowNanos, claimed * UNIT);
    assert.equal(opened.challengerPaidNanos, challengerBondNanos(claimed));
    assert.equal(opened.challengerPaidNanos, claimed * UNIT);
    assert.notEqual(challengerBondNanos(claimed), challengerBondNanos(honestLeaf.units));
    assert.equal(opened.retainedByDest.get(fake.noteHex), undefined);
    assert.equal(opened.retainedByDest.get(honestLeaf.noteHex), honestLeaf.units);
    const honestOnly = sealOf(
      windowBlocks(parentHeight, parentHash, [[], [good]]),
      [good.id],
      { parentHash, parentHeight, capUnitsBlock: 1_000_000 },
    );
    assert.equal(opened.retainedByDest.get(honestLeaf.noteHex), honestOnly.retainedByDest.get(honestLeaf.noteHex));
    assert.equal(opened.provEscrowNanos, honestLeaf.units * UNIT);
    const bound = openFraud(sealed, { commitmentId: good.id, challengerId: challenger.id });
    assert.equal(bound.clawed, false);
    assert.equal(bound.challengerPaidNanos, 0n);
    assert.equal(bound.provEscrowNanos, sealed.provEscrowNanos);
    const early = finalizeRound(opened, { openingCount: OPEN_WINDOW - 1 });
    assert.equal(early.ok, false);
    assert.equal(early.reason, 'early_finalize');
    assert.equal(early.hashMintedNanos, 0n);
    const fin = finalizeRound(opened, { openingCount: OPEN_WINDOW });
    assert.equal(fin.ok, true);
    assert.equal(fin.hashMintedNanos, honestLeaf.units * UNIT);
    assert.equal(fin.hashMintedNanos + fin.owedDeltaNanos, honestLeaf.units * UNIT);
    assert.ok(fin.hashMintedNanos < fin.hashMintedNanos + fin.challengerPaidNanos);
  });

  it('empty Timely* pays zero hash bonus and a competing tip replaces a bad seal', () => {
    const parentHash = 'parent-empty';
    const parentHeight = 50;
    const blocks = windowBlocks(parentHeight, parentHash, [[], []]);
    const empty = sealOf(blocks, [], { parentHash, parentHeight, work: 2 });
    assert.equal(empty.ok, true);
    assert.equal(empty.timelyCount, 0);
    assert.equal(empty.prodStar, 0);
    assert.equal(empty.provEscrowNanos, 0n);
    assert.equal(empty.owedDeltaNanos, 0n);
    assert.equal(empty.hashMintedNanos, 0n);
    const fin = finalizeRound(empty, { openingCount: 0 });
    assert.equal(fin.ok, true);
    assert.equal(fin.hashMintedNanos, 0n);
    const producer = keypair();
    const row = attest(producer, parentHash, parentHeight, [boundLeaf(19, 8)]);
    const busy = windowBlocks(parentHeight, parentHash, [[row], []]);
    const bad = sealOf(busy, [], { parentHash, parentHeight, work: 9 });
    assert.equal(bad.ok, false);
    const chosen = preferTip(bad, empty);
    assert.equal(chosen.ok, true);
    assert.equal(chosen.timelyCount, 0);
    assert.equal(chosen.hashMintedNanos, 0n);
    assert.equal(preferTip(empty, bad), chosen);
  });

  it('a fee never touches the hash bonus or the owed ledger', () => {
    const parentHash = 'parent-fee';
    const parentHeight = 60;
    const cap = 1000n;
    const a = keypair();
    const b = keypair();
    const rowA = attest(a, parentHash, parentHeight, [boundLeaf(21, 10)]);
    const rowB = attest(b, parentHash, parentHeight, [boundLeaf(22, 10)]);
    const blocks = windowBlocks(parentHeight, parentHash, [[rowA], [rowB]]);
    const ids = [rowA.id, rowB.id];
    const plain = sealOf(blocks, ids, { parentHash, parentHeight, capUnitsBlock: cap, feeBps: 0 });
    const feed = sealOf(blocks, ids, { parentHash, parentHeight, capUnitsBlock: cap, feeBps: 10_000 });
    assert.equal(plain.ok, true);
    assert.equal(feed.ok, true);
    assert.equal(feed.feeBps, 10_000);
    assert.equal(feed.feeOnBonusNanos, 0n);
    assert.equal(feed.feeOnOwedNanos, 0n);
    assert.equal(feed.provEscrowNanos, plain.provEscrowNanos);
    assert.equal(feed.owedDeltaNanos, plain.owedDeltaNanos);
    assert.equal(feed.hashMintedNanos, plain.hashMintedNanos);
    assert.equal(feed.retainedUnits, plain.retainedUnits);
    assert.deepEqual(feed.retainedByDest, plain.retainedByDest);
    const fin = finalizeRound(feed, { openingCount: OPEN_WINDOW });
    assert.equal(fin.feeOnBonusNanos, 0n);
    assert.equal(fin.feeOnOwedNanos, 0n);
    assert.equal(fin.hashMintedNanos, plain.provEscrowNanos);
    assert.equal(fin.owedDeltaNanos, plain.owedDeltaNanos);
  });

  it('hash minted plus the owed delta reconciles with units times HASH_BONUS_NANOS', () => {
    const parentHash = 'parent-supply';
    const parentHeight = 70;
    const cap = 1000n;
    const leafA = boundLeaf(23, 10);
    const leafB = boundLeaf(24, 11);
    const rowA = attest(keypair(), parentHash, parentHeight, [leafA]);
    const rowB = attest(keypair(), parentHash, parentHeight, [leafB]);
    const submitted = leafA.units + leafB.units;
    const blocks = windowBlocks(parentHeight, parentHash, [[rowA], [rowB]]);
    const sealed = sealOf(blocks, [rowA.id, rowB.id], { parentHash, parentHeight, capUnitsBlock: cap });
    assert.equal(sealed.ok, true);
    assert.ok(sealed.owedDeltaNanos > 0n);
    assert.equal(sealed.provEscrowNanos + sealed.owedDeltaNanos, submitted * UNIT);
    const fin = finalizeRound(sealed, { openingCount: OPEN_WINDOW });
    assert.equal(fin.ok, true);
    assert.equal(fin.hashMintedNanos + fin.owedDeltaNanos, submitted * UNIT);
    assert.equal(fin.hashMintedNanos, sealed.retainedUnits * UNIT);
    assert.equal(fin.owedDeltaNanos, sealed.owedUnits * UNIT);
  });

  it('a free-form scMempoolRoot cannot lie about the timely set', () => {
    const parentHash = 'parent-root';
    const row = attest(keypair(), parentHash, 10, [boundLeaf(25, 8)]);
    const blocks = windowBlocks(10, parentHash, [[row], []]);
    const root = timelyRoot([row.id]);
    const honest = sealOf(blocks, [row.id], { parentHash, scMempoolRoot: root });
    assert.equal(honest.ok, true);
    const liar = sealOf(blocks, [row.id], { parentHash, scMempoolRoot: 'ab'.repeat(32) });
    assert.equal(liar.ok, false);
    assert.equal(liar.reason, 'liar_root');
    assert.equal(liar.provEscrowNanos, 0n);
    assert.equal(liar.owedDeltaNanos, 0n);
  });

  it('pro-rata retention matches retainedUnitsByCommit on the same units', () => {
    const left = boundLeaf(26, 8);
    const right = boundLeaf(27, 9);
    const cap = 100;
    const fromSeal = retainProRata(new Map([
      [left.noteHex, left.units],
      [right.noteHex, right.units],
    ]), cap);
    const fromBatch = retainedUnitsByCommit([
      { noteCommit: left.noteCommit, nonce: nonceWithShareTarget(1n, 8), shareBits: 8 },
      { noteCommit: right.noteCommit, nonce: nonceWithShareTarget(2n, 9), shareBits: 9 },
    ], cap);
    assert.equal(fromBatch.size, fromSeal.retained.size);
    for (const [hex, units] of fromSeal.retained) {
      assert.equal(fromBatch.get(hex), Number(units));
    }
    assert.equal(sampleLeafCount(1), 1);
    assert.ok(sampleLeafCount(64) > sampleLeafCount(1));
    assert.ok(sampleLeafCount(64) <= 64);
  });
});
