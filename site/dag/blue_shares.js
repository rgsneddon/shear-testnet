/**
 * Open-round blue set for the DINS-DAG page.
 * A worker is in the set only while this round has proven hashes.
 * Count is those hashes at the published share bits (2^bits per share).
 * Order is miner identity. Arrival order and session accepted totals are not membership.
 */
export function shareUnit(bits) {
  const b = Math.floor(Number(bits) || 0);
  if (b <= 0 || b >= 53) return 0;
  return 2 ** b;
}

export function blueShareModel(workers, shareBits) {
  const unit = shareUnit(shareBits);
  const rows = (Array.isArray(workers) ? workers : []).filter((w) => w && Number(w.roundHashes) > 0);
  rows.sort((a, b) => {
    const ia = String(a.miner || a.worker || '');
    const ib = String(b.miner || b.worker || '');
    if (ia < ib) return -1;
    if (ia > ib) return 1;
    return 0;
  });
  const glyphs = [];
  let total = 0;
  for (const row of rows) {
    const hashes = Number(row.roundHashes) || 0;
    const n = unit > 0 ? Math.max(1, Math.round(hashes / unit)) : 1;
    total += n;
    const room = 64 - glyphs.length;
    const paint = Math.min(n, Math.max(0, room));
    const identity = String(row.miner || row.worker || '');
    for (let k = 0; k < paint; k += 1) glyphs.push({ identity, ord: k });
  }
  return { total, identities: rows.length, glyphs, unit };
}

/** Connected workers on the mouth orbit, identity order. Blue marks the open-round set. */
export function orbitWorkers(workers) {
  const rows = (Array.isArray(workers) ? workers : []).filter((w) => w && w.connected);
  rows.sort((a, b) => {
    const ia = String(a.miner || a.worker || '');
    const ib = String(b.miner || b.worker || '');
    if (ia < ib) return -1;
    if (ia > ib) return 1;
    return 0;
  });
  return rows.slice(0, 64).map((w) => ({
    identity: String(w.miner || w.worker || ''),
    blue: Number(w.roundHashes) > 0,
  }));
}
