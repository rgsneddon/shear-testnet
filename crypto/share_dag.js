/**
 * Offline model of DINS Variant B. The flag stays off until Russell GO.
 * Membership is the blue set, never arrival order.
 * One mint: spine pot plus hash nanos, once per eligible share.
 */
export const DINS_ENABLED = false;

/** Separate from payment STEM_MAX_HOPS / FLUFF_*. Do not retune those. */
export const SHARE_STEM_MAX_HOPS = 3;
export const SHARE_FLUFF_MIN_MS = 1000;
export const SHARE_FLUFF_MAX_MS = 3000;

export function sealShareDag({ spinePot, shares, blue, omittedBlue = [] } = {}) {
  const eligible = new Set(blue || []);
  for (const id of omittedBlue) {
    if (eligible.has(id)) {
      return { ok: false, reason: 'omit_eligible_foreign' };
    }
  }
  const paid = new Set();
  let hashNanos = 0;
  for (const share of shares || []) {
    if (!eligible.has(share.id)) continue;
    if (paid.has(share.id)) continue;
    paid.add(share.id);
    hashNanos += Number(share.hashNanos) || 0;
  }
  const potNanos = Number(spinePot) || 0;
  return {
    ok: true,
    potNanos,
    hashNanos,
    emissionNanos: potNanos + hashNanos,
    paid: [...paid],
  };
}

/** In-memory share DAG. Arrival order is stored and never used as membership. */
export function createShareDag() {
  return { shares: new Map(), seen: [] };
}

export function addShare(dag, share) {
  const id = String(share?.noteCommit || share?.id || '');
  if (!id || dag.shares.has(id)) return dag;
  dag.shares.set(id, {
    id,
    hashNanos: Number(share.hashNanos) || 0,
    parent: share.parent ? String(share.parent) : '',
  });
  dag.seen.push(id);
  return dag;
}

/** Eligible blue ids, sorted. `seen` order is not the sort. */
export function blueIds(dag) {
  return [...dag.shares.keys()].sort();
}

export function sealDag(dag, { spinePot = 0, omittedBlue = [] } = {}) {
  const blue = blueIds(dag);
  const shares = blue.map((id) => dag.shares.get(id));
  return sealShareDag({ spinePot, shares, blue, omittedBlue });
}

/**
 * DINS on: hash nanos live on the seal leaves only.
 * The pull-book hash leg must be zero or the same work is paid twice.
 */
export function soleMint({ enabled, pullBookHashNanos = 0, leafHashNanos = 0 } = {}) {
  const book = Math.max(0, Math.floor(Number(pullBookHashNanos) || 0));
  const leaves = Math.max(0, Math.floor(Number(leafHashNanos) || 0));
  if (enabled && book > 0 && leaves > 0) {
    return { ok: false, reason: 'double_pay', pullBookHashNanos: book, leafHashNanos: leaves };
  }
  if (enabled) {
    return { ok: true, pullBookHashNanos: 0, leafHashNanos: leaves };
  }
  return { ok: true, pullBookHashNanos: book, leafHashNanos: 0 };
}
