/**
 * Low / Medium / High claim fees.
 * The mempool ranks a body by fee per verify-weight. A preset is one of
 * those rates applied to this claim's verify-weight, as an integer nanos
 * fee and the exact SHE that fee is. A custom bid is the same pair.
 * The fee is never under the weight levy and never over the levy cap.
 */
import { NANOS_PER_SHE } from './asert.js';
import { publicBytes, txVerifyWeight } from './block_budget.js';
import { LEVY_CAP_NANOS, levyNanos } from './levy.js';
import { rewardClaimTx } from './reserve_vault.js';

const PRESET_IDS = [
  ['low', 'Low'],
  ['medium', 'Medium'],
  ['high', 'High'],
];

/** Integer nanos as SHE. No float, and no public-digit truncation. */
export function exactSheFromNanos(nanos) {
  const n = Math.max(0, Math.floor(Number(nanos) || 0));
  const scale = NANOS_PER_SHE;
  const whole = Math.floor(n / scale);
  const frac = n % scale;
  if (frac === 0) return String(whole);
  const digits = String(frac).padStart(11, '0').replace(/0+$/, '');
  return `${whole}.${digits}`;
}

function stableFloor(tx) {
  const copy = { ...tx };
  delete copy.fee;
  let fee = levyNanos(0, { tx: copy });
  copy.fee = fee;
  for (let i = 0; i < 8; i += 1) {
    const need = levyNanos(0, { tx: copy });
    if (fee >= need) break;
    fee = need;
    copy.fee = fee;
  }
  if (fee > LEVY_CAP_NANOS) return LEVY_CAP_NANOS;
  return fee;
}

function rateCmp(a, b) {
  const left = a.fee * b.w;
  const right = b.fee * a.w;
  if (left !== right) return left < right ? -1 : 1;
  return a.i - b.i;
}

/** ceil(peerFee * claimWeight / peerWeight), or the cap if the product is not a safe integer. */
function feeAtRate(peerFee, peerWeight, claimWeight) {
  const pf = Math.floor(peerFee);
  const pw = Math.max(1, Math.floor(peerWeight));
  const cw = Math.max(1, Math.floor(claimWeight));
  if (!Number.isSafeInteger(pf) || pf < 0 || !Number.isSafeInteger(cw)) return LEVY_CAP_NANOS;
  if (pf > 0 && pf > Math.floor(Number.MAX_SAFE_INTEGER / cw)) return LEVY_CAP_NANOS;
  const num = pf * cw;
  return Math.floor((num + pw - 1) / pw);
}

function clampFee(fee, floor) {
  let n = Math.floor(Number(fee) || 0);
  if (n < floor) n = floor;
  if (n > LEVY_CAP_NANOS) n = LEVY_CAP_NANOS;
  return n;
}

function observedRates(mempool) {
  const rows = [];
  const list = Array.isArray(mempool) ? mempool : [];
  for (let i = 0; i < list.length; i += 1) {
    const tx = list[i];
    if (!tx || tx.coinbase) continue;
    const fee = Math.floor(Number(tx.fee) || 0);
    if (fee <= 0) continue;
    const w = txVerifyWeight(tx);
    rows.push({ fee, w: Math.max(1, w), i });
  }
  rows.sort(rateCmp);
  return rows;
}

function presetRow(id, label, fee, { capped = false } = {}) {
  return {
    id,
    label,
    fee,
    she: exactSheFromNanos(fee),
    capped: capped === true,
  };
}

/**
 * Three presets plus a custom slot.
 * Low is the cheapest mempool rate, medium the upper median, high the dearest.
 * An empty mempool prices every preset at this claim's weight-levy floor.
 * `custom` is the caller's own nanos bid. It is reported even when it is
 * under the floor or over the cap; `ok` is false in that case.
 */
export function claimFeePresets(tx, mempool = [], { custom = null } = {}) {
  const weight = Math.max(1, txVerifyWeight(tx));
  const bytes = publicBytes(tx);
  const floor = stableFloor(tx);
  const rates = observedRates(mempool);
  const at = (index) => {
    if (!rates.length) return { fee: floor, capped: false };
    const rate = rates[Math.max(0, Math.min(rates.length - 1, index))];
    const raw = feeAtRate(rate.fee, rate.w, weight);
    const fee = clampFee(raw, floor);
    return { fee, capped: raw > LEVY_CAP_NANOS };
  };
  const n = rates.length;
  const picks = n === 0
    ? [at(0), at(0), at(0)]
    : [at(0), at(Math.floor(n / 2)), at(n - 1)];
  const presets = PRESET_IDS.map(([id, label], i) => presetRow(id, label, picks[i].fee, { capped: picks[i].capped }));
  let customRow = { id: 'custom', label: 'Custom', fee: null, she: null, ok: true };
  if (custom != null && custom !== '') {
    const bid = Math.floor(Number(custom));
    const legal = Number.isSafeInteger(bid) && bid >= floor && bid <= LEVY_CAP_NANOS;
    customRow = {
      id: 'custom',
      label: 'Custom',
      fee: Number.isSafeInteger(bid) && bid >= 0 ? bid : null,
      she: Number.isSafeInteger(bid) && bid >= 0 ? exactSheFromNanos(bid) : null,
      ok: legal,
      ...(legal ? {} : { reason: 'levy' }),
    };
  }
  return { weight, bytes, floor, cap: LEVY_CAP_NANOS, presets, custom: customRow };
}

/**
 * Build one reward claim and the Low / Medium / High quote for it.
 * `preset` ('low' | 'medium' | 'high') or a legal `custom` nanos bid
 * is written onto the tx. Otherwise the tx keeps the weight-levy floor.
 * The quote is not a consensus field.
 */
export function buildRewardClaim({
  mempool = [],
  custom = null,
  preset = null,
  ...claim
} = {}) {
  const tx = rewardClaimTx(claim);
  const quote = claimFeePresets(tx, mempool, { custom });
  const named = quote.presets.find((row) => row.id === preset);
  if (named) tx.fee = named.fee;
  else if (quote.custom && quote.custom.ok && quote.custom.fee != null && custom != null && custom !== '') {
    tx.fee = quote.custom.fee;
  }
  return { tx, ...quote, bytes: publicBytes(tx) };
}
