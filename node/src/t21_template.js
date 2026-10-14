/**
 * cb-v3 template. Turns a slotted share batch into the coinbase the chain
 * will accept: the shares whose note commit is a T21 label, their retained
 * units as A leaves, and buildT21Coinbase over those leaves.
 *
 * The coinbase shares must match the block's A leaves one to one, so every
 * share the builder defers is dropped from the batch and the leaves are
 * recomputed. Nothing here trims a share without also dropping it.
 */
import { buildT21Coinbase, poolShareLabel, t21ShareNc } from '../../crypto/t21.js';
import { publicVoucher, voucherAt, voucherKeysOk } from '../../crypto/t21_voucher.js';
import { CB_SHARE_MAX } from '../../crypto/t21_params.js';
import { noteCommitOfShare, structuralShareVerdict } from '../../crypto/share_batch.js';
import { asU8 } from '../../crypto/note.js';

const REBUILDS = 4;

function hexOf(b) {
  return Buffer.from(asU8(b)).toString('hex');
}

/**
 * Pool-side share labels. Each issued label is E = λG + βH for one voucher;
 * the job's note commit is t21ShareNc(magic, E). A label is used once: the
 * book rotates on every issue and forgets labels older than `keep` issues.
 */
export function t21LabelBook({ magic, keep = 4096 } = {}) {
  const byNc = new Map();
  const order = [];
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

function dropNcs(batch, ncs) {
  return batch.filter((s) => !ncs.has(noteCommitOfShare(s).toString('hex')));
}

/**
 * Build the cb-v3 coinbase for a template.
 * `u` is the live unit, `hashBudget` is B_h; leaves past u·W ≤ B_h are dropped
 * from the tail. `phi` is the levy's finder half, paid to `finder` (the block
 * miner's voucher). Returns the coinbase, the batch it binds, its A leaves,
 * and the shares left for a later round.
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
  random,
} = {}) {
  if (typeof labelOf !== 'function') throw new Error('t21_labels');
  if (hashBudget == null) throw new Error('hash_owed');
  const room = Math.min(CB_SHARE_MAX, Math.max(0, Math.floor(Number(shareMax))));
  const split = labelledShares(Array.isArray(batch) ? batch : [], labelOf);
  let live = split.keep.slice(0, room);
  const later = [...split.drop, ...split.keep.slice(room)];
  const ctx = { prevHeader, priorHeader, issuedJobKeys };
  const unit = BigInt(u);
  const want = BigInt(phi);
  if (want > 0n && !finder) throw new Error('finder_row');
  for (let pass = 0; pass <= REBUILDS; pass += 1) {
    let leaves = leavesOf(live, ctx);
    let W = leaves.reduce((a, l) => a + BigInt(l.count), 0n);
    while (leaves.length && unit * W > BigInt(hashBudget)) {
      const last = hexOf(leaves[leaves.length - 1].noteCommit);
      later.push(...live.filter((s) => noteCommitOfShare(s).toString('hex') === last));
      live = dropNcs(live, new Set([last]));
      leaves = leavesOf(live, ctx);
      W = leaves.reduce((a, l) => a + BigInt(l.count), 0n);
    }
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
      random,
    });
    const gone = new Set();
    for (const d of built.deferred) {
      for (const s of d.shares || []) gone.add(t21ShareNc(magic, s.E).toString('hex'));
    }
    if (!gone.size) {
      if (BigInt(built.phi || 0n) !== want) throw new Error('finder_row');
      return { ...built, batch: live, aLeaves: leaves, later };
    }
    later.push(...live.filter((s) => gone.has(noteCommitOfShare(s).toString('hex'))));
    live = dropNcs(live, gone);
  }
  throw new Error('t21_template');
}
