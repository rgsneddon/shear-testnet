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
  void workers;
  return { total: 0, identities: 0, glyphs: [], unit: shareUnit(shareBits) };
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
  return rows.slice(0, 64).map(() => ({
    identity: 'pool',
    blue: false,
  }));
}
