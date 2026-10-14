/**
 * T21 hidden-coinbase parameters. Fingerprint tokens live here.
 * consensusFingerprint() absorbs T21_FINGERPRINT_TOKENS in one freeze.
 * AMOUNT=confidential stays the token. The law sentence is AMOUNT_LAW.
 */
export const T21_VERSION = 'split-v1';
export const CB_FORM = 'cb-v3';
export const AMOUNT_LAW = 'hidden for every output except reserve-program rows';
export const GEN_H = 'feea2914bda937d74acc1efa93bf1094f65ae709628a7aad9d1b913b6c80c301';

export const T21_TOKEN = 'T21=split-v1';
export const CB_FORM_TOKEN = 'CB_FORM=cb-v3';
export const CB_WRAP_TOKEN = 'CB_WRAP=ve-tegamal16+amtct-v1';
export const SPLIT_TALLY_TOKEN = 'SPLIT_TALLY=logup-r1cs-v1';
export const SPLIT_LAW_TOKEN = 'SPLIT_LAW=prop-full-units+L1-L10';
export const SHARE_BIND_TOKEN = 'SHARE_BIND=shear-share-bind-v1';
export const K_MIN_TOKEN = 'K_MIN=4';
export const FEE_TOKEN = 'FEE=f1-bps-200';
export const PAYOUT_KEY_TOKEN = 'PAYOUT_KEY=dom_cb-v1';
export const AMT_CT_TOKEN = 'AMT_CT=shear-amt-v1';
export const RANGE_TOKEN = 'RANGE=packed-bit+0x02';
export const VAULT_R_TOKEN = 'VAULT_R=kt10-0x23-v1';
export const GEN_H_TOKEN = 'GEN_H=feea2914bda937d74acc1efa93bf1094f65ae709628a7aad9d1b913b6c80c301';

export const T21_FINGERPRINT_TOKENS = Object.freeze([
  T21_TOKEN,
  CB_FORM_TOKEN,
  CB_WRAP_TOKEN,
  SPLIT_TALLY_TOKEN,
  SPLIT_LAW_TOKEN,
  SHARE_BIND_TOKEN,
  K_MIN_TOKEN,
  FEE_TOKEN,
  PAYOUT_KEY_TOKEN,
  AMT_CT_TOKEN,
  RANGE_TOKEN,
  VAULT_R_TOKEN,
  GEN_H_TOKEN,
]);

export const K_MIN = 4;
export const FEE_BPS_MAX = 200;
export const VOUCHER_GAP = 256;
export const W_S_MAX = 1n << 28n;
export const N_MAX = 65536;
export const W_MAX = 1n << 48n;
export const SCALAR_MAX = 1n << 64n;
export const OUTPUT_MAX = 65536;
export const L_MAX = 470;
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

/** Legacy coinbases stay valid until the genesis cut. cb-v3 is enforced when present. */
export const T21_REQUIRE_ALL_COINBASES = false;

export const DOM_CB = 'dom_cb-v1';
export const SHARE_BIND_DOM = 'shear-share-bind-v1';
export const VAULT_R_DOM = 'shear-kt10-0x23-r-v1';
export const VCH_B_DOM = 'shear-vch-b-v1';
export const VCH_Y_DOM = 'shear-vch-y-v1';
export const VCH_LAM_DOM = 'shear-vch-lam-v1';
export const VCH_PROBE_DOM = 'shear-vch-probe-v1';
export const LOGUP_DOM = 'shear-logup-x-v1';
export const BATCH_DOM = 'shear-t21-batch-v1';

export const PAYOUT_KINDS = new Set(['pot', 'hash', 'dummy', 'escrow', 'settle', 'pool-fee']);
export const RESERVE_PUBLIC_KINDS = new Set(['lock', 'vote', 'withdraw', 'vault-withdraw-pinned']);

export const AMOUNT_KEYS = Object.freeze(['nanos', 'amount', 'v', 'value']);
