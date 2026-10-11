/** Stored pool jobs. Same order as the issued-header cap, not a miner-count tuning. */
export const JOB_STORE_CAP = 4096;

/**
 * Keep `jobs` at `cap` entries. The written id becomes newest.
 * Pinned ids, including the id just written, are not evicted.
 * If every remaining id is pinned, the map stops above the cap
 * rather than dropping the live job.
 */
export function rememberStoredJob(jobs, id, rec, { cap = JOB_STORE_CAP, pin } = {}) {
  if (!jobs || typeof jobs.delete !== 'function' || typeof jobs.set !== 'function') return 0;
  const key = String(id);
  const pinned = new Set();
  const list = pin == null ? [] : (Array.isArray(pin) ? pin : [pin]);
  for (const p of list) {
    if (p != null && String(p) !== '') pinned.add(String(p));
  }
  pinned.add(key);
  if (typeof jobs.has === 'function' && jobs.has(key)) jobs.delete(key);
  jobs.set(key, rec);
  const limit = Math.max(1, Math.floor(Number(cap) || JOB_STORE_CAP));
  while (jobs.size > limit) {
    let oldest = null;
    if (typeof jobs.keys === 'function') {
      for (const k of jobs.keys()) {
        if (pinned.has(String(k))) continue;
        oldest = k;
        break;
      }
    }
    if (oldest == null) break;
    jobs.delete(oldest);
  }
  return jobs.size;
}
