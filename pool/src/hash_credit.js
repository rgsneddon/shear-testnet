/**
 * Hash-bonus credit. A hasher with no accepted ShearHash-v2 share this
 * open round contributes 0, even if they report a huge hash counter.
 * After a valid share, bonus is proven roundHashes only.
 * clientHashes may paint HUD; they never mint.
 */

export function hasherHasValidRoundShare(miner) {
  return (Number(miner?.roundHashes) || 0) > 0;
}

/** Proven hashes this open round for bonus. Zero until a valid share is accepted.
 * clientHashes is HUD only — never a credit path. */
export function roundActualHashes(miner) {
  if (!hasherHasValidRoundShare(miner)) return 0;
  const proven = Math.floor(Number(miner.roundHashes) || 0);
  void miner?.clientHashes;
  void miner?.clientHashesRound0;
  return proven > 0 ? proven : 0;
}

/** Reject any future client-hash branch. */
export function clientHashCreditForbidden() {
  return true;
}
