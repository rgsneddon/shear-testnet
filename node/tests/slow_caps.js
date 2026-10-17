/**
 * Wall-clock cap for each slow node test file.
 * node/tests/run_slow.js runs one file at a time and kills the process group
 * at this limit. A synchronous native prove blocks Node's own timer, so
 * this outer kill is the file cap. The same number is the suite timeout.
 * A test that sets its own timeout can be shorter. These are ceilings.
 */
export const SLOW_FILES = [
  { file: 'test_admit_consensus.js', capMs: 4 * 60 * 60 * 1000 },
  { file: 'test_admit_v3_fund_v12.js', capMs: 3 * 60 * 60 * 1000 },
  { file: 'test_adopt_unit_v12.js', capMs: 45 * 60 * 1000 },
  { file: 'test_frontier_burial_v12.js', capMs: 2 * 60 * 60 * 1000 },
  { file: 'test_fund_verdict_v12.js', capMs: 30 * 60 * 1000 },
  { file: 'test_levy_verify.js', capMs: 60 * 60 * 1000 },
  { file: 'test_lock_tag_respend_v12.js', capMs: 30 * 60 * 1000 },
  { file: 'test_p2p.js', capMs: 3 * 60 * 60 * 1000 },
  { file: 'test_reserve.js', capMs: 45 * 60 * 1000 },
  { file: 'test_reserve_trial_v12.js', capMs: 30 * 60 * 1000 },
  { file: 'test_solo_stratum.js', capMs: 60 * 60 * 1000 },
  { file: 'test_vault_parity_v12.js', capMs: 30 * 60 * 1000 },
];

const byFile = new Map(SLOW_FILES.map((row) => [row.file, row.capMs]));

export function fileCapMs(metaUrl) {
  const base = metaUrl.slice(metaUrl.lastIndexOf('/') + 1);
  const cap = byFile.get(base);
  if (!cap) throw new Error(`no slow-file cap for ${base}`);
  return cap;
}
