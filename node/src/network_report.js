/**
 * Public network report. Proven chain and work figures only.
 * No dest, amount, seed, address, or claimed hashes-per-second.
 */

const MINER_TAG = /^m[0-9a-f]{8}$/;
const KIND = /^[a-z][a-z0-9-]{0,31}$/;

export function safeMinerRounds(rows) {
  const best = new Map();
  for (const r of rows || []) {
    const tag = String(r?.tag || r?.miner || '').trim().toLowerCase();
    const count = Math.floor(Number(r?.count ?? r?.roundHashes) || 0);
    if (!MINER_TAG.test(tag) || count < 1) continue;
    const prev = best.get(tag) || 0;
    if (count > prev) best.set(tag, count);
  }
  return [...best.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || (a.tag < b.tag ? -1 : 1));
}

/** Rows whose proven count is new or higher. Equal counts are not relayed again. */
export function freshMinerRounds(before, after) {
  const prev = new Map(safeMinerRounds(before).map((r) => [r.tag, r.count]));
  return safeMinerRounds(after).filter((r) => (prev.get(r.tag) || 0) < r.count);
}

export function networkReport({
  height = 0,
  hash = '',
  nodesOnline = 0,
  peersLive = 0,
  rounds = [],
  mempool = [],
} = {}) {
  const clean = safeMinerRounds(rounds);
  const pendingKinds = {};
  let pending = 0;
  for (const tx of mempool || []) {
    pending += 1;
    const raw = String(tx?.kind || (tx?.coinbase ? 'coinbase' : 'send'));
    const leaked = /she1|ssa1|shear1|\d/.test(raw);
    const kind = KIND.test(raw) && !leaked ? raw : 'other';
    pendingKinds[kind] = (pendingKinds[kind] || 0) + 1;
  }
  const tip = String(hash || '').toLowerCase();
  return {
    ok: true,
    height: Math.max(0, Math.floor(Number(height) || 0)),
    hash: /^[0-9a-f]{64}$/.test(tip) ? tip : '',
    nodesOnline: Math.max(0, Math.floor(Number(nodesOnline) || 0)),
    peersLive: Math.max(0, Math.floor(Number(peersLive) || 0)),
    provenRoundHashes: clean.reduce((sum, r) => sum + r.count, 0),
    miners: clean.length,
    rounds: clean,
    pending,
    pendingKinds,
  };
}
