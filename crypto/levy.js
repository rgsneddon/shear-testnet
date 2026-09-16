/**
 * ADMITv2 Flow levy (LEVY=weight). fee = max(FLOOR, ceil(weight × RATE)).
 * Amount is not an input. Cap 0.001 SHE is a hard ceiling, not the price.
 * Split half finder, half Reserve vault.
 */
import { createHash } from 'node:crypto';
import { createPublicKey, verify } from 'node:crypto';
import { encodeDest, payoutDest, isDestAddress, hash20FromAddress, paymentIdHash, ED25519_SPKI_PREFIX, aliasDestOfSilentId } from './address.js';
import { NANOS_PER_SHE, MAGIC_TESTNET } from './asert.js';
import {
  verifyPoolWithdrawSig,
  recoverPoolWithdrawPub,
  ownerSecpPubFromSeed,
  ownerPubFromOpening,
  poolWithdrawDigest,
  POOL_WITHDRAW_DEADLINE_MS,
} from './eip712.js';

export const FEE_TAU_MS = 90_000;
export const FEE_TARGET_WEIGHT = 8;
export const FEE_SPLIT_FINDER_BPS = 5000;
export const FEE_SPLIT_RESERVE_BPS = 5000;
export const LEVY_FLOOR_UNITS = 100;
export const LEVY_BPS = 0;
export const LEVY_WEIGHT_RATE_NUM = 1;
/** JSON-sealed ADMITv2 + range + dummy is tens of KB; DEN keeps a normal send on FLOOR. */
export const LEVY_WEIGHT_RATE_DEN = 2048;
/** Hard ceiling: 0.001 SHE. Emergency brake, not the advertised price. */
export const LEVY_CAP_NANOS = Math.floor(0.001 * NANOS_PER_SHE);
export const SURGE_MAX = 3;
/** Waiting-bytes scale. Full surge at 3 * SURGE_REF. */
export const SURGE_REF = 2048;
export const CHAIN_ID = 2701;
export const PUBLIC_DECIMALS = 9;
export const WITHDRAW_MIN_NANOS = Math.floor(0.01 * NANOS_PER_SHE);

export const KIND_POT = 'pot';
export const KIND_HASH = 'hash';
export const KIND_LEVY_FINDER = 'finder-fee';
export const KIND_LEVY_RESERVE = 'reserve-fee';
export const KIND_POOL_FEE = 'pool-fee';
export const KIND_SEND = 'send';
export const KIND_EVM_VALUE = 'evm-value';
export const KIND_POOL_WITHDRAW = 'pool-withdraw';
export const KIND_VORTICE_REGISTER = 'vortice-register';

const TAXED = new Set([
  KIND_SEND,
  KIND_EVM_VALUE,
  KIND_POOL_WITHDRAW,
  KIND_VORTICE_REGISTER,
  'transfer',
  'user-spend',
  'lock',
  'vote',
]);

export function levyTaxed(tx) {
  const k = String(tx?.kind || tx?.vout?.[0]?.kind || KIND_SEND);
  if (tx?.coinbase) return false;
  if (k === 'claim' || k === 'join-claim') return false;
  if (k === 'withdraw') return false;
  if (k === 'reserve' || k === 'reserve-interest' || k === 'reserve-shortfall') return false;
  if (tx?.mint && k !== KIND_POOL_WITHDRAW && k !== KIND_VORTICE_REGISTER) return false;
  if (TAXED.has(k)) return true;
  return !tx?.mint && Array.isArray(tx?.vin) && tx.vin.length > 0 && k !== 'b-spend';
}

export function txWeight({ vouts = 0, memoChunks = 0, bFlag = 0 } = {}) {
  return Math.max(0, Math.floor(Number(vouts) || 0))
    + Math.max(0, Math.floor(Number(memoChunks) || 0))
    + (bFlag ? 1 : 0);
}

export function levyBase(_amountIgnored) {
  return LEVY_FLOOR_UNITS;
}

export function flowWeight(tx) {
  try {
    return Buffer.byteLength(JSON.stringify(tx || {}));
  } catch {
    return 0;
  }
}

export function levyFromWeight(weight) {
  const w = Math.max(0, Math.floor(Number(weight) || 0));
  const raw = Math.ceil((w * LEVY_WEIGHT_RATE_NUM) / LEVY_WEIGHT_RATE_DEN);
  return Math.max(LEVY_FLOOR_UNITS, raw);
}

export function levySurge(depth, ref = SURGE_REF) {
  const d = Math.max(0, Number(depth) || 0);
  const r = Math.max(1, Number(ref) || SURGE_REF);
  const s = d / r;
  if (s <= 0) return 0;
  if (s >= SURGE_MAX) return SURGE_MAX;
  return s;
}

export function txAmountNanos(tx) {
  if (tx == null) return 0;
  const n = Number(tx.nanos || tx.vout?.[0]?.nanos || 0);
  return Math.max(0, Math.floor(n));
}

/**
 * Weight levy in protocol units. amountNanos is ignored.
 * levyNanos(_, { weight }) or levyNanos() → FLOOR (wallet default / relay min).
 */
export function levyNanos(amountNanos, opts = 0) {
  if (typeof opts === 'object' && opts && opts.weight != null) {
    return levyFromWeight(opts.weight);
  }
  if (typeof opts === 'object' && opts && opts.tx) {
    return levyFromWeight(flowWeight(opts.tx));
  }
  return LEVY_FLOOR_UNITS;
}

export function quoteLevy(amountNanos, pressure = {}) {
  const weight = Number(pressure.weight || 0);
  const L = weight > 0 ? levyFromWeight(weight) : levyNanos(amountNanos, pressure);
  const split = splitLevy(L);
  return {
    amount: Math.max(0, Math.floor(Number(amountNanos) || 0)),
    levy: L,
    L,
    L_base: LEVY_FLOOR_UNITS,
    weight,
    surge: 0,
    finder: split.finder,
    reserve: split.reserve,
    spaceNotPercent: true,
  };
}

export function splitLevy(levy) {
  const n = Math.max(0, Math.floor(Number(levy) || 0));
  const finder = Math.floor(n * FEE_SPLIT_FINDER_BPS / 10000);
  return { finder, reserve: n - finder };
}

/** Fee ASERT: heavier parent weight raises next header base_fee. Not the Phase B L. */
export function nextBaseFee(parentBase, parentWeight, target = FEE_TARGET_WEIGHT) {
  const prev = Math.max(1, Math.floor(Number(parentBase) || 1));
  let seen = Number(parentWeight);
  if (!Number.isFinite(seen) || seen < 1) seen = 1;
  const t = Math.max(1, Math.floor(Number(target) || FEE_TARGET_WEIGHT));
  const ratio = seen / t;
  const delta = Math.round(Math.log2(Math.max(1 / 4, Math.min(4, ratio))));
  return Math.max(1, prev * (2 ** delta));
}

export function reserveFeeDest() {
  return encodeDest(createHash('sha256').update('shear-reserve-v1-fee').digest().subarray(0, 20));
}

export function poolFeeDest() {
  return encodeDest(createHash('sha256').update('shear-pool-fee-v1').digest().subarray(0, 20));
}

export function poolPayoutDest() {
  return encodeDest(createHash('sha256').update('shear-pool-payout-v1').digest().subarray(0, 20));
}

export function isSponsorV1(addr) {
  return String(addr || '') === poolFeeDest();
}

export function mempoolDepthBytes(txs = []) {
  let n = 0;
  for (const tx of txs || []) {
    if (!levyTaxed(tx)) continue;
    n += JSON.stringify(tx).length;
  }
  return n;
}

/** Consensus L for tx: weight of the sealed body, not amount. prefix unused for the rate. */
export function levyNeed(tx, prefix = []) {
  if (!levyTaxed(tx)) return 0;
  void prefix;
  return levyFromWeight(flowWeight(tx));
}

/** Set fee (and maxLevy if present) from sealed weight. Call after proofs are attached. */
export function bindWeightFee(tx) {
  if (!tx || !levyTaxed(tx)) return tx;
  const L = levyNeed(tx);
  tx.fee = L;
  if (tx.maxLevy != null) tx.maxLevy = L;
  return tx;
}

export function mempoolPressure(txs = []) {
  const depth = mempoolDepthBytes(txs);
  return {
    ok: true,
    depth,
    surge: levySurge(depth),
    surgeMax: SURGE_MAX,
    surgeRef: SURGE_REF,
    levyFloor: LEVY_FLOOR_UNITS,
    levyBps: LEVY_BPS,
    levyCap: LEVY_CAP_NANOS,
    chainId: CHAIN_ID,
  };
}

export function blockWeight(txs = [], bLeaves = []) {
  let w = 0;
  for (const tx of txs) {
    if (tx?.coinbase) continue;
    const vouts = Array.isArray(tx.vout) ? tx.vout.length : 1;
    const memo = tx.memoCt || tx.memoH ? 1 : 0;
    const bFlag = tx.bSpend || tx.bFlag ? 1 : 0;
    w += txWeight({ vouts, memoChunks: memo, bFlag });
  }
  w += (Array.isArray(bLeaves) && bLeaves.length) ? 1 : 0;
  return w;
}

export function containsShe1(obj) {
  const s = typeof obj === 'string' ? obj : JSON.stringify(obj || {});
  return /(?:^|[^a-z])she1[0-9a-z]*/i.test(s.replace(/ssa1/gi, ''));
}

export function poolWithdrawTx({ from, to, nanos, fee, id } = {}) {
  const L = Math.max(0, Math.floor(Number(fee) || 0));
  // One pool wallet: miner pots and the pull levy both sit on `from`.
  // Until unlock height the only spends from that dest are miner pulls + levy.
  return {
    id: id || `pull-${Date.now()}`,
    kind: KIND_POOL_WITHDRAW,
    from,
    to,
    nanos,
    fee: L,
    sponsor: from,
    vin: [{ address: from }],
    vout: [{ address: to, nanos, kind: KIND_POOL_WITHDRAW }],
  };
}

/**
 * One HTTP verifier for /api/miners/:tag pull and /api/pool/withdraw.
 * EIP-712 bound to the miner's spend-derived secp key. she1 never mined.
 */
export function verifyPoolWithdrawOffchain({
  login,
  dest,
  nanos,
  sig,
  minerShe1,
  payoutSsa1,
  height = 0,
  nonce = 0,
  deadline = 0,
  nowMs = Date.now(),
  ownerSeed = null,
  ownerPub = null,
  confirmedNanos = null,
  nonceStore = null,
  seenDigests = null,
  verifyingContract = Buffer.alloc(20),
  open = '',
  spendSig = '',
  requireOwner = false,
} = {}) {
  const she = String(minerShe1 || login || '').trim().split('.')[0];
  if (!she.startsWith('she1')) return { ok: false, reason: 'need_she1' };
  const payout = String(payoutSsa1 || dest || '').trim();
  if (!payout || containsShe1(payout) || /^she1/i.test(payout)) return { ok: false, reason: 'she1' };
  if (!isDestAddress(payout)) return { ok: false, reason: 'she1' };
  const sheDest = aliasDestOfSilentId(she);
  if (sheDest && payout === sheDest) return { ok: false, reason: 'not_indexed' };
  const n = Math.floor(Number(nanos) || 0);
  if (n < WITHDRAW_MIN_NANOS) return { ok: false, reason: 'min' };
  if (confirmedNanos != null && n > Math.floor(Number(confirmedNanos) || 0)) {
    return { ok: false, reason: 'over_unpaid' };
  }
  const dl = Math.floor(Number(deadline) || 0);
  const now = Math.floor(Number(nowMs) || 0);
  if (dl) {
    if (dl < now || dl > now + POOL_WITHDRAW_DEADLINE_MS) return { ok: false, reason: 'deadline' };
  }
  if (!sig) return { ok: false, reason: 'unsigned' };
  const fields = {
    login: she,
    dest: payout,
    minerShe1: she,
    payoutSsa1: payout,
    nanos: n,
    height,
    nonce,
    deadline: dl,
    sig,
    verifyingContract,
    chainId: MAGIC_TESTNET,
  };
  if (!verifyPoolWithdrawSig(fields)) return { ok: false, reason: 'unsigned' };
  const recovered = recoverPoolWithdrawPub(sig);
  const want = ownerPub
    ? Buffer.from(ownerPub)
    : (ownerSeed ? ownerSecpPubFromSeed(ownerSeed) : ownerPubFromOpening(open));
  if (want && recovered && !recovered.equals(Buffer.from(want))) return { ok: false, reason: 'not_owner' };
  if (requireOwner && recovered && !want) return { ok: false, reason: 'not_owner' };
  if (requireOwner) {
    const hex = String(open || '').replace(/^0x/i, '');
    if (!/^[0-9a-f]{128}$/i.test(hex) || !spendSig) return { ok: false, reason: 'not_owner' };
    const buf = Buffer.from(hex, 'hex');
    const sheDest = aliasDestOfSilentId(she);
    const want20 = sheDest && hash20FromAddress(sheDest);
    const got20 = paymentIdHash(buf.subarray(0, 32), buf.subarray(32, 64));
    if (!want20 || !Buffer.from(got20).equals(Buffer.from(want20))) return { ok: false, reason: 'not_owner' };
    try {
      const pub = createPublicKey({
        key: Buffer.concat([ED25519_SPKI_PREFIX, buf.subarray(32, 64)]),
        format: 'der',
        type: 'spki',
      });
      const digest = poolWithdrawDigest(fields);
      if (!verify(null, digest, pub, Buffer.from(String(spendSig).replace(/^0x/i, ''), 'hex'))) {
        return { ok: false, reason: 'not_owner' };
      }
    } catch {
      return { ok: false, reason: 'not_owner' };
    }
  }
  const digest = poolWithdrawDigest(fields).toString('hex');
  if (seenDigests instanceof Set && seenDigests.has(digest)) return { ok: false, reason: 'replay' };
  const minerKey = she.toLowerCase();
  const nn = Math.floor(Number(nonce) || 0);
  if (nonceStore instanceof Map) {
    const used = nonceStore.get(minerKey) || new Set();
    if (nn && used.has(nn)) return { ok: false, reason: 'replay' };
  }
  if (seenDigests instanceof Set) seenDigests.add(digest);
  if (nonceStore instanceof Map && nn) {
    const used = nonceStore.get(minerKey) || new Set();
    used.add(nn);
    nonceStore.set(minerKey, used);
  }
  return { ok: true, login: she, dest: payout, nanos: n, nonce: nn, digest };
}
