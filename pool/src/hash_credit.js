/**
 * Hash-bonus credit. A hasher with no accepted ShearHash-v2 share this
 * open round contributes 0, even if they report a huge hash counter.
 * After a valid share, bonus follows that miner's own hash count this round.
 */

export function hasherHasValidRoundShare(miner) {
  return (Number(miner?.roundHashes) || 0) > 0;
}

/** Hashes this open round for bonus. Zero until a valid share is accepted. */
export function roundActualHashes(miner) {
  if (!hasherHasValidRoundShare(miner)) return 0;
  const proven = Math.floor(Number(miner.roundHashes) || 0);
  const h = Number(miner?.clientHashes) || 0;
  const z = Number(miner?.clientHashesRound0);
  const base = Number.isFinite(z) ? z : 0;
  const n = Math.floor(h < base ? h : h - base);
  if (n > 0) return n;
  return proven > 0 ? proven : 0;
}
