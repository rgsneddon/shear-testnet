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
import { HISTORICAL_TIP } from './historical_prefix.js';

export const TARGET_BLOCK_INTERVAL_MS = 90_000;
export const MIN_BITS = 1;
/**
 * SHA-256 width. A 32-bit farm lid froze live difficulty under large
 * CPU farms. GPU/ASIC stay refused at the share gate; this only lets
 * ASERT use the whole hash.
 */
export const MAX_BITS = 256;
/**
 * Testnet floor. Share vardiff opens at 8 and must sit under header bits.
 * Genesis work is a day-0 seed only (see GENESIS_BITS). It is not a
 * lasting equilibrium and it is not recomputed from a hashrate forecast.
 */
export const LIVE_MIN_BITS = 4;
/**
 * Day-0 seed for an empty cut (Q16.16 packed via GENESIS_BITS_PACKED).
 * Fingerprint includes GENESIS_BITS. After genesis, tempo is the sealed-gap
 * step only. This seed is not a forecast and not a fixed point of the book.
 * v10's closed soak seeded 15. v11 seeds 17, two bits harder. Russell locked
 * 17 (more prudent than 16). v12 keeps that seed. Live tip bits are not this open.
 */
export const GENESIS_BITS = 17;
/**
 * v12 does not use a per-block ± lid. Mainnet constants stay for that
 * book's fingerprint until mainnet is cut. Testnet ease is the emergency
 * window below, not a sticky step lid.
 */
export const ASERT_HARDEN_MAX_MAINNET = 6;
export const ASERT_HARDEN_MAX_TESTNET = 0;
/** Live book default (testnet). Mainnet fingerprint still pins HARDEN=6. */
export const ASERT_HARDEN_MAX = ASERT_HARDEN_MAX_TESTNET;
export const ASERT_EASE_MAX_MAINNET = 1;
export const ASERT_EASE_MAX_TESTNET = 0;
/** Live book default (testnet). Mainnet fingerprint still pins EASE=1. */
export const ASERT_EASE_MAX = ASERT_EASE_MAX_TESTNET;
/** Own-timestamp emergency ease. Cap 2 bits. Gap must exceed 8·T. */
export const ASERT_EMERGENCY_EASE_MAX = 2;
export const ASERT_EMERGENCY_GAP_FACTOR = 8;
/**
 * Header `bits` is Q16.16 packed work (integer LZ + 16-bit fraction).
 * Integer rungs could not represent the 1.09× target that 90 s needs
 * when hashrate sits between powers of two. Share vardiff stays integer LZ.
 *
 * v12 difficulty is genesis-anchored aserti3-2d. The median-11 step and
 * the ±1 lid are not this book. τ = 2 h. Move to 4 h only if a soak shows
 * bits chatter. That change is a new book, not a mid-chain edit.
 */
export const BITS_FP_SCALE = 65536;
export const ASERT_CURVE_WINDOW = 11;
export const ASERT_FAST_GAPS = 8;
export const ASERT_FAST_GAP_MS = 2_000;
export const ASERT_STEP_ID = 'aserti3-2d';
/**
 * Damping time. v12 chooses τ = 2 h = 7_200_000 ms (80·T).
 * v11's closed book used 16·T (1_440_000 ms). v10 used 32·T.
 * Pinned as ASERT_TAU_MS. The pool cannot edit τ mid-chain.
 */
export const ASERT_TAU_MS = 2 * 60 * 60 * 1000;
export const ASERT_TAU_BLOCKS = ASERT_TAU_MS / TARGET_BLOCK_INTERVAL_MS;
export const ASERT_HALFLIFE_MS = ASERT_TAU_MS;
/** Unpacked work stays inside [LIVE_MIN_BITS, MAX_BITS]. */
export const ASERT_FLOOR_ID = 'clamp-live-min-max';
/**
 * A header may sit this far ahead of the verifier clock. Further ahead is
 * rejected, so a finder cannot publish a 2 s solve stamped as a 90 s gap.
 * Honest clocks within this skew still agree. The excess telescopes: over a
 * prune window the summed lie is at most this many milliseconds.
 */
export const HEADER_AHEAD_MS = 15_000;
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
/** This public pool's construction rate (1%). Not a consensus requirement. */
export const POOL_FEE_BPS = 100;
/** Consensus cap: 0–2% of this block's subsidy. Carry is not fee'd. Hash bonus is never fee'd. */
export const POOL_FEE_MAX_BPS = 200;
/** A digest that meets this floor is worth 2^SHARE_FLOOR_BITS units. */
export const SHARE_FLOOR_BITS = 8;
/**
 * Included floor shares per block on shear-testnet-v11.
 * The closed v10 book capped this at 8192. The 32768 rung is cancelled.
 * This book cuts straight to 65536. Do not load this tree onto a v10 datadir.
 * HASH_BONUS_NANOS stays 1. This is headroom, not a bonus-unit retune.
 */
export const MAX_SHARES_PER_BLOCK = 65536;
/**
 * Work-unit cap. 2^28 covers a 500 kH/s launch surge at T = 90s (about 4.5e7
 * hashes) with headroom. 2^26 is the floor of that headroom. Do not restore
 * 65536 * 2^SHARE_FLOOR_BITS (2^24): that bound sits inside the launch band
 * once units are 2^bits. The share count above stays the body DoS bound.
 */
export const MAX_HASH_UNITS_PER_BLOCK = 2 ** 28;
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
/** Previous DINS book. Not this magic. */
export const MAGIC_TESTNET_V5 = 'shear-testnet-v5';
/** Previous empty-book soak (GENESIS_BITS=12, bang-bang log2 step). Not this magic. */
export const MAGIC_TESTNET_V6 = 'shear-testnet-v6';
/** Previous book. Not this magic. */
export const MAGIC_TESTNET_V7 = 'shear-testnet-v7';
/** Previous book. Not this magic. */
export const MAGIC_TESTNET_V8 = 'shear-testnet-v8';
/** Previous book (median11, harden 6, ease 2). Not this magic. Fail-closed. */
export const MAGIC_TESTNET_V9 = 'shear-testnet-v9';
/** Closed soak. τ = 32·T, GENESIS_BITS = 15. Do not retune that book. Not this magic. */
export const MAGIC_TESTNET_V10 = 'shear-testnet-v10';
/** Closed book. τ = 16·T, median-11, testnet lid ±1. v11 payloads do not load. */
export const MAGIC_TESTNET_V11 = 'shear-testnet-v11';
/** Live book. Fresh genesis. aserti3-2d, T = 90s, τ = 2h. v11 payloads do not load. */
export const MAGIC_TESTNET_V12 = 'shear-testnet-v12';
/** ADMITv2 privacy-class book. Empty cut. */
export const MAGIC_TESTNET = MAGIC_TESTNET_V12;
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
export const SHEARK_MINER_VERSION = '2.9';
/** Frozen consensus identity. A different fingerprint is a different law. */
export const BOOK_LAW_ID = 'shear-book-law-2';

/** Testnet ease matches the v10 lid (±1). Mainnet genesis still pins ease=1. */
export function asertEaseMax(magic = MAGIC_TESTNET) {
  return String(magic) === MAGIC_MAINNET ? ASERT_EASE_MAX_MAINNET : ASERT_EASE_MAX_TESTNET;
}
/** Mainnet harden stays 6. The live testnet book uses the ±1 lid. */
export function asertHardenMax(magic = MAGIC_TESTNET) {
  return String(magic) === MAGIC_MAINNET ? ASERT_HARDEN_MAX_MAINNET : ASERT_HARDEN_MAX_TESTNET;
}
/** Node and pool display version. Two-part only (`*.*`, never `0.1.0`). Not part of consensusFingerprint. Continuum wallet is kWalletVersion, not this number. Display pin is Shear Sentinel v19. */
export const PRODUCT_VERSION = '19.0';
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
 * Consensus floor: spendable after 9 confirmations (~13.5 min at 90s).
 * In the fingerprint. shear-testnet-v11 book.
 */
export const SPENDABLE_CONFIRMATIONS = 9;
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
    `MAX_HASH_UNITS=${MAX_HASH_UNITS_PER_BLOCK}`,
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
    'FORK=work-then-lowhash',
    `HASH_TX_LIVE=${HASH_TX_LIVE}`,
    'AMOUNT=confidential',
    'DUMMY_OUTS=1',
    'ENC_SHARE=v5+work7',
    'SHARE_UNITS=2^bits',
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
    'RANGE=packed-bit',
    'ADMIT_CYCLE=pallas-vesta-pasta',
    'ADMIT_ARITY=32',
    'ADMIT_K=1',
    'ADMIT_LEAF=shear-admit-leaf-v2',
    'DINS=pot+hash',
    'ROOTA=pot-spine+dag-fluxset',
    `POOL_FEE_MAX_BPS=${POOL_FEE_MAX_BPS}`,
    'BITS=q16.16',
    `ASERT_TAU_MS=${ASERT_HALFLIFE_MS}`,
    `ASERT_STEP=${ASERT_STEP_ID}`,
    `ASERT_HARDEN=${asertHardenMax(magic)}`,
    `ASERT_EASE=${asertEaseMax(magic)}`,
    `ASERT_EMERGENCY=${ASERT_EMERGENCY_EASE_MAX}`,
    `ASERT_EMERGENCY_GAP=${ASERT_EMERGENCY_GAP_FACTOR}`,
    `ASERT_FLOOR=${ASERT_FLOOR_ID}`,
    `HEADER_AHEAD_MS=${HEADER_AHEAD_MS}`,
    `MTP_FUTURE_MS=${MTP_FUTURE_MS}`,
    ...(String(magic) === MAGIC_MAINNET || String(magic) === MAGIC_TESTNET_V12 ? [] : [`HISTORICAL_TIP=${HISTORICAL_TIP}`]),
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

function divRoundNearest(numer, denom) {
  const neg = numer < 0n;
  const abs = neg ? -numer : numer;
  const q = (abs + denom / 2n) / denom;
  return neg ? -q : q;
}

/**
 * Genesis-anchored aserti3-2d.
 * next_bits = anchor_bits + ((h - h_anchor)·T - (t - t_anchor)) / τ
 * in Q16.16, rounded half away from zero.
 * Higher bits are harder. A late block is easier. The anchor is the
 * canonical genesis header, never the parent bits, so an emergency ease
 * on the parent does not stick.
 */
export function asertNextBits({
  anchorBits = GENESIS_BITS_PACKED,
  anchorTimeMs,
  anchorHeight = 1,
  blockTimeMs,
  blockHeight,
  parentTimeMs = null,
} = {}) {
  const anchorT = Math.floor(Number(anchorTimeMs));
  const blockT = Math.floor(Number(blockTimeMs));
  const height = Math.floor(Number(blockHeight));
  const anchorH = Math.floor(Number(anchorHeight));
  if (!Number.isFinite(anchorT) || !Number.isFinite(blockT) || !Number.isFinite(height) || !Number.isFinite(anchorH)) {
    return { ok: false, reason: 'asert_anchor' };
  }
  if (height <= anchorH) return { ok: false, reason: 'asert_anchor' };
  const heightDelta = BigInt(height - anchorH);
  const timeDelta = BigInt(blockT - anchorT);
  const numer = heightDelta * BigInt(TARGET_BLOCK_INTERVAL_MS) - timeDelta;
  const deltaQ = divRoundNearest(numer * BigInt(BITS_FP_SCALE), BigInt(ASERT_HALFLIFE_MS));
  const minQ = BigInt(Math.round(LIVE_MIN_BITS * BITS_FP_SCALE));
  const maxQ = BigInt(Math.round(MAX_BITS * BITS_FP_SCALE));
  let nextQ = BigInt(clampBits(anchorBits)) + deltaQ;
  if (nextQ < minQ) nextQ = minQ;
  if (nextQ > maxQ) nextQ = maxQ;
  const packed = Number(nextQ);
  let easeBits = 0;
  let eased = packed;
  if (parentTimeMs != null && Number.isFinite(Number(parentTimeMs))) {
    const gap = blockT - Math.floor(Number(parentTimeMs));
    const trigger = ASERT_EMERGENCY_GAP_FACTOR * TARGET_BLOCK_INTERVAL_MS;
    if (gap > trigger) {
      const raw = Math.log2(gap / trigger);
      easeBits = Math.min(ASERT_EMERGENCY_EASE_MAX, Math.max(0, raw));
      let easedQ = nextQ - BigInt(Math.round(easeBits * BITS_FP_SCALE));
      if (easedQ < minQ) easedQ = minQ;
      eased = Number(easedQ);
    }
  }
  return { ok: true, packed, eased, easeBits };
}

/** Exact ASERT, or [eased, packed] when own-timestamp emergency ease applies. */
export function bitsAcceptAsert(gotPacked, quote) {
  const got = Number(gotPacked);
  if (!quote?.ok || !Number.isFinite(got)) return false;
  if (quote.easeBits > 0) return got <= quote.packed && got >= quote.eased;
  return got === quote.packed;
}

/**
 * Median of the last ASERT_CURVE_WINDOW sealed gaps, padded with T.
 * Not the v12 difficulty step. Kept so MTP-style callers and old
 * diagnostics still have a median. Consensus bits use asertNextBits.
 */
export function medianIntervalMs(gaps) {
  const window = ASERT_CURVE_WINDOW;
  const raw = Array.isArray(gaps) ? gaps : [];
  const tail = raw.slice(-window);
  const samples = [];
  for (const g of tail) {
    const n = Number(g);
    samples.push(Number.isFinite(n) && n > 0 ? n : TARGET_BLOCK_INTERVAL_MS);
  }
  while (samples.length < window) samples.push(TARGET_BLOCK_INTERVAL_MS);
  const sorted = samples.slice().sort((a, b) => a - b);
  return sorted[(sorted.length - 1) >> 1];
}

/**
 * Retired single-gap step. v12 consensus does not call this.
 * Testnet harden and ease lids are 0, so the result does not move.
 * Verify, template, and retarget call asertNextBits.
 * A gap shorter than the stall cap cannot park on LIVE_MIN_BITS.
 */
export function nextBits(previousBits, intervalMs, magic = MAGIC_TESTNET) {
  const prev = unpackBits(clampBits(previousBits));
  let seen = Number(intervalMs);
  if (!Number.isFinite(seen) || seen <= 0) seen = TARGET_BLOCK_INTERVAL_MS;
  else if (seen < 1) seen = 1;
  const cap = ASERT_HALFLIFE_MS * 8;
  const stalled = seen >= cap;
  if (seen > cap) seen = cap;
  let delta = 0;
  if (seen !== TARGET_BLOCK_INTERVAL_MS) {
    const gain = TARGET_BLOCK_INTERVAL_MS / ASERT_HALFLIFE_MS;
    delta = Math.log2(TARGET_BLOCK_INTERVAL_MS / seen) * gain;
  }
  const harden = asertHardenMax(magic);
  if (delta > harden) delta = harden;
  const ease = asertEaseMax(magic);
  if (delta < -ease) delta = -ease;
  let next = prev + delta;
  if (!stalled && next <= LIVE_MIN_BITS) {
    next = LIVE_MIN_BITS + (1 / BITS_FP_SCALE);
  }
  return packBits(next);
}

/** Unpacked work bits in [LIVE_MIN_BITS, MAX_BITS] for HUD and clamps. */
export function displayBits(packed) {
  return unpackBits(clampBits(packed));
}

/**
 * @deprecated Single-gap helper. Not the verify or template want-bits path.
 * Those call nextBits(parentBits, medianIntervalMs(sealed gaps)).
 * A child stamp passed here does not set this block's consensus bits.
 */
export function bitsForBlock(parentBits, parentTimestamp, blockTimestamp, magic = MAGIC_TESTNET) {
  return nextBits(parentBits, Number(blockTimestamp) - Number(parentTimestamp), magic);
}

/**
 * Template time for the next header. Pool policy — not consensus.
 * Verifiers only see the sealed header timestamp.
 *
 * Never after wall (the old parent+90s template ran headers hours ahead).
 * Never before parent. Clock skew `wall < parent` stamps parent+1.
 * `wallIntervalMs` is accepted for callers and ignored: wall is the interval.
 */
export function templateStampMs(parentTimestamp, now = Date.now(), wallIntervalMs = null, mtpTimestamp = null) {
  void wallIntervalMs;
  const wall = Number(now);
  const parent = Number(parentTimestamp);
  if (!Number.isFinite(wall)) return Date.now();
  if (!Number.isFinite(parent)) return wall;
  // verifyBlock requires ts > parentTs. A 1ms gap is one fast parent step.
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
