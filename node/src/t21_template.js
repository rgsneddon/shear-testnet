/**
 * cb-v3 template. Turns a slotted share batch into the coinbase the chain
 * will accept: the shares whose note commit is a T21 label, their retained
 * units as A leaves, and buildT21Coinbase over those leaves.
 *
 * The coinbase shares must match the block's A leaves one to one, so every
 * share the builder defers is dropped from the batch and the leaves are
 * recomputed. Nothing here trims a share without also dropping it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { buildT21Coinbase, poolShareLabel, t21ShareNc } from '../../crypto/t21.js';
import { publicVoucher, voucherAt, voucherKeysOk } from '../../crypto/t21_voucher.js';
import { CB_SHARE_MAX } from '../../crypto/t21_params.js';
import { payeeCapLive } from '../../crypto/block_budget.js';
import { MAX_HASH_UNITS_PER_BLOCK } from '../../crypto/asert.js';
import {
  creditBitsForShare, noteCommitOfShare, structuralShareVerdict, unitsForShare,
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

function shareUnits(share) {
  const credit = creditBitsForShare(share, undefined, { strict: false });
  return credit.ok ? BigInt(unitsForShare(credit.bits)) : 0n;
}

/** One candidate per label: its raw units, share count, payee, and whether it is expiring carry. */
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

/**
 * Which labels go in this block. Pure, so the order is testable.
 *
 * Expiring carry (proof slot 1) goes first: it cannot wait another block.
 * Then payees by units, largest first (MF-3), then by B*. Inside a payee,
 * larger labels first. A label is taken whole or deferred whole, so no unit
 * is ever cut pro rata. The finder payee holds a slot before any share payee.
 * Rounding is not ordered here: the law floors every row and carries
 * Σρ_i/W into the next pot (c_out), so no remainder goes by arrival order.
 *
 * Caps: payeeMax payee slots, shareMax raw shares (the batch cap),
 * unitMax units (MAX_HASH_UNITS_PER_BLOCK), and unitBudget = ⌊B_h/u⌋.
 * Returns the labels taken and, for the rest, the cap that deferred each.
 */
export function planT21Round({
  labels = [],
  payeeMax = payeeCapLive(),
  shareMax = CB_SHARE_MAX,
  unitMax = MAX_HASH_UNITS_PER_BLOCK,
  unitBudget = null,
  finderPayee = null,
} = {}) {
  const payees = new Map();
  for (const l of labels) {
    const p = payees.get(l.payee) || { units: 0n, carried: 0n };
    p.units += l.units;
    if (l.carried) p.carried += l.units;
    payees.set(l.payee, p);
  }
  const rankPayee = (a, b) => {
    const pa = payees.get(a).units;
    const pb = payees.get(b).units;
    if (pa !== pb) return pa > pb ? -1 : 1;
    return cmpHex(a, b);
  };
  const order = labels.slice().sort((a, b) => {
    if (a.carried !== b.carried) return a.carried ? -1 : 1;
    if (a.payee !== b.payee) {
      if (a.carried) {
        const ca = payees.get(a.payee).carried;
        const cb = payees.get(b.payee).carried;
        if (ca !== cb) return ca > cb ? -1 : 1;
      }
      return rankPayee(a.payee, b.payee);
    }
    if (a.units !== b.units) return a.units > b.units ? -1 : 1;
    return cmpHex(a.nc, b.nc);
  });
  const admitted = new Set(finderPayee ? [finderPayee] : []);
  const maxPayees = Math.max(0, Math.floor(Number(payeeMax)));
  const maxShares = Math.max(0, Math.floor(Number(shareMax)));
  const maxUnits = BigInt(unitMax);
  const budget = unitBudget == null ? null : BigInt(unitBudget);
  let shares = 0;
  let units = 0n;
  const take = [];
  const later = [];
  for (const l of order) {
    let reason = null;
    if (!admitted.has(l.payee) && admitted.size >= maxPayees) reason = 'payee_cap';
    else if (shares + l.count > maxShares) reason = 'share_cap';
    else if (units + l.units > maxUnits) reason = 'hash_units';
    else if (budget != null && units + l.units > budget) reason = 'hash_budget';
    if (reason) {
      later.push({ ...l, reason });
      continue;
    }
    admitted.add(l.payee);
    shares += l.count;
    units += l.units;
    take.push(l);
  }
  return { take, later, units, shares, payees: admitted.size };
}

function leavesOf(batch, ctx) {
  if (!batch.length) return [];
  const got = structuralShareVerdict({
    parentHeader: ctx.prevHeader,
    priorHeader: ctx.priorHeader,
    shares: batch,
    issuedJobKeys: ctx.issuedJobKeys,
  });
  if (!got.ok) {
    const err = new Error(got.reason || 'share_batch');
    err.reason = got.reason || 'share_batch';
    throw err;
  }
  return got.aLeaves;
}

function payeesOf(leaves, labelOf, finder, phi) {
  const byB = new Map();
  for (const leaf of leaves) {
    const lab = labelOf(hexOf(leaf.noteCommit));
    const key = hexOf(lab.voucher.B);
    if (!byB.has(key)) byB.set(key, { voucher: lab.voucher, shares: [] });
    byB.get(key).shares.push({ w: BigInt(leaf.count), E: lab.E, ell: lab.ell, beta: lab.beta });
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

/**
 * Build the cb-v3 coinbase for a template.
 * `u` is the live unit and `hashBudget` is B_h. `phi` is the levy's finder
 * half, paid to `finder` (the block miner's voucher). planT21Round picks the
 * labels; a label the builder still defers (an N-1 miss) is moved out whole
 * and the coinbase is rebuilt.
 *
 * Returns the coinbase, the batch it binds, its A leaves, and:
 *   later: labelled shares not in this block, each with `deferReason`. A
 *     fresh one (proof slot 0) is still valid as carry in the next block.
 *   expired: the subset of `later` that was already carry (slot 1). A share
 *     proof binds the parent or the prior header only, so these cannot be
 *     paid by any later block.
 *   unlabelled: shares whose note commit is not a T21 label. Never paid here.
 *   flags: 'empty_batch_held' when labelled shares were offered and none paid.
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
  shareMax = CB_SHARE_MAX,
  payeeMax = null,
  unitMax = MAX_HASH_UNITS_PER_BLOCK,
  seed,
} = {}) {
  if (typeof labelOf !== 'function') throw new Error('t21_labels');
  if (hashBudget == null) throw new Error('hash_owed');
  // Callers may only tighten the consensus caps (tests use small ones).
  const room = Math.min(CB_SHARE_MAX, Math.max(0, Math.floor(Number(shareMax))));
  const slots = Math.min(payeeCapLive(), payeeMax == null ? Infinity : Math.max(0, Math.floor(Number(payeeMax))));
  const unitCap = BigInt(unitMax) < BigInt(MAX_HASH_UNITS_PER_BLOCK) ? BigInt(unitMax) : BigInt(MAX_HASH_UNITS_PER_BLOCK);
  const split = labelledShares(Array.isArray(batch) ? batch : [], labelOf);
  const ctx = { prevHeader, priorHeader, issuedJobKeys };
  const unit = BigInt(u);
  const want = BigInt(phi);
  if (want > 0n && !finder) throw new Error('finder_row');
  // Labels the builder could not pay (an N-1 miss at that row index). They stay out of later passes.
  const evicted = new Map();
  for (let pass = 0; pass <= REBUILDS; pass += 1) {
    const later = [];
    const candidates = [];
    for (const s of split.keep) {
      const reason = evicted.get(hexOf(noteCommitOfShare(s)));
      if (reason) later.push({ ...s, deferReason: reason });
      else candidates.push(s);
    }
    const plan = planT21Round({
      labels: labelsOf(candidates, labelOf),
      payeeMax: slots,
      shareMax: room,
      unitMax: unitCap,
      unitBudget: unit > 0n ? BigInt(hashBudget) / unit : null,
      finderPayee: want > 0n ? hexOf(finder.B) : null,
    });
    const why = new Map(plan.later.map((l) => [l.nc, l.reason]));
    const live = [];
    for (const s of candidates) {
      const reason = why.get(hexOf(noteCommitOfShare(s)));
      if (reason) later.push({ ...s, deferReason: reason });
      else live.push(s);
    }
    const leaves = leavesOf(live, ctx);
    const W = leaves.reduce((a, l) => a + BigInt(l.count), 0n);
    // Every label fits whole, so the batch rules keep every unit. A scaled leaf would be a pro-rata cut.
    if (W !== plan.units) throw new Error('t21_units');
    const built = buildT21Coinbase({
      S: BigInt(S),
      cin: BigInt(cin),
      u: unit,
      bps,
      fee,
      height,
      magic,
      prevHash,
      payees: payeesOf(leaves, labelOf, finder, want),
      vaults,
      publicRows,
      shareMax: room,
      payeeMax: slots,
      seed,
    });
    let more = false;
    for (const d of built.deferred) {
      for (const s of d.shares || []) {
        evicted.set(t21ShareNc(magic, s.E).toString('hex'), d.reason || 'deferred');
        more = true;
      }
    }
    if (!more) {
      if (BigInt(built.phi || 0n) !== want) throw new Error('finder_row');
      const flags = split.keep.length && !live.length ? ['empty_batch_held'] : [];
      return {
        ...built, batch: live, aLeaves: leaves, later, expired: later.filter(isCarried), unlabelled: split.drop, flags,
      };
    }
  }
  throw new Error('t21_template');
}
