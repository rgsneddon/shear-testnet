import { createHash } from 'node:crypto';
import {
  JOIN_PROGRAM,
  JOIN_KIND_GENESIS,
  JOIN_WINDOW_MS,
  NANOS_PER_SHE,
  PRIOR_UNITS_PER_COIN,
  PRIOR_TO_SHEAR_UNITS,
  extraMintAllowed,
} from './asert.js';
import { isDestAddress, isShearAddress } from './address.js';
import { merkleRoot, merkleProof, merkleVerify } from './merkle.js';

export const JOIN_LEAF_PERSONAL = 'shear-join-leaf-v1';
export const KIND_CLAIM = 'claim';
export const KIND_BURN = 'burn';
export { JOIN_PROGRAM, JOIN_KIND_GENESIS, JOIN_WINDOW_MS };

export function priorUnitsFromCoins(coins) {
  const n = Number(coins);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n * PRIOR_UNITS_PER_COIN);
}

export function shearNanosFromPriorUnits(priorUnits) {
  const n = Math.floor(Number(priorUnits) || 0);
  if (n <= 0) return 0;
  return n * PRIOR_TO_SHEAR_UNITS;
}

export function leafCommit({ owner, amountPrior }) {
  return createHash('sha256')
    .update(JOIN_LEAF_PERSONAL)
    .update(String(owner || ''))
    .update(String(Math.floor(Number(amountPrior) || 0)))
    .digest();
}

export function buildSnapshot(rows) {
  const list = [];
  for (const row of rows || []) {
    const owner = String(row.owner || row.id || '');
    const amountPrior = row.amountPrior != null
      ? Math.floor(Number(row.amountPrior))
      : priorUnitsFromCoins(row.coins);
    if (!owner || amountPrior <= 0) continue;
    const commit = leafCommit({ owner, amountPrior });
    list.push({ owner, amountPrior, commit: commit.toString('hex') });
  }
  list.sort((a, b) => a.commit.localeCompare(b.commit));
  const leaves = list.map((r) => Buffer.from(r.commit, 'hex'));
  const root = merkleRoot(leaves);
  const circulatingPrior = list.reduce((s, r) => s + r.amountPrior, 0);
  const circulatingNanos = shearNanosFromPriorUnits(circulatingPrior);
  return {
    root: root.toString('hex'),
    rows: list.map((r, index) => ({
      ...r,
      index,
      proof: merkleProof(leaves, index),
      shearNanos: shearNanosFromPriorUnits(r.amountPrior),
    })),
    circulatingPrior,
    circulatingNanos,
  };
}

export function encodeJoinKey({ owner, amountPrior, proof, index, commit }) {
  const body = {
    v: 1,
    owner: String(owner || ''),
    amountPrior: Math.floor(Number(amountPrior) || 0),
    commit: String(commit || ''),
    index: Math.floor(Number(index) || 0),
    proof: Array.isArray(proof) ? proof : [],
  };
  return `join1.${Buffer.from(JSON.stringify(body)).toString('base64url')}`;
}

/** join1. cheque for one holder against a full-circulation snapshot (proof + root). */
export function issueJoinKey(snapshot, owner) {
  const want = String(owner || '');
  const row = (snapshot?.rows || []).find((r) => r.owner === want);
  if (!snapshot?.root || !row) return { ok: false, reason: 'not_in_snapshot' };
  return {
    ok: true,
    key: encodeJoinKey(row),
    root: snapshot.root,
    circulatingNanos: snapshot.circulatingNanos,
    owner: row.owner,
    amountPrior: row.amountPrior,
    nanos: row.shearNanos,
    she: row.shearNanos / NANOS_PER_SHE,
  };
}

/** Issue a join1. key from the full holder list. `holders` is the genesis circulation. */
export function mintJoinKey({ owner, holders } = {}) {
  if (!Array.isArray(holders) || holders.length < 1) {
    return { ok: false, reason: 'need_snapshot' };
  }
  return issueJoinKey(buildSnapshot(holders), owner);
}

export function decodeJoinKey(raw) {
  const s = String(raw || '').trim();
  const prefix = 'join1.';
  if (!s.startsWith(prefix)) return { ok: false, reason: 'bad_key' };
  try {
    const body = JSON.parse(Buffer.from(s.slice(prefix.length), 'base64url').toString('utf8'));
    const owner = String(body.owner || '');
    const amountPrior = Math.floor(Number(body.amountPrior) || 0);
    const commit = String(body.commit || '');
    const index = Math.floor(Number(body.index) || 0);
    const proof = Array.isArray(body.proof) ? body.proof : [];
    if (!owner || amountPrior <= 0 || !commit) return { ok: false, reason: 'bad_key' };
    const want = leafCommit({ owner, amountPrior }).toString('hex');
    if (want !== commit) return { ok: false, reason: 'bad_commit' };
    return { ok: true, owner, amountPrior, commit, index, proof };
  } catch {
    return { ok: false, reason: 'bad_key' };
  }
}

export function emptyJoin({ genesisMs = 0, root = '', circulatingNanos = 0, vaultDest = '' } = {}) {
  return {
    programId: JOIN_PROGRAM,
    genesisMs: genesisMs || 0,
    root: String(root || ''),
    vaultDest: String(vaultDest || ''),
    circulatingNanos: Math.floor(Number(circulatingNanos) || 0),
    remainingNanos: Math.floor(Number(circulatingNanos) || 0),
    claimed: Object.create(null),
    burned: false,
  };
}

export function remainingMs(state, nowMs) {
  if (!state.genesisMs) return JOIN_WINDOW_MS;
  return Math.max(0, state.genesisMs + JOIN_WINDOW_MS - nowMs);
}

export function windowOpen(state, nowMs) {
  if (!state.genesisMs || state.burned) return false;
  return remainingMs(state, nowMs) > 0;
}

export function publicJoinView(state, nowMs) {
  return {
    programId: JOIN_PROGRAM,
    genesisMs: state.genesisMs || 0,
    remainingMs: remainingMs(state, nowMs),
    circulatingNanos: state.circulatingNanos || 0,
    remainingNanos: state.remainingNanos || 0,
    claimedCount: Object.keys(state.claimed || {}).length,
    burned: !!state.burned,
    root: state.root || '',
  };
}

/** One extra-mint: `nanos` must be the full snapshot circulation. Claims later drain remainingNanos. */
export function fundGenesis({ state, nanos, nowMs, root, to } = {}) {
  if (state.genesisMs) return { ok: false, reason: 'already_funded' };
  const n = Math.floor(Number(nanos) || 0);
  if (n <= 0) return { ok: false, reason: 'bad_amount' };
  if (!extraMintAllowed(JOIN_PROGRAM, { kind: JOIN_KIND_GENESIS, funded: !!state.genesisMs })) {
    return { ok: false, reason: 'mint_forbidden' };
  }
  state.genesisMs = nowMs;
  state.root = String(root || '');
  state.circulatingNanos = n;
  state.remainingNanos = n;
  state.burned = false;
  if (to && isDestAddress(to) && !isShearAddress(to)) state.vaultDest = to;
  return { ok: true, nanos: n, kind: JOIN_KIND_GENESIS, programId: JOIN_PROGRAM, mint: true };
}

export function genesisTx({ to, nanos, root }) {
  const n = Math.floor(Number(nanos) || 0);
  return {
    programId: JOIN_PROGRAM,
    mint: true,
    kind: JOIN_KIND_GENESIS,
    to,
    nanos: n,
    root: String(root || ''),
    vin: [],
    vout: [{ address: to, nanos: n, kind: JOIN_KIND_GENESIS }],
  };
}

export function claimTx({ from, to, nanos, commit }) {
  const n = Math.floor(Number(nanos) || 0);
  return {
    programId: JOIN_PROGRAM,
    kind: KIND_CLAIM,
    from,
    to,
    nanos: n,
    commit: String(commit || ''),
    vin: [{ address: from }],
    vout: [{ address: to, nanos: n, kind: KIND_CLAIM }],
  };
}

export function burnTx({ from, nanos }) {
  const n = Math.floor(Number(nanos) || 0);
  return {
    programId: JOIN_PROGRAM,
    kind: KIND_BURN,
    from,
    nanos: n,
    vin: [{ address: from }],
    vout: [],
  };
}

export function claim({ state, key, payout, nowMs, root }) {
  if (!isDestAddress(payout) || isShearAddress(payout)) {
    return { ok: false, reason: 'bad_dest' };
  }
  if (!windowOpen(state, nowMs)) return { ok: false, reason: 'window_closed' };
  const parsed = decodeJoinKey(key);
  if (!parsed.ok) return parsed;
  const snapRoot = root || state.root;
  if (!snapRoot) return { ok: false, reason: 'no_snapshot' };
  const leaf = Buffer.from(parsed.commit, 'hex');
  if (!merkleVerify(leaf, parsed.proof, Buffer.from(snapRoot, 'hex'))) {
    return { ok: false, reason: 'bad_proof' };
  }
  if (state.claimed[parsed.commit]) return { ok: false, reason: 'already_claimed' };
  const nanos = shearNanosFromPriorUnits(parsed.amountPrior);
  if (nanos <= 0 || nanos > state.remainingNanos) return { ok: false, reason: 'empty' };
  state.claimed[parsed.commit] = { nanos, payout, atMs: nowMs };
  state.remainingNanos -= nanos;
  return {
    ok: true,
    nanos,
    she: nanos / NANOS_PER_SHE,
    to: payout,
    commit: parsed.commit,
    programId: JOIN_PROGRAM,
    kind: KIND_CLAIM,
  };
}

export function burnUnclaimed({ state, nowMs }) {
  if (!state.genesisMs) return { ok: false, reason: 'no_genesis' };
  if (windowOpen(state, nowMs)) return { ok: false, reason: 'window_open' };
  if (state.burned) return { ok: true, nanos: 0, already: true };
  const nanos = state.remainingNanos;
  state.remainingNanos = 0;
  state.burned = true;
  return { ok: true, nanos, kind: KIND_BURN, programId: JOIN_PROGRAM };
}

export function applyJoinBlock({ state, block, nowMs }) {
  const txs = Array.isArray(block?.txs) ? block.txs : [];
  const results = [];
  for (const tx of txs) {
    if (!tx || tx.coinbase) continue;
    if (String(tx.programId || '') !== JOIN_PROGRAM) continue;
    const kind = String(tx.kind || tx.vout?.[0]?.kind || '');
    if (kind === JOIN_KIND_GENESIS) {
      results.push({
        action: JOIN_KIND_GENESIS,
        ...fundGenesis({
          state,
          nanos: tx.nanos || tx.vout?.[0]?.nanos,
          nowMs,
          root: tx.root,
          to: tx.to || tx.vout?.[0]?.address,
        }),
      });
      continue;
    }
    if (kind === KIND_CLAIM) {
      results.push({
        action: KIND_CLAIM,
        ...claim({
          state,
          key: tx.key,
          payout: tx.to || tx.vout?.[0]?.address,
          nowMs,
          root: tx.root,
        }),
      });
      continue;
    }
    if (kind === KIND_BURN) {
      const want = state.remainingNanos;
      const n = Math.floor(Number(tx.nanos || 0));
      if (!state.burned && n !== want) {
        results.push({ action: KIND_BURN, ok: false, reason: 'bad_burn' });
        continue;
      }
      results.push({ action: KIND_BURN, ...burnUnclaimed({ state, nowMs }) });
    }
  }
  return results;
}

function cloneJoin(state) {
  return {
    ...state,
    claimed: { ...(state.claimed || {}) },
  };
}

export function validateJoinBlock({ state, block, nowMs }) {
  const trial = cloneJoin(state);
  const results = applyJoinBlock({ state: trial, block, nowMs });
  const fail = results.find((r) => r.ok === false);
  if (fail) return { ok: false, reason: fail.reason };
  return { ok: true };
}
