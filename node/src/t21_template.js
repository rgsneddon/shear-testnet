/**
 * cb-v3 template. Turns a slotted share batch into the coinbase the chain
 * will accept: the shares whose note commit is a T21 label, their full units
 * as A leaves, and buildT21Coinbase over those leaves.
 *
 * Every A leaf is either paid in t21.shares or sealed in t21.owed as escrow.
 * Escrow is payee-cap overflow only, priced from this round, and any producer
 * can settle it. Hash cap, share cap, and the hash budget reject the round.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  buildT21Coinbase, poolShareLabel, t21Anchor, t21OwedLive, t21ShareNc,
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

function rejectPlan(reason) {
  return {
    reject: reason, batch: [], pay: [], defer: [], kept: [], later: [], unplaced: [],
    units: 0n, shares: 0, payees: 0,
  };
}

/**
 * One row per payee. Slots fill largest-units first, after owed rows (oldest
 * first). Overflow payees are defer (escrow). Hash cap, hash budget, and the
 * share cap reject the round: nothing is moved to a second leftover list.
 * owedRoom is how many new payees this producer may still seal.
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
  producer = null,
} = {}) {
  const groups = new Map();
  for (const l of labels) {
    if (unpayable.has(l.nc)) continue;
    let g = groups.get(l.payee);
    if (!g) {
      g = { payee: l.payee, units: 0n, count: 0, labels: [] };
      groups.set(l.payee, g);
    }
    g.units += l.units;
    g.count += l.count == null ? 1 : l.count;
    g.labels.push(l);
  }
  const ranked = [...groups.values()].sort((a, b) => {
    if (a.units !== b.units) return a.units > b.units ? -1 : 1;
    return cmpHex(a.payee, b.payee);
  });
  let totalU = 0n;
  let totalC = 0;
  let entries = 0;
  for (const g of ranked) {
    totalU += g.units;
    totalC += g.count;
    entries += g.labels.length;
  }
  const maxShares = Math.max(0, Math.floor(Number(shareMax)));
  const maxEntries = Math.max(0, Math.floor(Number(entryMax)));
  const budget = unitBudget == null ? null : BigInt(unitBudget);
  const cap = BigInt(payMax);
  if (totalU >= BigInt(unitMax) || totalU >= W_HASH_MAX || totalU > cap) return rejectPlan('hash_units');
  if (budget != null && totalU > budget) return rejectPlan('hash_budget');
  if (totalC > maxShares || entries > maxEntries) return rejectPlan('share_cap');
  const admitted = new Set(finderPayee ? [finderPayee] : []);
  const maxPayees = Math.max(0, Math.floor(Number(payeeMax)));
  const pay = [];
  const kept = [];
  const owedSorted = [...owed].sort((a, b) => (Number(a.since) - Number(b.since)) || cmpHex(a.nc, b.nc));
  for (const o of owedSorted) {
    if (unpayable.has(o.nc)) {
      kept.push({ ...o, reason: 'unpayable' });
      continue;
    }
    if (!admitted.has(o.payee) && admitted.size >= maxPayees) {
      kept.push({ ...o, reason: 'payee_cap' });
      continue;
    }
    admitted.add(o.payee);
    pay.push(o);
  }
  const defer = [];
  for (const g of ranked) {
    if (!admitted.has(g.payee) && admitted.size >= maxPayees) {
      for (const l of g.labels) defer.push({ ...l, reason: 'payee_cap' });
      continue;
    }
    admitted.add(g.payee);
    for (const l of g.labels) pay.push(l);
  }
  const deferPayees = new Set(defer.map((l) => l.payee));
  let room = Math.max(0, Math.floor(Number(owedRoom)));
  if (producer) {
    const mine = kept.filter((o) => o.by === producer).length;
    room = Math.min(room, Math.max(0, T21_OWED_MAX - mine));
  }
  if (deferPayees.size > room) return rejectPlan('owed_cap');
  if (!pay.length) {
    return {
      reject: null, batch: [], pay: [], defer: [], kept, later: [], unplaced: defer,
      units: 0n, shares: 0, payees: admitted.size,
    };
  }
  let units = 0n;
  for (const p of pay) if (!p.owed) units += p.units;
  return {
    reject: null,
    batch: ranked.flatMap((g) => g.labels),
    pay,
    defer,
    kept,
    later: [],
    unplaced: [],
    units,
    shares: pay.filter((p) => !p.owed).length,
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
  if ([...plan.kept, ...(plan.unplaced || []), ...plan.later.filter((l) => l.reason !== 'owed_cap')].some(alone)) {
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
 * half, paid to `finder` (the block miner's voucher), or in a round with no
 * shares as `finderNote`, an opened finder-fee row. `owedIn` is the parent
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
  finderNote = null,
  vaults = [],
  publicRows = [],
  owedIn = [],
  producer = null,
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
  if (want > 0n && !finder && !finderNote) throw new Error('finder_row');
  const unitBudget = unit > 0n ? BigInt(hashBudget) / unit : null;

  const live = t21OwedLive(owedIn, height);
  const owedNc = new Set();
  for (const o of live) {
    for (const s of o.shares || []) owedNc.add(t21ShareNc(magic, s.E).toString('hex'));
  }
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
    let units = 0n;
    for (const s of o.shares || []) units += BigInt(s.w);
    ownOwed.push({
      nc: t21Anchor(o), units, payee: hexOf(o.B), since: o.since, owed: true, by: hexOf(o.by), row: o,
    });
  }
  const producerBuf = want > 0n && finder ? finder.B : producer;
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
      owedRoom: owedCap,
      finderPayee: want > 0n && finder ? hexOf(finder.B) : null,
      producer: producerBuf ? hexOf(producerBuf) : null,
      unpayable,
    });
    if (plan.reject) {
      const err = new Error(plan.reject);
      err.reason = plan.reject;
      throw err;
    }
    assertNotEmptyHeld(plan, { payeeMax: slots, shareMax: room, unitBudget, unpayable });
    const inBatch = new Set(plan.batch.map((l) => l.nc));
    const unplaced = new Set((plan.unplaced || []).map((l) => l.nc));
    const kept = [];
    const later = [];
    for (const s of held) {
      const nc = hexOf(noteCommitOfShare(s));
      if (inBatch.has(nc)) kept.push(s);
      else if (!unplaced.has(nc)) later.push({ ...s, deferReason: 'share_cap' });
    }
    const leaves = leavesOf(kept, ctx);
    const units = new Map(leaves.map((l) => [hexOf(l.noteCommit), BigInt(l.count)]));
    for (const l of plan.batch) if (units.get(l.nc) !== l.units) throw new Error('t21_units');
    const freshPay = plan.pay.filter((it) => !it.owed);
    const settling = plan.pay.filter((it) => it.owed);
    const paidItems = freshPay.map((it) => ({ nc: it.nc, w: units.get(it.nc) }));
    const escrowItems = plan.defer.map((l) => ({ nc: l.nc, w: units.get(l.nc) }));
    let payees = paidItems.length ? payeesOf(paidItems, labelOf, finder, want) : [];
    const working = freshPay.length > 0 || escrowItems.length > 0;
    const noteFinder = want > 0n && !working && settling.length === 0;
    if (want > 0n && !payees.some((p) => BigInt(p.fin || 0) > 0n) && (working || settling.length) && finder) {
      payees = [...payees, { voucher: finder, shares: [], fin: want }];
    }
    const escrowPayees = escrowItems.length ? payeesOf(escrowItems, labelOf, finder, 0n) : [];
    if (want > 0n && !(working || settling.length ? finder : finderNote)) throw new Error('finder_row');
    const built = buildT21Coinbase({
      S: BigInt(S),
      cin: BigInt(cin),
      u: working ? unit : 0n,
      bps: working ? bps : 0,
      fee,
      height,
      magic,
      prevHash,
      payees,
      escrowPayees,
      settle: settling.map((it) => it.row),
      owedIn: live,
      producer: producerBuf,
      vaults,
      publicRows: noteFinder ? [...publicRows, finderNote] : publicRows,
      shareMax: room,
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
      if (BigInt(built.phi || 0n) !== (noteFinder ? 0n : want)) throw new Error('finder_row');
      const flags = held.length && !freshPay.length && !settling.length ? ['empty_batch_held'] : [];
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
