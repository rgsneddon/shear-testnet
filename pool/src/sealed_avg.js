/** Gross sealed average. No pool-fee subtract and no clamp to 1. */
export function sealedAvgRewardShe(stats) {
  const height = Math.floor(Number(stats?.height) || 0);
  if (height <= 0) return null;
  const pot = Number(stats?.potEmittedNanos);
  const bonus = Number(stats?.hashBonusEmittedNanos);
  if (!Number.isFinite(pot) || !Number.isFinite(bonus)) return null;
  if (pot < 0 || bonus < 0) return null;
  return (pot + bonus) / height / 1e11;
}
