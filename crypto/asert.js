export const TARGET_BLOCK_INTERVAL_MS = 90_000;
export const MIN_BITS = 1;
/**
 * SHA-256 width. A 32-bit farm lid froze live difficulty under large
 * CPU farms. GPU/ASIC stay refused at the share gate; this only lets
 * ASERT use the whole hash.
 */
export const MAX_BITS = 256;
export const LIVE_MIN_BITS = 14;
export const GENESIS_BITS = 21;
/** Protocol unit is 10⁻¹¹ SHE (11 decimals). Vote steps are integers of this unit. Public amounts show nine fractional digits. */
export const SHE_DECIMALS = 11;
export const SHE_PUBLIC_DIGITS = 9;
export const NANOS_PER_SHE = 100_000_000_000; // 10^11
/** 1 SHE pot (100_000_000_000 units). Hash bonus stays 1 unit. */
export const BLOCK_SUBSIDY_NANOS = 100_000_000_000;
/** 0.00000000001 SHE per valid hash = 1 protocol unit. */
export const HASH_BONUS_NANOS = 1;
/** Vote moves the per-hash bonus by one protocol unit (±10⁻¹¹ SHE). The pot does not move. */
export const HASH_BONUS_VOTE_DELTA_NANOS = 1;
export const POOL_FEE_BPS = 100;
export const MAGIC_TESTNET_V1 = 'shear-testnet-v1';
export const MAGIC_TESTNET_V2 = 'shear-testnet-v2';
/** Live testnet book for ShearHash-v2. v1 remains readable but is not mined. */
export const MAGIC_TESTNET = MAGIC_TESTNET_V2;
export const MAGIC_MAINNET = 'shear-v1';
export const HASH_FN = 'ShearHash-v2';
export const RX_SALT = 'ShearHash-v2/rx';
export const RX_ARGON_MEMORY = 131072;
export const RX_ARGON_ITERS = 3;
export const RX_CACHE_ACCESSES = 8;
export const RX_PROGRAM_SIZE = 256;
export const RX_PROGRAM_ITERATIONS = 2048;
export const RX_PROGRAM_COUNT = 8;
export const RX_SCRATCHPAD_L3 = 2097152;
export const RX_MODE = 'light';
export const RX_KEY = 'ShearHash-v2/key';
export const SHEARK_MINER_NAME = 'ShearK-Miner';
export const SHEARK_MINER_VERSION = '1.5';
/** Frozen consensus identity. A different fingerprint is a different law. */
export const BOOK_LAW_ID = 'shear-book-law-1';
/** Display/tag version for wallet, node, and pool. Two-part only (`*.*`, never `0.1.0`). Start 0.1; later 0.10+ legal. Never 1.* unless the operator says so. */
export const PRODUCT_VERSION = '0.3';
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
/** Third-party/merchant wait (~18 min). Not consensus. Not fingerprint. */
export const MIN_CONFIRMS_POLICY = 12;
export const RESERVE_FEE_FIRST = 1;

/** Consensus fingerprint. Mainnet genesis seals this; it is not revertible. */
export function consensusFingerprint() {
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
  ].join(':');
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
  };
}
/** Reserve may mint interest. Join may mint once at genesis into its vault. */
export const RESERVE_PROGRAM = 'shear-reserve-v1';
export const JOIN_PROGRAM = 'shear-join-v1';
export const JOIN_KIND_GENESIS = 'join-genesis';
export const JOIN_WINDOW_DAYS = 99;
export const JOIN_WINDOW_MS = JOIN_WINDOW_DAYS * 86_400_000;
/** Prior-ledger coin uses 11 decimals; Shear uses 11. 1 coin → 1 SHE. */
export const PRIOR_UNITS_PER_COIN = 100_000_000_000;
export const PRIOR_TO_SHEAR_UNITS = NANOS_PER_SHE / PRIOR_UNITS_PER_COIN;
export const PI_SHE_NANOS = 314159265358; // floor(π × 10^11) SHE in protocol units
export const RESERVE_EPOCH_DAYS = 400;
export const RESERVE_JOIN_CUTOFF_DAYS = 99;
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
  if (ticker === 'she' && id && id !== RESERVE_PROGRAM && id !== JOIN_PROGRAM) return true;
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
    if (kind && kind !== 'withdraw' && kind !== 'reserve') return false;
    return true;
  }
  // The Join extra-mints once: snapshot genesis into the vault. Claims are not mint.
  if (id === JOIN_PROGRAM && kind === JOIN_KIND_GENESIS && !opts.funded) {
    return true;
  }
  return false;
}

export function clampBits(bits) {
  const n = Math.floor(Number(bits) || 0);
  if (Number(bits) === Infinity) return MAX_BITS;
  if (!Number.isFinite(n) || n <= 0) return GENESIS_BITS;
  return Math.max(LIVE_MIN_BITS, Math.min(MAX_BITS, n));
}

/**
 * Per-block ASERT toward 90s. Pure function of the header timestamp
 * delta — verifiers must not use wall clock. Same-tick (≤0) is treated
 * as 1ms so it still climbs, but the step is capped at ±2 (not ±8).
 */
export function nextBits(previousBits, intervalMs) {
  const prev = clampBits(previousBits);
  let seen = Number(intervalMs);
  if (!Number.isFinite(seen) || seen < 1) seen = 1;
  const ratio = TARGET_BLOCK_INTERVAL_MS / seen;
  const delta = Math.round(Math.log2(Math.max(1 / 4, Math.min(4, ratio))));
  return clampBits(prev + delta);
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
export function templateStampMs(parentTimestamp, now = Date.now(), wallIntervalMs = null) {
  void wallIntervalMs;
  const wall = Number(now);
  const parent = Number(parentTimestamp);
  if (!Number.isFinite(wall)) return Date.now();
  if (!Number.isFinite(parent)) return wall;
  if (wall <= parent) return parent;
  return wall;
}

export function blockWork(bits) {
  const n = clampBits(bits);
  return 2 ** n;
}
