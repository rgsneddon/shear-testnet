/**
 * Inbox 018e share-commitment seal.
 *
 * Timely*(P) is the growing union of Share Commitment ids attested on the
 * canonical blocks from h+1 through h+W_a (W_a is at least 2). The seal at
 * h+W_a that omits any of those ids is an invalid block. A free-form
 * scMempoolRoot cannot stand in for that set.
 *
 * Prod* is the distinct producer ids in that set after equivocation nulls.
 * CapUnits_prod is max(FloorPerProd, CapUnits_block / Prod*), never the size
 * of a thin pre-seal set. Empty Timely* pays zero hash bonus. A late
 * commitment does not redistribute an already-capped pie. Equivocation nulls
 * both commitments. A fraud opening claws that commitment's escrow and pays
 * the challenger from a bond that is HASH_BONUS times the claimed units.
 * Fees do not touch the bonus or the owed ledger.
 *
 * This module does not zero shareBatch pay and it is not wired through
 * crypto/admit.js. Consensus admission stays unchanged until that sign-off.
 */
import { createHash, sign, verify } from 'node:crypto';
import {
  HASH_BONUS_NANOS,
  MAX_HASH_UNITS_PER_BLOCK,
  SHARE_FLOOR_BITS,
  hashBonusUnitNanos,
} from './asert.js';
import { unitsForShare } from './share_batch.js';
import { noteCommitOfDest20 } from './note.js';

/** Attest window W_a. The law requires at least 2. */
export const ATTEST_WINDOW = 2;
/** Openings required before provisional escrow may finalize. At least 2. */
export const OPEN_WINDOW = 2;
/** One floor share. CapUnits_prod never falls below this while Prod* > 0. */
export const FLOOR_PER_PROD = 2 ** SHARE_FLOOR_BITS;
export const SHARE_COMMIT_LAW = 'inbox-seal-018e';

function asUnits(v) {
  if (typeof v === 'bigint') return v < 0n ? 0n : v;
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n < 0) return 0n;
  return BigInt(n);
}

function hexOf(v, len) {
  if (Buffer.isBuffer(v) && v.length === len) return v.toString('hex');
  if (v instanceof Uint8Array && v.length === len) return Buffer.from(v).toString('hex');
  const s = String(v ?? '');
  if (/^[0-9a-fA-F]+$/.test(s) && s.length === len * 2) return s.toLowerCase();
  return null;
}

function sumUnits(map) {
  let n = 0n;
  for (const u of map.values()) n += u;
  return n;
}

function cloneMap(map) {
  return new Map(map ? [...map.entries()] : []);
}

export function producerIdFromPublicKey(publicKey) {
  const der = publicKey.export({ type: 'spki', format: 'der' });
  return Buffer.from(der.subarray(-32)).toString('hex');
}

/** Stable bytes of a Share Commitment body. The id is the hash of these bytes. */
export function canonicalCommitmentBytes(body) {
  const leaves = (body?.leaves || []).map((leaf) => {
    const noteCommit = hexOf(leaf.noteCommit, 32);
    const dest20 = hexOf(leaf.dest20, 20);
    if (!noteCommit || !dest20) throw new Error('leaf_bytes');
    return {
      noteCommit,
      dest20,
      bits: Math.floor(Number(leaf.bits)),
      units: BigInt(leaf.units).toString(10),
    };
  }).sort((a, b) => (a.noteCommit < b.noteCommit ? -1 : a.noteCommit > b.noteCommit ? 1 : 0));
  return Buffer.from(JSON.stringify({
    v: 1,
    producerId: String(body.producerId),
    parentHash: String(body.parentHash).toLowerCase(),
    roundHeight: Math.floor(Number(body.roundHeight)),
    leaves,
  }));
}

export function commitmentId(body) {
  return createHash('sha256').update(canonicalCommitmentBytes(body)).digest('hex');
}

export function signShareCommitment(privateKey, body) {
  return sign(null, canonicalCommitmentBytes(body), privateKey);
}

export function verifyShareCommitment(publicKey, body, sig) {
  try {
    return verify(null, canonicalCommitmentBytes(body), publicKey, sig);
  } catch {
    return false;
  }
}

/**
 * 016-style binding for one leaf: units must be unitsForShare(bits) and the
 * note commit must be the dest20 commit. No cache, no skipped check.
 */
export function proveLeaf(leaf) {
  const destHex = hexOf(leaf?.dest20, 20);
  const gotNc = hexOf(leaf?.noteCommit, 32);
  if (!destHex || !gotNc) return { ok: false, reason: 'dest_unbound' };
  let expectedNc;
  try {
    expectedNc = noteCommitOfDest20(Buffer.from(destHex, 'hex')).toString('hex');
  } catch {
    return { ok: false, reason: 'dest_unbound' };
  }
  if (gotNc !== expectedNc) return { ok: false, reason: 'dest_unbound' };
  const bits = Math.floor(Number(leaf.bits));
  if (!Number.isInteger(bits)) return { ok: false, reason: 'bits_unbound' };
  let claimed;
  try {
    claimed = BigInt(leaf.units);
  } catch {
    return { ok: false, reason: 'bits_unbound' };
  }
  if (claimed !== BigInt(unitsForShare(bits))) return { ok: false, reason: 'bits_unbound' };
  return { ok: true, units: claimed, noteCommit: gotNc };
}

/** CapUnits_prod = max(FloorPerProd, CapUnits_block / Prod*). Prod* 0 pays nothing. */
export function capUnitsForProd(prodStar, capUnitsBlock = MAX_HASH_UNITS_PER_BLOCK, floorPerProd = FLOOR_PER_PROD) {
  const prod = Math.floor(Number(prodStar));
  if (!Number.isInteger(prod) || prod <= 0) return 0n;
  const cap = asUnits(capUnitsBlock);
  const floor = asUnits(floorPerProd);
  const share = cap / BigInt(prod);
  return floor > share ? floor : share;
}

/** Bond grows with the claimed units. It is not a single figure. */
export function challengerBondNanos(units, unit = HASH_BONUS_NANOS) {
  return asUnits(units) * BigInt(hashBonusUnitNanos(unit));
}

/**
 * How many leaves a header-seeded opening draws. Grows with the leaf count
 * and never exceeds it. A one-leaf commitment is opened in full.
 */
export function sampleLeafCount(leafCount) {
  const n = Math.floor(Number(leafCount));
  if (!Number.isInteger(n) || n <= 0) return 0;
  const log = Math.ceil(Math.log2(n + 1));
  return Math.min(n, Math.max(1, log));
}

export function sampleLeafIndexes(leafCount, seed) {
  const n = Math.floor(Number(leafCount));
  const k = sampleLeafCount(n);
  if (k <= 0) return [];
  const picked = [];
  const used = new Set();
  const seedBuf = Buffer.isBuffer(seed) ? seed : Buffer.from(String(seed ?? ''));
  let counter = 0;
  while (picked.length < k && counter < n * 8 + 16) {
    const dig = createHash('sha256').update(seedBuf).update(Buffer.from(String(counter))).digest();
    const idx = dig.readUInt32BE(0) % n;
    if (!used.has(idx)) {
      used.add(idx);
      picked.push(idx);
    }
    counter += 1;
  }
  return picked;
}

/**
 * 013/014 retention. Under the cap every unit is kept. Over the cap each key
 * keeps floor(submitted * cap / total), then leftover units walk the sorted
 * keys, and a zero credit takes one unit before a key that already has one.
 * Overflow is owed, not burned and not dropped.
 */
export function retainProRata(unitByKey, cap) {
  const entries = [...(unitByKey || new Map()).entries()]
    .map(([k, u]) => [String(k), asUnits(u)])
    .filter(([, u]) => u > 0n)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const total = entries.reduce((n, [, u]) => n + u, 0n);
  const limit = asUnits(cap);
  const retained = new Map();
  const owed = new Map();
  if (total === 0n || limit <= 0n) {
    for (const [k, u] of entries) owed.set(k, u);
    return { retained, owed };
  }
  if (total <= limit) {
    for (const [k, u] of entries) retained.set(k, u);
    return { retained, owed };
  }
  const floors = entries.map(([hex, u]) => ({ hex, base: (u * limit) / total, submitted: u }));
  let leftover = limit - floors.reduce((n, row) => n + row.base, 0n);
  for (const row of floors) {
    if (leftover <= 0n) break;
    if (row.base === 0n) {
      row.base += 1n;
      leftover -= 1n;
    }
  }
  let i = 0;
  while (leftover > 0n && floors.length) {
    floors[i % floors.length].base += 1n;
    leftover -= 1n;
    i += 1;
  }
  for (const row of floors) {
    if (row.base > 0n) continue;
    const donor = floors.find((other) => other.base > 1n);
    if (!donor) break;
    donor.base -= 1n;
    row.base += 1n;
  }
  for (const row of floors) {
    if (row.base > 0n) retained.set(row.hex, row.base);
    const rest = row.submitted - row.base;
    if (rest > 0n) owed.set(row.hex, rest);
  }
  return { retained, owed };
}

export function timelyRoot(ids) {
  const sorted = [...ids].map((id) => String(id)).sort();
  return createHash('sha256').update(sorted.join('\n')).digest('hex');
}

function leafUnitsOf(body) {
  const destUnits = new Map();
  let claimed = 0n;
  for (const leaf of body?.leaves || []) {
    const key = hexOf(leaf.noteCommit, 32);
    if (!key) continue;
    const units = asUnits(leaf.units);
    destUnits.set(key, (destUnits.get(key) || 0n) + units);
    claimed += units;
  }
  return { destUnits, claimed };
}

function splitAttributed(contributors, globalRetained) {
  const out = new Map();
  for (const dest of globalRetained.keys()) {
    const parts = new Map();
    for (const c of contributors) {
      const u = c.units.get(dest) || 0n;
      if (u > 0n) parts.set(c.id, u);
    }
    const split = retainProRata(parts, globalRetained.get(dest) || 0n);
    for (const [id, u] of split.retained) {
      const row = out.get(id) || new Map();
      row.set(dest, u);
      out.set(id, row);
    }
  }
  return out;
}

function settlePay(pay, capUnitsBlock, floorPerProd, unit) {
  const prodStar = new Set(pay.map((c) => c.body.producerId)).size;
  const capUnitsProd = capUnitsForProd(prodStar, capUnitsBlock, floorPerProd);
  const contributors = [];
  const preGlobal = new Map();
  let claimedUnits = 0n;
  for (const c of pay) {
    const { destUnits, claimed } = leafUnitsOf(c.body);
    const clamped = retainProRata(destUnits, capUnitsProd);
    contributors.push({ id: c.id, units: clamped.retained, claimed });
    claimedUnits += claimed;
    for (const [k, u] of clamped.retained) preGlobal.set(k, (preGlobal.get(k) || 0n) + u);
  }
  const global = retainProRata(preGlobal, capUnitsBlock);
  const attributed = splitAttributed(contributors, global.retained);
  const byCommitment = new Map();
  let retainedUnits = 0n;
  for (const c of contributors) {
    const part = attributed.get(c.id) || new Map();
    const retained = sumUnits(part);
    const owedUnits = c.claimed - retained;
    retainedUnits += retained;
    byCommitment.set(c.id, {
      claimedUnits: c.claimed,
      retainedUnits: retained,
      owedUnits,
      escrowNanos: retained * unit,
      owedNanos: owedUnits * unit,
      retainedByDest: part,
    });
  }
  const owedUnits = claimedUnits - retainedUnits;
  return {
    prodStar,
    capUnitsProd,
    retainedByDest: global.retained,
    retainedUnits,
    claimedUnits,
    owedUnits,
    provEscrowNanos: retainedUnits * unit,
    owedDeltaNanos: owedUnits * unit,
    byCommitment,
  };
}

function emptyPay(capUnitsBlock, floorPerProd) {
  return {
    prodStar: 0,
    capUnitsProd: capUnitsForProd(0, capUnitsBlock, floorPerProd),
    retainedByDest: new Map(),
    retainedUnits: 0n,
    claimedUnits: 0n,
    owedUnits: 0n,
    provEscrowNanos: 0n,
    owedDeltaNanos: 0n,
    byCommitment: new Map(),
  };
}

function zeroMoney() {
  return {
    hashMintedNanos: 0n,
    owedDeltaNanos: 0n,
    provEscrowNanos: 0n,
    feeOnBonusNanos: 0n,
    feeOnOwedNanos: 0n,
    retainedUnits: 0n,
    retainedByDest: new Map(),
    lateAdmittedUnits: 0n,
    challengerPaidNanos: 0n,
    clawedEscrowNanos: 0n,
  };
}

function rejected(reason, extra = {}) {
  return {
    ok: false,
    valid: false,
    reason,
    law: SHARE_COMMIT_LAW,
    finalized: false,
    ...zeroMoney(),
    ...extra,
  };
}

function parseAttestation(row, parentHash, parentHeight) {
  const body = row?.body;
  const publicKey = row?.publicKey;
  if (!body || !publicKey || row.sig == null) return null;
  let id;
  try {
    id = commitmentId(body);
  } catch {
    return null;
  }
  if (String(body.producerId) !== producerIdFromPublicKey(publicKey)) return null;
  if (String(body.parentHash).toLowerCase() !== String(parentHash).toLowerCase()) return null;
  if (Math.floor(Number(body.roundHeight)) !== Math.floor(Number(parentHeight))) return null;
  if (!verifyShareCommitment(publicKey, body, row.sig)) return null;
  return { id, body, publicKey, sig: row.sig };
}

/**
 * Timely* for parent P. Ids attested on canonical blocks h+1..h+W_a.
 * The set only grows. A bad signature, a wrong parent, or a broken link
 * does not add an id. Nothing already added is removed.
 */
export function collectWindow({
  parentHeight,
  parentHash,
  blocks,
  window = ATTEST_WINDOW,
} = {}) {
  const span = Math.floor(Number(window));
  if (!Number.isInteger(span) || span < ATTEST_WINDOW) {
    return rejected('window_short', { window: span });
  }
  const byHeight = new Map();
  for (const block of blocks || []) byHeight.set(Math.floor(Number(block?.height)), block);
  const ordered = [];
  let prev = String(parentHash);
  for (let step = 1; step <= span; step += 1) {
    const height = Math.floor(Number(parentHeight)) + step;
    const block = byHeight.get(height);
    if (!block) return rejected('window_gap', { height });
    if (String(block.parentHash) !== prev) return rejected('not_canonical', { height });
    ordered.push(block);
    prev = String(block.hash);
  }
  const timelyIds = [];
  const seen = new Set();
  const commitments = [];
  for (const block of ordered) {
    for (const row of block.attested || []) {
      const parsed = parseAttestation(row, parentHash, parentHeight);
      if (!parsed || seen.has(parsed.id)) continue;
      seen.add(parsed.id);
      timelyIds.push(parsed.id);
      commitments.push(parsed);
    }
  }
  return {
    ok: true,
    ordered,
    timelyIds,
    commitments,
    sealHeight: Math.floor(Number(parentHeight)) + span,
    window: span,
  };
}

function equivocatingProducers(commitments) {
  const idsByProducer = new Map();
  for (const c of commitments) {
    const set = idsByProducer.get(c.body.producerId) || new Set();
    set.add(c.id);
    idsByProducer.set(c.body.producerId, set);
  }
  const nulled = new Set();
  for (const [producerId, ids] of idsByProducer) {
    if (ids.size > 1) nulled.add(producerId);
  }
  return nulled;
}

function payView(base, pay) {
  return {
    ...base,
    prodStar: pay.prodStar,
    capUnitsProd: pay.capUnitsProd,
    retainedByDest: pay.retainedByDest,
    retainedUnits: pay.retainedUnits,
    claimedUnits: pay.claimedUnits,
    owedUnits: pay.owedUnits,
    provEscrowNanos: pay.provEscrowNanos,
    owedDeltaNanos: pay.owedDeltaNanos,
    byCommitment: pay.byCommitment,
    hashMintedNanos: 0n,
    feeOnBonusNanos: 0n,
    feeOnOwedNanos: 0n,
    lateAdmittedUnits: base.lateAdmittedUnits ?? 0n,
    challengerPaidNanos: base.challengerPaidNanos ?? 0n,
    clawedEscrowNanos: base.clawedEscrowNanos ?? 0n,
  };
}

/**
 * Validity of the seal block at h+W_a.
 * includedIds must cover every Timely* id. Pay uses Prod* after equivocation
 * nulls, then per-producer clamp, then the block cap. feeBps is ignored for
 * the bonus and the owed ledger.
 */
export function sealRound({
  parentHeight,
  parentHash,
  blocks,
  includedIds,
  scMempoolRoot,
  feeBps = 0,
  capUnitsBlock = MAX_HASH_UNITS_PER_BLOCK,
  floorPerProd = FLOOR_PER_PROD,
  window = ATTEST_WINDOW,
  work = 0,
  headerSeed = '',
} = {}) {
  const collected = collectWindow({ parentHeight, parentHash, blocks, window });
  if (!collected.ok) return collected;
  const sealBlock = collected.ordered[collected.ordered.length - 1];
  const included = (includedIds ?? sealBlock.includedIds ?? []).map((id) => String(id));
  const rootField = scMempoolRoot !== undefined ? scMempoolRoot : sealBlock.scMempoolRoot;
  const cap = asUnits(capUnitsBlock);
  const floor = asUnits(floorPerProd);
  const unit = BigInt(hashBonusUnitNanos(HASH_BONUS_NANOS));
  const nulled = equivocatingProducers(collected.commitments);
  const payCommitments = collected.commitments.filter((c) => !nulled.has(c.body.producerId));
  const expectedRoot = timelyRoot(collected.timelyIds);
  const common = {
    law: SHARE_COMMIT_LAW,
    parentHeight: Math.floor(Number(parentHeight)),
    parentHash: String(parentHash),
    sealHeight: collected.sealHeight,
    window: collected.window,
    timelyIds: collected.timelyIds,
    timelyCount: collected.timelyIds.length,
    timelyRoot: expectedRoot,
    nulledProducers: [...nulled],
    commitments: collected.commitments,
    payCommitments,
    capUnitsBlock: cap,
    floorPerProd: floor,
    unit,
    feeBps: Math.floor(Number(feeBps) || 0),
    work: asUnits(work),
    headerSeed: String(headerSeed || sealBlock.hash || ''),
    finalized: false,
  };
  if (rootField != null && rootField !== '' && String(rootField) !== expectedRoot) {
    return rejected('liar_root', { ...common, missingIds: collected.timelyIds.filter((id) => !included.includes(id)) });
  }
  const missingIds = collected.timelyIds.filter((id) => !included.includes(id));
  if (missingIds.length) {
    return rejected('omit_timely', { ...common, missingIds });
  }
  const pay = payCommitments.length
    ? settlePay(payCommitments, cap, floor, unit)
    : emptyPay(cap, floor);
  return {
    ok: true,
    valid: true,
    reason: '',
    missingIds: [],
    ...payView(common, pay),
  };
}

/**
 * A commitment that arrives after h+W_a. Binding cap: it is not paid and the
 * timely retained map, escrow, and owed delta stay put. Unused headroom: it
 * may take only that headroom. Timely dests are not reduced either way.
 */
export function admitLate(settlement, lateCommitment) {
  if (!settlement?.ok) {
    return {
      ...(settlement || {}),
      ok: false,
      lateAdmittedUnits: 0n,
      redistributed: false,
    };
  }
  const retainedByDest = cloneMap(settlement.retainedByDest);
  const headroom = settlement.capUnitsBlock > settlement.retainedUnits
    ? settlement.capUnitsBlock - settlement.retainedUnits
    : 0n;
  let lateUnits = 0n;
  for (const leaf of lateCommitment?.body?.leaves || []) lateUnits += asUnits(leaf.units);
  const admitted = headroom <= 0n ? 0n : (lateUnits > headroom ? headroom : lateUnits);
  return {
    ...settlement,
    retainedByDest,
    retainedUnits: settlement.retainedUnits,
    owedDeltaNanos: settlement.owedDeltaNanos,
    provEscrowNanos: settlement.provEscrowNanos,
    hashMintedNanos: settlement.hashMintedNanos,
    feeOnBonusNanos: 0n,
    feeOnOwedNanos: 0n,
    lateAdmittedUnits: admitted,
    lateEscrowNanos: admitted * settlement.unit,
    redistributed: false,
  };
}

/**
 * Opening of a Share Commitment. A leaf that fails dest/bits binding zeros
 * that commitment, claws its provisional escrow, and pays the challenger
 * from the bond. Honest commitments are settled again without it, so a
 * fraud-inflated pie does not keep their underpay. A leaf that binds is
 * not clawed.
 */
export function openFraud(settlement, { commitmentId: id, leafIndex = null, challengerId = '' } = {}) {
  if (!settlement?.ok) return { ...settlement, clawed: false, challengerPaidNanos: 0n };
  const commitment = (settlement.commitments || []).find((c) => c.id === id);
  if (!commitment) return { ...settlement, ok: false, reason: 'unknown_commitment', clawed: false };
  const leaves = commitment.body.leaves || [];
  const indexes = new Set(sampleLeafIndexes(leaves.length, settlement.headerSeed || id));
  if (leafIndex != null && leafIndex !== '') indexes.add(Math.floor(Number(leafIndex)));
  let fraud = false;
  let fraudReason = '';
  for (const index of indexes) {
    const proved = proveLeaf(leaves[index]);
    if (!proved.ok) {
      fraud = true;
      fraudReason = proved.reason;
      break;
    }
  }
  if (!fraud) {
    return {
      ...settlement,
      clawed: false,
      fraudReason: '',
      challengerPaidNanos: 0n,
      clawedEscrowNanos: 0n,
      feeOnBonusNanos: 0n,
      feeOnOwedNanos: 0n,
    };
  }
  const prior = settlement.byCommitment?.get(id);
  const remaining = (settlement.payCommitments || []).filter((c) => c.id !== id);
  const pay = remaining.length
    ? settlePay(remaining, settlement.capUnitsBlock, settlement.floorPerProd, settlement.unit)
    : emptyPay(settlement.capUnitsBlock, settlement.floorPerProd);
  return {
    ...payView({
      ...settlement,
      ok: true,
      valid: true,
      reason: '',
      clawed: true,
      fraudReason,
      clawedId: id,
      clawedEscrowNanos: prior ? prior.escrowNanos : 0n,
      fraudEscrowNanos: 0n,
      challengerId: String(challengerId),
      challengerPaidNanos: challengerBondNanos(prior ? prior.claimedUnits : 0n, settlement.unit),
      payCommitments: remaining,
      feeOnBonusNanos: 0n,
      feeOnOwedNanos: 0n,
    }, pay),
  };
}

/** Provisional escrow becomes hash mint only after W_c openings. Empty Timely* is already zero. */
export function finalizeRound(settlement, { openingCount = 0 } = {}) {
  if (!settlement?.ok) {
    return rejected(settlement?.reason || 'invalid_seal', {
      finalized: false,
      hashMintedNanos: 0n,
    });
  }
  const openings = Math.floor(Number(openingCount) || 0);
  if ((settlement.timelyCount || 0) > 0 && openings < OPEN_WINDOW) {
    return {
      ...settlement,
      ok: false,
      valid: false,
      reason: 'early_finalize',
      finalized: false,
      hashMintedNanos: 0n,
      feeOnBonusNanos: 0n,
      feeOnOwedNanos: 0n,
    };
  }
  return {
    ...settlement,
    ok: true,
    valid: true,
    reason: '',
    finalized: true,
    hashMintedNanos: settlement.provEscrowNanos,
    provEscrowNanos: 0n,
    feeOnBonusNanos: 0n,
    feeOnOwedNanos: 0n,
  };
}

/** An invalid seal loses to any valid rival. Two valid seals compare chain work. */
export function preferTip(a, b) {
  if (!a || !b) return a?.ok ? a : (b?.ok ? b : null);
  if (!!a.ok !== !!b.ok) return a.ok ? a : b;
  if (!a.ok) return null;
  const aw = asUnits(a.work);
  const bw = asUnits(b.work);
  if (aw !== bw) return aw > bw ? a : b;
  return (a.sealHeight || 0) >= (b.sealHeight || 0) ? a : b;
}
