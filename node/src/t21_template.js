/**
 * cb-v3 template. Turns a slotted share batch into the coinbase the chain
 * will accept: the shares whose note commit is a T21 label, their full units
 * as A leaves, and buildT21Coinbase over those leaves.
 *
 * Every A leaf is either paid in t21.shares or deferred in t21.defer; a
 * deferred label joins the owed list and a later block of this pool pays it
 * at its full w, oldest first. Only labels that do not fit the batch at all
 * (raw share cap, unit cap, owed cap) leave the batch, and those wait as
 * one-block carry. Nothing is ever cut pro rata.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  buildT21Coinbase, poolShareLabel, t21OwedLive, t21OwedNext, t21ShareNc,
} from '../../crypto/t21.js';
import { publicVoucher, voucherAt, voucherKeysOk } from '../../crypto/t21_voucher.js';
import { CB_SHARE_MAX, T21_OWED_MAX, W_HASH_MAX, W_MAX } from '../../crypto/t21_params.js';
import { payeeCapLive } from '../../crypto/block_budget.js';
import {
  T21_SHARE_MAX_BITS, creditBitsForShare, noteCommitOfShare, structuralShareVerdict, t21ShareCredit, unitsForShare,
} from '../../crypto/share_batch.js';
import { asU8 } from '../../crypto/note.js';

const REBUILDS = 4;

function hexOf(b) {
  return Buffer.from(asU8(b)).toString('hex');
}

/**
 * Pool-side share labels. Each issued label is E = λG + βH for one voucher;
 * the job's note commit is t21ShareNc(magic, E). A label is used once: the
 * book rotates on every issue and forgets labels older than `keep` issues.
 * With `file`, every issue is written through (mode 0600: β is the opening
 * the product proof needs), so carried shares stay payable after a restart.
 */
export function t21LabelBook({ magic, keep = 4096, file = null } = {}) {
  const byNc = new Map();
  const order = [];
  const rowOf = (hex) => {
    const l = byNc.get(hex);
    return JSON.stringify([hex, hexOf(l.voucher.B), hexOf(l.voucher.Y), hexOf(l.voucher.lambda), hexOf(l.E), l.ell.toString(), l.beta.toString()]);
  };
  let logged = 0;
  function compact() {
    const body = order.map(rowOf).join('\n');
    fs.writeFileSync(`${file}.tmp`, `${JSON.stringify({ v: 1, magic: String(magic) })}\n${body}${body ? '\n' : ''}`, { mode: 0o600 });
    fs.renameSync(`${file}.tmp`, file);
    logged = order.length;
  }
  if (file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let lines = [];
    try {
      lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    } catch { /* no book yet */ }
    let head = null;
    try { head = lines.length ? JSON.parse(lines[0]) : null; } catch { head = null; }
    if (head?.v === 1 && head.magic === String(magic)) {
      for (const line of lines.slice(1)) {
        try {
          const [hex, B, Y, lambda, E, ell, beta] = JSON.parse(line);
          const voucher = { B: Buffer.from(B, 'hex'), Y: Buffer.from(Y, 'hex'), lambda: Buffer.from(lambda, 'hex') };
          if (!byNc.has(hex)) order.push(hex);
          byNc.set(hex, { voucher, E: Buffer.from(E, 'hex'), ell: BigInt(ell), beta: BigInt(beta) });
        } catch { /* a torn last line is skipped */ }
      }
      while (order.length > keep) byNc.delete(order.shift());
    }
    compact();
  }
  function save(hex) {
    if (!file) return;
    if (logged >= 2 * keep) return compact();
    fs.appendFileSync(file, `${rowOf(hex)}\n`, { mode: 0o600 });
    logged += 1;
  }
  return {
    issue(voucherPub) {
      if (!voucherKeysOk(voucherPub)) return null;
      const share = poolShareLabel(voucherPub);
      if (!share) return null;
      const nc = t21ShareNc(magic, share.E);
      const hex = nc.toString('hex');
      byNc.set(hex, { voucher: voucherPub, E: Buffer.from(asU8(share.E)), ell: share.ell, beta: share.beta });
      order.push(hex);
      while (order.length > keep) byNc.delete(order.shift());
      save(hex);
      return { noteCommit: nc, E: Buffer.from(asU8(share.E)) };
    },
    labelOf(ncHex) {
      return byNc.get(String(ncHex).toLowerCase()) || null;
    },
    size() {
      return byNc.size;
    },
  };
}

/** A miner's own voucher for a wallet secret, as the pool login carries it. */
export function t21LoginVoucher(secret, ctr = 0) {
  return publicVoucher(voucherAt(secret, ctr));
}

function labelledShares(batch, labelOf) {
  const keep = [];
  const drop = [];
  for (const s of batch) {
    const nc = noteCommitOfShare(s);
    const lab = nc && nc.length === 32 ? labelOf(nc.toString('hex')) : null;
    (lab ? keep : drop).push(s);
  }
  return { keep, drop };
}

function isCarried(share) {
  return share?.proofSlot === 1 || share?.proofSlot === '1';
}

function shareCredit(share) {
  return creditBitsForShare(share, undefined, { strict: false, maxBits: T21_SHARE_MAX_BITS });
}

function shareUnits(share) {
  const credit = shareCredit(share);
  return credit.ok ? BigInt(unitsForShare(credit.bits)) : 0n;
}

/** One candidate per label: its full units, share count, payee, and whether it is expiring carry. */
function labelsOf(shares, labelOf) {
  const by = new Map();
  for (const s of shares) {
    const nc = hexOf(noteCommitOfShare(s));
    let row = by.get(nc);
    if (!row) {
      const lab = labelOf(nc);
      row = { nc, units: 0n, count: 0, carried: false, payee: hexOf(lab.voucher.B) };
      by.set(nc, row);
    }
    row.units += shareUnits(s);
    row.count += 1;
    if (isCarried(s)) row.carried = true;
  }
  return [...by.values()];
}

function cmpHex(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Batch order: expiring carry first, then payees by units (MF-3), then B*, then label units, then nc. */
function orderLabels(labels) {
  const payees = new Map();
  for (const l of labels) {
    const p = payees.get(l.payee) || { units: 0n, carried: 0n };
    p.units += l.units;
    if (l.carried) p.carried += l.units;
    payees.set(l.payee, p);
  }
  return labels.slice().sort((a, b) => {
    if (a.carried !== b.carried) return a.carried ? -1 : 1;
    if (a.payee !== b.payee) {
      const pa = payees.get(a.payee);
      const pb = payees.get(b.payee);
      if (a.carried && pa.carried !== pb.carried) return pa.carried > pb.carried ? -1 : 1;
      if (pa.units !== pb.units) return pa.units > pb.units ? -1 : 1;
      return cmpHex(a.payee, b.payee);
    }
    if (a.units !== b.units) return a.units > b.units ? -1 : 1;
    return cmpHex(a.nc, b.nc);
  });
}

/**
 * The round, as a pure plan so the order is testable.
 *
 * Batch: labels enter whole in orderLabels order while the raw share count
 * fits shareMax, Σunits fits unitCap (W_HASH_MAX), and the entry count fits
 * entryMax (CB_SHARE_MAX counts shares plus defer rows). A label that does
 * not enter is `later` (one-block carry if it is fresh).
 *
 * Pay: this pool's owed rows first, oldest first (Russell 2026-10-14), then
 * the batch labels in the same order. Payee slots (finder held first), the
 * budget ⌊B_h/u⌋ and W < W_MAX cap what is paid. An owed row not paid stays
 * owed; a batch label not paid is deferred in this block (`defer`), so it
 * loses no hash bonus. Rounding is not ordered here: the law floors every
 * row and carries Σρ_i/W into the next pot (c_out).
 *
 * owedRoom is how many defer rows the owed list can still take; a defer
 * row past it leaves the batch (`owed_cap`). A round that pays nothing
 * cannot defer (an empty coinbase has no A leaves), so its batch is `later`.
 */
export function planT21Round({
  labels = [],
  owed = [],
  payeeMax = payeeCapLive(),
  shareMax = CB_SHARE_MAX,
  entryMax = CB_SHARE_MAX,
  unitMax = W_HASH_MAX,
  payMax = W_MAX - 1n,
  unitBudget = null,
  owedRoom = T21_OWED_MAX,
  finderPayee = null,
  unpayable = new Set(),
} = {}) {
  const maxShares = Math.max(0, Math.floor(Number(shareMax)));
  const maxEntries = Math.max(0, Math.floor(Number(entryMax)));
  const batch = [];
  const later = [];
  let raw = 0;
  let inBatch = 0n;
  for (const l of orderLabels(labels)) {
    let reason = null;
    if (raw + l.count > maxShares) reason = 'share_cap';
    else if (batch.length + 1 > maxEntries) reason = 'share_cap';
    else if (inBatch + l.units > BigInt(unitMax)) reason = 'hash_units';
    if (reason) {
      later.push({ ...l, reason });
      continue;
    }
    raw += l.count;
    inBatch += l.units;
    batch.push(l);
  }
  const admitted = new Set(finderPayee ? [finderPayee] : []);
  const maxPayees = Math.max(0, Math.floor(Number(payeeMax)));
  const budget = unitBudget == null ? null : BigInt(unitBudget);
  const cap = BigInt(payMax);
  let units = 0n;
  const pay = [];
  const kept = [];
  const why = (l, entries) => {
    if (unpayable.has(l.nc)) return unpayable.get?.(l.nc) || 'unpayable';
    if (!admitted.has(l.payee) && admitted.size >= maxPayees) return 'payee_cap';
    if (entries > maxEntries) return 'share_cap';
    if (units + l.units > cap) return 'hash_units';
    if (budget != null && units + l.units > budget) return 'hash_budget';
    return null;
  };
  let owedPaid = 0;
  for (const o of owed) {
    const reason = why(o, batch.length + owedPaid + 1);
    if (reason) {
      kept.push({ ...o, reason });
      continue;
    }
    admitted.add(o.payee);
    units += o.units;
    owedPaid += 1;
    pay.push(o);
  }
  let defer = [];
  for (const l of batch) {
    const reason = why(l, 0);
    if (reason) {
      defer.push({ ...l, reason });
      continue;
    }
    admitted.add(l.payee);
    units += l.units;
    pay.push(l);
  }
  let room = Math.max(0, Math.floor(Number(owedRoom))) + owedPaid;
  if (!pay.length) {
    for (const l of defer) later.push(l);
    defer = [];
  }
  while (defer.length > room) {
    const l = defer.pop();
    later.push({ ...l, reason: 'owed_cap' });
  }
  room -= defer.length;
  const out = new Set([...later.map((l) => l.nc)]);
  return {
    batch: batch.filter((l) => !out.has(l.nc)),
    pay,
    defer,
    kept,
    later,
    units,
    shares: pay.length,
    payees: admitted.size,
  };
}

/**
 * MF-4 / ME: a pool holding payable shares never publishes an empty batch.
 * Throws when nothing was paid although some held item alone fits every cap.
 */
export function assertNotEmptyHeld(plan, {
  payeeMax, shareMax = CB_SHARE_MAX, unitBudget = null, payMax = W_MAX - 1n, unpayable = new Set(),
}) {
  if (plan.pay.length) return;
  const alone = (l) => !unpayable.has(l.nc) && Math.floor(Number(payeeMax)) >= 1 && l.units <= BigInt(payMax)
    && (l.count == null || l.count <= Math.floor(Number(shareMax)))
    && (unitBudget == null || l.units <= BigInt(unitBudget));
  if ([...plan.kept, ...plan.later.filter((l) => l.reason !== 'owed_cap')].some(alone)) {
    const err = new Error('t21_empty_batch');
    err.reason = 't21_empty_batch';
    throw err;
  }
}

function leavesOf(batch, ctx) {
  if (!batch.length) return [];
  const got = structuralShareVerdict({
    parentHeader: ctx.prevHeader,
    priorHeader: ctx.priorHeader,
    shares: batch,
    issuedJobKeys: ctx.issuedJobKeys,
    credit: ctx.credit,
  });
  if (!got.ok) {
    const err = new Error(got.reason || 'share_batch');
    err.reason = got.reason || 'share_batch';
    throw err;
  }
  return got.aLeaves;
}

/** Payees from paid items: batch labels at their leaf count, owed rows at their deferred w. */
function payeesOf(items, labelOf, finder, phi) {
  const byB = new Map();
  for (const it of items) {
    const lab = labelOf(it.nc);
    const key = hexOf(lab.voucher.B);
    if (!byB.has(key)) byB.set(key, { voucher: lab.voucher, shares: [] });
    byB.get(key).shares.push({ w: BigInt(it.w), E: lab.E, ell: lab.ell, beta: lab.beta });
  }
  const payees = [...byB.values()];
  if (phi > 0n) {
    const key = hexOf(finder.B);
    const hit = payees.find((p) => hexOf(p.voucher.B) === key);
    if (hit) hit.fin = phi;
    else payees.push({ voucher: finder, shares: [], fin: phi });
  }
  return payees;
}

/** The share's proof header, by its bound slot. */
function proofHeaderOf(share, ctx) {
  if (share?.verifiedHeader) return share.verifiedHeader;
  return isCarried(share) ? ctx.priorHeader : ctx.prevHeader;
}

/**
 * Build the cb-v3 coinbase for a template.
 * `u` is the live unit and `hashBudget` is B_h. `phi` is the levy's finder
 * half, paid to `finder` (the block miner's voucher). `owedIn` is the parent
 * coinbase's owed list; rows whose label this pool's book holds are its own.
 * planT21Round picks the batch, what is paid and what is deferred; a label
 * the builder still cannot pay (an N-1 miss, a bad voucher) is deferred
 * instead and the coinbase is rebuilt.
 *
 * Returns the coinbase, the batch it binds, its A leaves, and:
 *   deferRows: batch labels deferred in this block (owed, paid later in full).
 *   owedPaid: owed rows this block pays.
 *   later: labelled shares not in this block, each with `deferReason`. A
 *     fresh one (proof slot 0) is still valid as carry in the next block.
 *   expired: the subset of `later` that was already carry (slot 1).
 *   unlabelled: shares whose note commit is not a T21 label.
 *   refused: shares below the share floor, past the cb-v3 width, or on a
 *     label that is already owed (a label is one round; the pool rotates it).
 *   flags: 'empty_batch_held' when labelled shares were held and none could
 *     be paid (each was individually unpayable; otherwise this throws).
 */
export function t21TemplateCoinbase({
  batch = [],
  labelOf,
  prevHeader,
  priorHeader = null,
  issuedJobKeys = null,
  magic,
  height,
  prevHash,
  S,
  cin,
  u,
  hashBudget,
  bps = 0,
  fee = null,
  finder = null,
  phi = 0n,
  vaults = [],
  publicRows = [],
  owedIn = [],
  shareMax = CB_SHARE_MAX,
  payeeMax = null,
  unitMax = W_HASH_MAX,
  owedMax = T21_OWED_MAX,
  perBlock = undefined,
  seed,
} = {}) {
  if (typeof labelOf !== 'function') throw new Error('t21_labels');
  if (hashBudget == null) throw new Error('hash_owed');
  // Callers may only tighten the consensus caps (tests use small ones).
  const room = Math.min(CB_SHARE_MAX, Math.max(0, Math.floor(Number(shareMax))));
  const slots = Math.min(payeeCapLive(), payeeMax == null ? Infinity : Math.max(0, Math.floor(Number(payeeMax))));
  const unitCap = BigInt(unitMax) < W_HASH_MAX ? BigInt(unitMax) : W_HASH_MAX;
  const owedCap = Math.min(T21_OWED_MAX, Math.max(0, Math.floor(Number(owedMax))));
  const credit = t21ShareCredit(perBlock == null ? {} : { perBlock });
  const ctx = { prevHeader, priorHeader, issuedJobKeys, credit };
  const unit = BigInt(u);
  const want = BigInt(phi);
  if (want > 0n && !finder) throw new Error('finder_row');
  const unitBudget = unit > 0n ? BigInt(hashBudget) / unit : null;

  const live = t21OwedLive(owedIn, height);
  const owedNc = new Set(live.map((o) => t21ShareNc(magic, o.E).toString('hex')));
  const split = labelledShares(Array.isArray(batch) ? batch : [], labelOf);
  const refused = [];
  const held = [];
  for (const s of split.keep) {
    const c = shareCredit(s);
    const hdr = proofHeaderOf(s, ctx);
    if (!c.ok) refused.push({ ...s, deferReason: 'share_target' });
    else if (hdr && c.bits < credit.floorOf(hdr)) refused.push({ ...s, deferReason: 'share_floor' });
    else if (owedNc.has(hexOf(noteCommitOfShare(s)))) refused.push({ ...s, deferReason: 'label_owed' });
    else held.push(s);
  }
  const ownOwed = [];
  for (const o of live) {
    const nc = t21ShareNc(magic, o.E).toString('hex');
    const lab = labelOf(nc);
    if (lab) ownOwed.push({ nc, units: BigInt(o.w), w: BigInt(o.w), payee: hexOf(lab.voucher.B), since: o.since, owed: true });
  }
  // Labels the builder could not pay. They are deferred (batch) or stay owed in later passes.
  const unpayable = new Map();
  for (let pass = 0; pass <= REBUILDS; pass += 1) {
    const plan = planT21Round({
      labels: labelsOf(held, labelOf),
      owed: ownOwed,
      payeeMax: slots,
      shareMax: room,
      entryMax: room,
      unitMax: unitCap,
      unitBudget,
      owedRoom: owedCap - live.length,
      finderPayee: want > 0n ? hexOf(finder.B) : null,
      unpayable,
    });
    assertNotEmptyHeld(plan, { payeeMax: slots, shareMax: room, unitBudget, unpayable });
    const inBatch = new Set(plan.batch.map((l) => l.nc));
    const why = new Map(plan.later.map((l) => [l.nc, l.reason]));
    const kept = [];
    const later = [];
    for (const s of held) {
      const nc = hexOf(noteCommitOfShare(s));
      if (inBatch.has(nc)) kept.push(s);
      else later.push({ ...s, deferReason: why.get(nc) || 'share_cap' });
    }
    const leaves = leavesOf(kept, ctx);
    const units = new Map(leaves.map((l) => [hexOf(l.noteCommit), BigInt(l.count)]));
    // Full credit: each leaf is its label's whole units. A scaled leaf would be a pro-rata cut.
    for (const l of plan.batch) if (units.get(l.nc) !== l.units) throw new Error('t21_units');
    const paidItems = plan.pay.map((it) => ({ nc: it.nc, w: it.owed ? it.w : units.get(it.nc) }));
    const defer = plan.defer.map((l) => {
      const lab = labelOf(l.nc);
      return { w: units.get(l.nc), E: lab.E };
    });
    const paidE = new Set(plan.pay.filter((it) => it.owed).map((it) => hexOf(labelOf(it.nc).E)));
    const owed = t21OwedNext({ owedIn: live, paidE, defer, height });
    const built = buildT21Coinbase({
      S: BigInt(S),
      cin: BigInt(cin),
      u: unit,
      bps,
      fee,
      height,
      magic,
      prevHash,
      payees: plan.pay.length ? payeesOf(paidItems, labelOf, finder, want) : (want > 0n ? payeesOf([], labelOf, finder, want) : []),
      defer: plan.pay.length ? defer : [],
      owed,
      vaults,
      publicRows,
      shareMax: room - defer.length,
      payeeMax: slots,
      seed,
    });
    let more = false;
    for (const d of built.deferred) {
      for (const s of d.shares || []) {
        unpayable.set(t21ShareNc(magic, s.E).toString('hex'), d.reason || 'deferred');
        more = true;
      }
    }
    if (!more) {
      if (BigInt(built.phi || 0n) !== want) throw new Error('finder_row');
      const flags = held.length && !plan.pay.length ? ['empty_batch_held'] : [];
      return {
        ...built,
        batch: kept,
        aLeaves: leaves,
        deferRows: plan.defer,
        owedPaid: plan.pay.filter((it) => it.owed),
        later,
        expired: later.filter(isCarried),
        unlabelled: split.drop,
        refused,
        flags,
      };
    }
  }
  throw new Error('t21_template');
}
