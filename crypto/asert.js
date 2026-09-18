export {
  EPOCH_DAYS_TESTNET,
  EPOCH_DAYS_MAINNET,
  POT_START_NANOS,
  POT_STEP_NANOS,
  POT_FLOOR_NANOS,
  POT_EPOCHS_TO_FLOOR,
  epochDays,
  epochMs,
  vortexEpochIndex,
  potSubsidyNanos,
  potSubsidyAt,
  nextPotNanos,
  potSchedPin,
  epochView,
  chainGenesisMs,
  joinCutoffDays,
  joinCutoffMs,
} from './pot_sched.js';
import { epochDays, potSchedPin, EPOCH_DAYS_TESTNET, EPOCH_DAYS_MAINNET, POT_FLOOR_NANOS } from './pot_sched.js';

export const TARGET_BLOCK_INTERVAL_MS = 90_000;
export const MIN_BITS = 1;
/**
 * SHA-256 width. A 32-bit farm lid froze live difficulty under large
 * CPU farms. GPU/ASIC stay refused at the share gate; this only lets
 * ASERT use the whole hash.
 */
export const MAX_BITS = 256;
/**
 * Testnet floor. RandomX-lite at ~50 H/s finds a block on the 90s scale
 * near 12 bits (2^12 / 50 ≈ 82s). 14 was minutes; 21 was hours.
 * Share vardiff opens at 8 and must be able to sit under header bits.
 */
export const LIVE_MIN_BITS = 4;
/** Empty-chain start. 256 is the digest ceiling, not a start. Fast blocks harden +2/block so a farm cannot spew. */
export const GENESIS_BITS = 12;
/**
 * Per-block ASERT caps on log2(target/seen). Harden is stricter than ease:
 * a farm must not spew; a quiet chain may go slow. Hashrate-agnostic — do
 * not pin these to a live pool.
 */
export const ASERT_HARDEN_MAX = 2;
export const ASERT_EASE_MAX = 1;
/**
 * Header `bits` is Q16.16 packed work (integer LZ + 16-bit fraction).
 * Integer rungs (16 vs 17) could not represent the 1.09× target that 90 s
 * needs when hashrate sits between powers of two; 82 s sat in the old
 * ±15 % dead band forever. 288-block half-life matches BCH aserti3 in
 * block-count terms at T=90 s. Share vardiff stays integer LZ.
 */
export const BITS_FP_SCALE = 65536;
export const ASERT_HALFLIFE_BLOCKS = 288;
export const ASERT_HALFLIFE_MS = ASERT_HALFLIFE_BLOCKS * TARGET_BLOCK_INTERVAL_MS;
export const GENESIS_BITS_PACKED = (GENESIS_BITS * BITS_FP_SCALE) >>> 0;
/** Protocol unit is 10⁻¹¹ SHE (11 decimals). Vote steps are integers of this unit. Public amounts show eight fractional digits. */
export const SHE_DECIMALS = 11;
export const SHE_PUBLIC_DIGITS = 8;
export const NANOS_PER_SHE = 100_000_000_000; // 10^11
/** Epoch-0 / genesis pot (1.00 SHE). Live coinbase uses potSubsidyNanos(epoch). */
export const BLOCK_SUBSIDY_NANOS = 100_000_000_000;
/** 0.00000000001 SHE per valid hash = 1 protocol unit. */
export const HASH_BONUS_NANOS = 1;
/** Vote moves the per-hash bonus by one protocol unit (±10⁻¹¹ SHE). The pot does not move. */
export const HASH_BONUS_VOTE_DELTA_NANOS = 1;
/**
 * Per-hash unit is never 0. Fingerprint pin HASH_UNIT_FLOOR=1.
 * Votes, vault load, coinbase, and verify all clamp through hashBonusUnitNanos.
 */
export const HASH_BONUS_NANOS_FLOOR = 1;

/** Consensus clamp: the live hash-bonus unit is always ≥ HASH_BONUS_NANOS_FLOOR. Never 0. */
export function hashBonusUnitNanos(n) {
  const v = typeof n === 'bigint' ? Number(n) : Math.floor(Number(n));
  if (!Number.isFinite(v) || v < HASH_BONUS_NANOS_FLOOR) return HASH_BONUS_NANOS_FLOOR;
  return v;
}
export const POOL_FEE_BPS = 100;
/** A digest that meets this floor is worth 2^SHARE_FLOOR_BITS units. */
export const SHARE_FLOOR_BITS = 8;
export const MAX_SHARES_PER_BLOCK = 8192;
export const MAX_HASH_UNITS_PER_BLOCK = MAX_SHARES_PER_BLOCK * (2 ** SHARE_FLOOR_BITS);
/** Median of last 11 header timestamps. Future skew 2 h (Bitcoin-class).
 *  15 min left only ~3 s of legal header time when the tip sat near the
 *  cap; ASERT then saw a 3 s interval and hardened +2 every round. */
export const MTP_WINDOW = 11;
export const MTP_FUTURE_MS = 2 * 60 * 60_000;
export const SPEND_SIG_DOMAIN = 'shear-spend-v1';
export const SPEND_SIG = 'ed25519-shear-spend-v1';
export const INTEREST_LAW = 'epoch-bps-floor';
export const ORACLE_LAW = 'basket-mean-14';
export const POT_PROP = 'shareBatch';
export const POOL_WITHDRAW_LAW = 'eip712-spend-bound';
export const MAGIC_TESTNET_V1 = 'shear-testnet-v1';
export const MAGIC_TESTNET_V2 = 'shear-testnet-v2';
export const MAGIC_TESTNET_V3 = 'shear-testnet-v3';
export const MAGIC_TESTNET_V4 = 'shear-testnet-v4';
/** ADMITv2 privacy-class book. v3 is frozen off this tree. */
export const MAGIC_TESTNET = MAGIC_TESTNET_V4;
export const MAGIC_MAINNET = 'shear-v1';
/** Mainnet genesis. BST on 18 Sep 2026. Do not invent a different datetime. */
export const GENESIS_MAINNET = '2026-09-18T21:00:00+01:00';
export const GENESIS_MAINNET_MS = Date.parse(GENESIS_MAINNET);
export const HASH_FN = 'ShearHash-v3';
export const RX_SALT = 'ShearHash-v3/rx';
export const RX_ARGON_MEMORY = 131072;
export const RX_ARGON_ITERS = 3;
export const RX_CACHE_ACCESSES = 8;
export const RX_PROGRAM_SIZE = 256;
export const RX_PROGRAM_ITERATIONS = 2048;
export const RX_PROGRAM_COUNT = 8;
export const RX_SCRATCHPAD_L3 = 2097152;
export const RX_MODE = 'light';
export const RX_KEY = 'ShearHash-v3/key';
export const SHEARK_MINER_NAME = 'ShearK-Miner';
export const SHEARK_MINER_VERSION = '2.4';
/** Frozen consensus identity. A different fingerprint is a different law. */
export const BOOK_LAW_ID = 'shear-book-law-2';
/** Display/tag version for wallet, node, and pool. Two-part only (`*.*`, never `0.1.0`). Start 0.1; later 0.10+ legal. Never 1.* unless the operator says so. */
export const PRODUCT_VERSION = '0.4';
/** Official C miner display/tag version. Two-part only (`*.*`). Operator set Shear-Miner to 1.1 (fee-free). 1.0 keeps the built-in fee. */
export const MINER_VERSION = '1.1';
/** Hash bonus commits on accept. Not env. */
export const HASH_COMMIT_ON_ACCEPT = 1;
/** One open-window hash row per miner (collate). Not env. */
export const HASH_TX_COLLATE = 1;
/** Hash txs confirm only when a block forms. Not env. */
export const HASH_TX_CONFIRM_ON_BLOCK = 1;
/** User sends confirm on the same miner-work block. Not env. */
export const USER_TX_CONFIRM_ON_BLOCK = 1;
/** Only proven miner work mints. HTTP never mints. Not env. */
export const MINER_MINT_ONLY = 1;
/**
 * Hash-tx architecture is live consensus law: 1 hash = 1 bonus unit,
 * collate O(miners), confirm on block-found. Not env. Not a switch.
 * Mainnet genesis (`shear-v1`) includes this pin in [consensusFingerprint];
 * flipping it is a different book, not a config change.
 */
export const HASH_TX_LIVE = 1;
export const DEST_HRP = 'ssa';
export const FEE_TAU_MS = 90_000;
export const FEE_TARGET_WEIGHT = 8;
export const FEE_SPLIT_FINDER_BPS = 5000;
export const FEE_SPLIT_RESERVE_BPS = 5000;
export const LEAF_A_LAYOUT = 'dest20+u64count';
export const LEAF_B_LAYOUT = 'dest20+u64unit+u64nonce+h32memo+tag8';
/**
 * Consensus floor: spendable after 6 confirmations (~9 min). In the fingerprint.
 * Operator lock 2026-08-28: SIX is the law. Do not change this; flag the operator.
 */
export const SPENDABLE_CONFIRMATIONS = 6;
/** Sample bodies may drop after this many confirmations. Money vouts stay. */
export const SAMPLE_PRUNE_CONFIRMATIONS = 1000;
const SAMPLE_PRUNE_PIN = SAMPLE_PRUNE_CONFIRMATIONS;
/** Third-party/merchant wait (~18 min). Not consensus. Not fingerprint. */
export const MIN_CONFIRMS_POLICY = 12;
export const RESERVE_FEE_FIRST = 1;

/** Consensus fingerprint. Mainnet genesis seals this; it is not revertible. */
export function consensusFingerprint(magic = MAGIC_TESTNET) {
  const days = epochDays(magic);
  const network = String(magic) === MAGIC_MAINNET ? MAGIC_MAINNET : MAGIC_TESTNET;
  return [
    BOOK_LAW_ID,
    MAGIC_MAINNET,
    TARGET_BLOCK_INTERVAL_MS,
    LIVE_MIN_BITS,
    GENESIS_BITS,
    HASH_BONUS_NANOS,
    NANOS_PER_SHE,
    BLOCK_SUBSIDY_NANOS,
    HASH_COMMIT_ON_ACCEPT,
    HASH_TX_COLLATE,
    HASH_TX_CONFIRM_ON_BLOCK,
    USER_TX_CONFIRM_ON_BLOCK,
    MINER_MINT_ONLY,
    HASH_TX_LIVE,
    DEST_HRP,
    FEE_TAU_MS,
    FEE_TARGET_WEIGHT,
    FEE_SPLIT_FINDER_BPS,
    LEAF_A_LAYOUT,
    LEAF_B_LAYOUT,
    SPENDABLE_CONFIRMATIONS,
    RESERVE_FEE_FIRST,
    SAMPLE_PRUNE_PIN,
    SHARE_FLOOR_BITS,
    MAX_SHARES_PER_BLOCK,
    HASH_BONUS_NANOS_FLOOR,
    SHE_PUBLIC_DIGITS,
    `HASH_FN=${HASH_FN}`,
    `RX_SALT=${RX_SALT}`,
    `RX_ARGON_MEMORY=${RX_ARGON_MEMORY}`,
    `RX_ARGON_ITERS=${RX_ARGON_ITERS}`,
    `RX_CACHE_ACCESSES=${RX_CACHE_ACCESSES}`,
    `RX_PROGRAM_SIZE=${RX_PROGRAM_SIZE}`,
    `RX_PROGRAM_ITERATIONS=${RX_PROGRAM_ITERATIONS}`,
    `RX_PROGRAM_COUNT=${RX_PROGRAM_COUNT}`,
    `RX_SCRATCHPAD_L3=${RX_SCRATCHPAD_L3}`,
    `RX_MODE=${RX_MODE}`,
    `RX_KEY=${RX_KEY}`,
    `SHARE_FLOOR_BITS=${SHARE_FLOOR_BITS}`,
    `MAX_SHARES_PER_BLOCK=${MAX_SHARES_PER_BLOCK}`,
    `SPEND_SIG=${SPEND_SIG}`,
    `DEST_HRP_SSA_ONLY=1`,
    `SPEND_SIG_ONLY=1`,
    `MEMO_NOT_DEST_KEYED=1`,
    `INTEREST=${INTEREST_LAW}`,
    `ORACLE=${ORACLE_LAW}`,
    `HASH_UNIT_FLOOR=${HASH_BONUS_NANOS_FLOOR}`,
    `POT_PROP=${POT_PROP}`,
    `POT_SCHED=${potSchedPin(days)}`,
    `EPOCH_DAYS=${days}`,
    `RESERVE_ORACLE=shear-reserve-oracle-v1:maxBps=10000:maxStep=100:maxAgeMs=${ORACLE_MAX_AGE_MS}:quorum=14`,
    `POOL_WITHDRAW=${POOL_WITHDRAW_LAW}`,
    `NETWORK=${network}`,
    `HASH_TX_LIVE=${HASH_TX_LIVE}`,
    'AMOUNT=confidential',
    'DUMMY_OUTS=1',
    'ENC_SHARE=v5',
    'SHARE_BIND=rx+noteCommit',
    'DANDELIONPP=1',
    'VIEW_TAG=1',
    'KDF=argon2id-shewall',
    `RESERVE=${RESERVE_PROGRAM}`,
    'RESERVE_EVM=1',
    `RESERVE_INTEREST=${days}d-bps-floor`,
    'VORTEX=vort1-pin',
    'VORTICE_NO_MINT=1',
    'LEVY_CAP=0.001-SHE',
    'LEVY_SPLIT=50-50-finder-reserve',
    'LEVY=weight',
    'ADMIT=ADMITv2',
    'RANGE=bpplus',
    'ADMIT_CYCLE=pallas-vesta-pasta',
    'ADMIT_ARITY=32',
    'ADMIT_K=1',
    'ADMIT_LEAF=shear-admit-leaf-v2',
    'LAG1_SHAREBATCH=1',
    `POOL_FEE_BPS=${POOL_FEE_BPS}`,
    'BITS=q16.16',
    `ASERT_TAU_MS=${ASERT_HALFLIFE_MS}`,
    'ASERT_STEP=log2',
    `ASERT_HARDEN=${ASERT_HARDEN_MAX}`,
    `ASERT_EASE=${ASERT_EASE_MAX}`,
    `MTP_FUTURE_MS=${MTP_FUTURE_MS}`,
  ].join(':');
}

/** Mainnet book: same privacy-class law, NETWORK=shear-v1 + frozen genesis. */
export function mainnetFingerprint() {
  return `${consensusFingerprint(MAGIC_MAINNET)}:GENESIS=${GENESIS_MAINNET}`;
}

/** Second key. SHEAR_MAINNET_EMIT=1 alone is not enough. */
export const MAINNET_EMIT_CONFIRM = 'I_UNDERSTAND_SHEAR_MAINNET';

export function mainnetEmitConfirmed() {
  return String(process.env.SHEAR_MAINNET_EMIT_CONFIRM || '').trim() === MAINNET_EMIT_CONFIRM;
}

export function mainnetMayEmit(nowMs = Date.now()) {
  if (String(process.env.SHEAR_MAINNET_EMIT || '').trim() !== '1') return false;
  if (!mainnetEmitConfirmed()) return false;
  return Number(nowMs) >= GENESIS_MAINNET_MS;
}

export function consensusLaw() {
  return {
    bookLawId: BOOK_LAW_ID,
    productVersion: PRODUCT_VERSION,
    minerVersion: MINER_VERSION,
    bookLawFingerprint: consensusFingerprint(),
    hashCommitOnAccept: HASH_COMMIT_ON_ACCEPT,
    hashTxCollate: HASH_TX_COLLATE,
    hashTxConfirmOnBlock: HASH_TX_CONFIRM_ON_BLOCK,
    userTxConfirmOnBlock: USER_TX_CONFIRM_ON_BLOCK,
    minerMintOnly: MINER_MINT_ONLY,
    hashTxLive: HASH_TX_LIVE,
    hashBonusNanos: HASH_BONUS_NANOS,
    blockSubsidyNanos: BLOCK_SUBSIDY_NANOS,
    potStartNanos: BLOCK_SUBSIDY_NANOS,
    potFloorNanos: POT_FLOOR_NANOS,
    epochDaysTestnet: EPOCH_DAYS_TESTNET,
    epochDaysMainnet: EPOCH_DAYS_MAINNET,
    magicMainnet: MAGIC_MAINNET,
    destHrp: DEST_HRP,
    feeTauMs: FEE_TAU_MS,
    feeTargetWeight: FEE_TARGET_WEIGHT,
    feeSplitFinderBps: FEE_SPLIT_FINDER_BPS,
    leafALayout: LEAF_A_LAYOUT,
    leafBLayout: LEAF_B_LAYOUT,
    spendableConfirmations: SPENDABLE_CONFIRMATIONS,
    minConfirmsPolicy: MIN_CONFIRMS_POLICY,
    reserveFeeFirst: RESERVE_FEE_FIRST,
    hashFn: HASH_FN,
    rxMode: RX_MODE,
    rxSalt: RX_SALT,
    shearkMinerName: SHEARK_MINER_NAME,
    shearkMinerVersion: SHEARK_MINER_VERSION,
    magicTestnet: MAGIC_TESTNET,
    magicTestnetV1: MAGIC_TESTNET_V1,
    genesisMainnet: GENESIS_MAINNET,
    mainnetFingerprint: mainnetFingerprint(),
  };
}
/** Reserve may mint interest. Extra mint is Reserve-only. */
export const RESERVE_PROGRAM = 'shear-reserve-v1';
/** Dead program id. extraMintAllowed is always false. */
export const JOIN_PROGRAM = 'shear-join-v1';
export const JOIN_KIND_GENESIS = 'join-genesis';
export const JOIN_WINDOW_DAYS = 0;
export const JOIN_WINDOW_MS = 0;
/** Protocol units per coin (11 decimals). */
export const PRIOR_UNITS_PER_COIN = 100_000_000_000;
export const PRIOR_TO_SHEAR_UNITS = NANOS_PER_SHE / PRIOR_UNITS_PER_COIN;
export const PI_SHE_NANOS = 314159265358; // floor(π × 10^11) SHE in protocol units
/** Default book is testnet (4-day epochs). Mainnet fingerprint uses 400. */
export const RESERVE_EPOCH_DAYS = EPOCH_DAYS_TESTNET;
export const RESERVE_JOIN_CUTOFF_DAYS = 1;
export const INTEREST_DENOM_DAYS = EPOCH_DAYS_MAINNET;
export const GENESIS_BPS = 264;
export const EPOCH_BPS_MAX_STEP = 100;
export const ORACLE_MAX_AGE_MS = 14 * 86_400_000;
export const RESERVE_EPOCH_MS = RESERVE_EPOCH_DAYS * 86_400_000;
export const RESERVE_JOIN_CUTOFF_MS = RESERVE_JOIN_CUTOFF_DAYS * 86_400_000;
export const HASH_BONUS_VOTE_DELTA = HASH_BONUS_VOTE_DELTA_NANOS / NANOS_PER_SHE;

/** Public amount frame: nine fractional digits. Sub-display dust stays on the sealed book. */
const PUBLIC_SCALE = 10 ** SHE_PUBLIC_DIGITS;
const PUBLIC_ZERO = `0.${'0'.repeat(SHE_PUBLIC_DIGITS)}`;

export function formatShe(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return PUBLIC_ZERO;
  const trunc = (v < 0 ? Math.ceil(v * PUBLIC_SCALE - 1e-9) : Math.floor(v * PUBLIC_SCALE + 1e-9)) / PUBLIC_SCALE;
  if (trunc === 0 && v !== 0) return (v < 0 ? '-' : '') + PUBLIC_ZERO;
  const s = trunc.toFixed(SHE_PUBLIC_DIGITS);
  if (new RegExp(`^-?\\d+\\.${'0'.repeat(SHE_PUBLIC_DIGITS)}$`).test(s)) return String(Math.trunc(trunc));
  return s;
}

/** Wrapped SHE / ticker SHE on a foreign programme never extra-mints. */
export function wrapMintForbidden(tx) {
  const kind = String(tx?.kind || '').toLowerCase();
  const id = String(tx?.programId || '').toLowerCase();
  const ticker = String(tx?.ticker || tx?.symbol || tx?.asset || '').toLowerCase();
  if (kind === 'wrap' || kind === 'wrapped' || kind === 'wshe' || kind === 'wrapped-she') return true;
  if (id.includes('wrap') || id.includes('wshe') || id.includes('wrapped-she')) return true;
  if (ticker === 'wshe' || ticker === 'wrapped-she' || ticker === 'wrapped she') return true;
  if (ticker === 'she' && id && id !== RESERVE_PROGRAM) return true;
  return false;
}

export function extraMintAllowed(programId, opts = {}) {
  const id = String(programId || '');
  const kind = String(opts.kind || '');
  // The Reserve is the only vortice that extra-mints ongoing SHE (oracle APR, per portal).
  if (id === RESERVE_PROGRAM) {
    if (opts.alreadyMinted || opts.preMint) return false;
    if (kind === 'lock' || kind === 'vote' || kind === 'claim') return false;
    if (opts.feeFirst) {
      if (opts.gateOk === false) return false;
      const gap = Math.max(0, Number(opts.reward || 0) - Number(opts.feeBank || 0));
      if (gap <= 0) return false;
      if (opts.amount != null && Number(opts.amount) > gap) return false;
      return true;
    }
    if (kind !== 'withdraw') return false;
    return true;
  }
  return false;
}

export function packBits(bitsFp) {
  const n = Number(bitsFp);
  if (!Number.isFinite(n)) return GENESIS_BITS_PACKED;
  const fp = Math.max(LIVE_MIN_BITS, Math.min(MAX_BITS, n));
  return Math.round(fp * BITS_FP_SCALE) >>> 0;
}

export function unpackBits(packed) {
  const n = Number(packed);
  if (!Number.isFinite(n) || n <= 0) return GENESIS_BITS;
  // Packed Q16.16 is always ≥ 2^16. Integer 4…256 is the live floor/ceiling.
  if (n <= MAX_BITS) return Math.max(LIVE_MIN_BITS, Math.min(MAX_BITS, n));
  if (n < BITS_FP_SCALE) return MAX_BITS;
  return Math.max(LIVE_MIN_BITS, Math.min(MAX_BITS, n / BITS_FP_SCALE));
}

export function isPackedBits(bits) {
  return Number(bits) >= BITS_FP_SCALE;
}

export function clampBits(bits) {
  const n = Number(bits);
  if (n === Infinity) return packBits(MAX_BITS);
  if (!Number.isFinite(n) || n <= 0) return GENESIS_BITS_PACKED;
  if (n <= MAX_BITS) return packBits(Math.max(LIVE_MIN_BITS, Math.min(MAX_BITS, n)));
  if (n < BITS_FP_SCALE) return packBits(MAX_BITS);
  return packBits(unpackBits(n));
}

/**
 * Per-block ASERT toward 90s on Q16.16 packed work.
 * Pure function of the header timestamp delta — verifiers must not use
 * wall clock. Same-tick (≤0) is treated as 1ms so it still climbs.
 * Step is log2(T / seen), harden-capped at +2, ease-capped at −1.
 * A 3s farm jumps +2 bits/block; a stall does not dump the floor.
 */
export function nextBits(previousBits, intervalMs) {
  const prev = unpackBits(clampBits(previousBits));
  let seen = Number(intervalMs);
  if (!Number.isFinite(seen) || seen < 1) seen = 1;
  const cap = ASERT_HALFLIFE_MS * 8;
  if (seen > cap) seen = cap;
  let delta = Math.log2(TARGET_BLOCK_INTERVAL_MS / seen);
  if (delta > ASERT_HARDEN_MAX) delta = ASERT_HARDEN_MAX;
  if (delta < -ASERT_EASE_MAX) delta = -ASERT_EASE_MAX;
  return packBits(prev + delta);
}

/** Unpacked work bits in [LIVE_MIN_BITS, MAX_BITS] for HUD and clamps. */
export function displayBits(packed) {
  return unpackBits(clampBits(packed));
}

/** Bits for this block from parent bits and the two header timestamps. */
export function bitsForBlock(parentBits, parentTimestamp, blockTimestamp) {
  return nextBits(parentBits, Number(blockTimestamp) - Number(parentTimestamp));
}

/**
 * Template time for the next header. Pool policy — not consensus.
 * Verifiers only see the sealed header timestamp.
 *
 * Never after wall (the old parent+90s template ran headers hours ahead).
 * Never before parent (≤0 interval is treated as 1 ms and climbs bits).
 * Clock skew `wall < parent` stamps parent, not wall.
 * Fast rounds may raise bits; they must not write a future stamp.
 * `wallIntervalMs` is accepted for callers and ignored: wall is the interval.
 */
export function templateStampMs(parentTimestamp, now = Date.now(), wallIntervalMs = null, mtpTimestamp = null) {
  void wallIntervalMs;
  const wall = Number(now);
  const parent = Number(parentTimestamp);
  if (!Number.isFinite(wall)) return Date.now();
  if (!Number.isFinite(parent)) return wall;
  // Strictly after parent when we can (verifyBlock requires ts > parentTs).
  // Clock skew `wall < parent` still stamps parent so bits do not see a
  // negative interval — callers without MTP keep the old contract.
  // verifyBlock requires ts > parentTs. Clock skew wall < parent still
  // needs a positive interval so ASERT does not treat it as 1 ms and harden.
  let stamp = wall <= parent ? parent + 1 : wall;
  if (mtpTimestamp != null && Number.isFinite(Number(mtpTimestamp))) {
    const cap = Number(mtpTimestamp) + MTP_FUTURE_MS;
    if (stamp > cap) stamp = cap;
    if (stamp <= parent && cap > parent) stamp = parent + 1;
  }
  return stamp;
}

export function blockWork(bits) {
  const fp = unpackBits(clampBits(bits));
  return 2 ** fp;
}

/** Consensus chain work. 2^{bits_fp} as bigint. */
export function blockWorkBig(bits) {
  const fp = unpackBits(clampBits(bits));
  const i = Math.floor(fp);
  const f = fp - i;
  const num = BigInt(Math.round((2 ** f) * 2 ** 48));
  return (1n << BigInt(i)) * num / (1n << 48n);
}

/** Median of timestamps (MTP window). */
export function medianTimePast(timestamps = []) {
  const ts = [...timestamps].map((t) => Number(t)).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!ts.length) return 0;
  return ts[Math.floor((ts.length - 1) / 2)];
}
