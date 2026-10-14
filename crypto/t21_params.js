/**
 * T21 hidden-coinbase parameters. Fingerprint tokens live here.
 * consensusFingerprint() absorbs T21_FINGERPRINT_TOKENS in one freeze.
 * AMOUNT=confidential stays the token. The law sentence is AMOUNT_LAW.
 */
export const T21_VERSION = 'split-v1';
export const CB_FORM = 'cb-v3';
export const AMOUNT_LAW = 'hidden for every output except reserve-program rows';
export const GEN_H = 'feea2914bda937d74acc1efa93bf1094f65ae709628a7aad9d1b913b6c80c301';

export const K_MIN = 4;
export const FEE_BPS_MAX = 200;
export const VOUCHER_GAP = 256;
export const W_S_MAX = 1n << 28n;
export const W_MAX = 1n << 48n;
/** Σw is retained share units, at most MAX_HASH_UNITS_PER_BLOCK (asert.js); u·W ≤ B_h on every path. */
export const HASH_CAP_BITS = 28;
export const W_HASH_MAX = 1n << BigInt(HASH_CAP_BITS);
export const SCALAR_MAX = 1n << 64n;
export const OUTPUT_MAX = 65536;
export const PAYOUT_KIND_CODE = 0x20;
export const VAULT_KIND_CODE = 0x23;
export const RANGE_TAG = 0x02;
export const CHUNK_BITS = 16;
export const V_CHUNKS = 4;
export const R_CHUNKS = 16;
export const VE_CHUNKS = V_CHUNKS + R_CHUNKS;
export const RHO_LIMBS = 3;
export const BP_N = 16;
export const BP_M = 32;

/** FS-1 send weight 25 + 25n wu, n ≤ 8; reserve of 16 two-input sends. Mirrors block_budget.js. */
export const SEND_W_BASE = 25;
export const SEND_W_PER_INPUT = 25;
export const SEND_INPUT_MAX = 8;
export const SEND_R_WEIGHT = 2_336;

/**
 * cb-v3 verify weight (1 wu ≈ 1 ms of JS verify on the build box): a fixed
 * term, each non-0x23 row, and each share. CB_SHARE_MAX is what a full payout
 * leaves: 171 pot + fee + reserve-fee rows is 300 + 173·60 = 10,680 wu, and
 * (36,000 − 10,680 − 2,336 − 528) / 3 = 7,485. block_budget.js asserts it.
 */
export const CB_FIXED_W = 300;
export const CB_ROW_W = 60;
export const CB_SHARE_W = 3;
export const CB_EXTRA_ROWS = 2;
export const CB_SHARE_MAX = 7_485;

/** Legacy coinbases stay valid until the genesis hash is pinned; then cb-v3 is the only form. */
export const T21_REQUIRE_ALL_COINBASES = false;

export const DOM_CB = 'dom_cb-v1';
export const SHARE_BIND_DOM = 'shear-share-bind-v1';
export const VAULT_R_DOM = 'shear-kt10-0x23-r-v1';
export const VCH_B_DOM = 'shear-vch-b-v1';
export const VCH_Y_DOM = 'shear-vch-y-v1';
export const VCH_LAM_DOM = 'shear-vch-lam-v2';
export const VCH_PROBE_DOM = 'shear-vch-probe-v1';
export const LOGUP_DOM = 'shear-logup-x-v1';
export const AMT_CT_DOM = 'shear-amt-v1';

export const PAYOUT_KINDS = new Set(['pot', 'hash', 'dummy', 'escrow', 'settle', 'pool-fee']);
export const RESERVE_PUBLIC_KINDS = new Set(['lock', 'vote', 'withdraw', 'vault-withdraw-pinned']);

export const AMOUNT_KEYS = Object.freeze(['nanos', 'amount', 'v', 'value']);

/**
 * Fingerprint tokens, built from the constants above. Each names what the
 * code implements. RANGE (the send range proof) is not repeated here; the
 * coinbase range proof is CB_RANGE.
 */
export const T21_FINGERPRINT_TOKENS = Object.freeze([
  `T21=${T21_VERSION}`,
  `CB_FORM=${CB_FORM}`,
  `CB_ONLY=${CB_FORM}-at-genesis-pin`,
  `CB_WRAP=ve-elgamal-${CHUNK_BITS}x${VE_CHUNKS}+agg-schnorr+${AMT_CT_DOM}`,
  `CB_RANGE=bp-agg-${BP_N}x${BP_M}+0x${RANGE_TAG.toString(16).padStart(2, '0')}`,
  `VOUCHER_LABEL=${VCH_LAM_DOM}+B+Y`,
  `SPLIT_TALLY=logup-inv-schnorr+${LOGUP_DOM}`,
  `SPLIT_LAW=floor-schnorr+rho-${RHO_LIMBS}x${CHUNK_BITS}-two-sided`,
  `SHARE_BIND=${SHARE_BIND_DOM}`,
  `T21_HASH=retained-units,W<=2^${HASH_CAP_BITS},uW<=Bh`,
  `K_MIN=${K_MIN}`,
  `FEE=f1-bps-${FEE_BPS_MAX}`,
  `PAYOUT_KEY=${DOM_CB}`,
  `AMT_CT=${AMT_CT_DOM}`,
  `VAULT_R=${VAULT_R_DOM}+parent`,
  `CB_WEIGHT=${CB_FIXED_W}+${CB_ROW_W}r+${CB_SHARE_W}s,s<=${CB_SHARE_MAX}`,
  `SEND_WEIGHT=${SEND_W_BASE}+${SEND_W_PER_INPUT}n,n<=${SEND_INPUT_MAX},R${SEND_R_WEIGHT}`,
  `GEN_H=${GEN_H}`,
]);
