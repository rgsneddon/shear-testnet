// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * The Reserve — Shear's first Vortex program. Nodes execute this bytecode.
 *
 * Lock is legal while an epoch is open and the chain clock is pinned. An
 * unpinned clock rejects the lock. Vault epochs are chain vortex epochs.
 * Coin locked while at least the stake cutoff remains is an active
 * lock and can vote. Coin locked in the final stake window is idle for
 * that epoch: it misses only that epoch's reward, and its owner can still
 * vote. From the next epoch on, that coin counts toward π. π is judged
 * per epoch. An epoch counts every pre-cutoff credit, including a later
 * top-up, plus every post-cutoff credit that has entered a full epoch.
 * Below π that epoch pays 0, and a settle does not mark it paid.
 * Mainnet's window is the last 99 days. Testnet's window is the last
 * quarter of the epoch. A claim is signed by the portal owner over the
 * nullifier, the amount, the proof, and the payout. The lock dest is not
 * on the claim. The owner key is one-time for that lock. It is not the
 * wallet spend key.
 * A qualifying credit earns its epoch's rate times the time still left in
 * that chain epoch, by integer floor, then each later full epoch before
 * the open one. Coin added inside the window does not count toward π. A
 * completed gap is paid immediately, at that epoch's committed rate or
 * else the last paid rate, including a commit on a skipped epoch. It does
 * not wait for a later enact. Each deposit, the original lock and every
 * top-up, stays locked until its own epoch has ended. A later top-up does
 * not re-lock earlier principal. Each tranche keeps the pro-rata of its
 * own lock epoch. After that epoch ends, any later block can withdraw
 * that deposit. A deposit whose epoch is still open stays in the reserve.
 * The still-open epoch is not paid. A portal vote is retired. One anonymous
 * ballot per live π leaf steps the hash-bonus unit and the reserve rate.
 * There is no miner veto. At epoch end an empty portal plurality holds the
 * live hash bonus. It does not set the reserve rate. The freeze is the plain average of the attested 14-bank
 * policy tenths (FED 3875, BOE 3750, ECB 2575, BOJ 1250, BOC 2250, RBA 4600,
 * RBNZ 2750, SNB 0, RIKSBANK 1750, NORGES 4500, DNBANK 2100, BOK 3000,
 * BOI 3250, CNB 3750), observed 2026-10-15. Negatives keep their sign.
 * Sum 39400 tenths → 2814 → 281 bps, floored at 0.
 * It is written only when an epoch opens. There is no per-epoch step and
 * no aggregate cap. A caller cannot select the rate.
 * The 1 SHE pot never moves. At epoch end the block stores the reward root
 * the node already computed. This contract does not build that tree, and
 * it does not walk earners. A reward already archived in an earlier root
 * is not part of the next one. A user claims one leaf, once, and the proof
 * is checked against a stored root. A withdraw that pays the same reward
 * retires that leaf. Neither path touches the other's payment. Principal
 * stays in the vault until the user's own withdraw, and an epoch end does
 * not release it.
 * This contract refuses
 * well-known foreign chain ids. The Reserve oracle is the bundled quorum.
 * observeRate does not move the rate.
 *
 * Reserve reward: floor(active * epochBps / 10000). do not use 365.
 */
error NotShear();
error BelowPi();
error NotVoter();
error EpochNotEnded();
error EpochClosed();
error VoteLocked();
error BadDest();
error BadAmount();
error BadRate();
error AlreadyEnacted();
error NeedEnact();
error UnitFloor();
error RateBundled();
error NeedPayout();
error ClockUnpinned();
error AlreadyMinted();
error NotePrincipal();
error Unsigned();
error OwnerMissing();
error ClaimUnavailable();

contract Reserve {
    bytes32 public constant SHEAR_TESTNET = keccak256(bytes("shear-testnet-v2"));
    bytes32 public constant SHEAR_TESTNET_V3 = keccak256(bytes("shear-testnet-v3"));
    bytes32 public constant SHEAR_TESTNET_V4 = keccak256(bytes("shear-testnet-v4"));
    bytes32 public constant SHEAR_TESTNET_V5 = keccak256(bytes("shear-testnet-v5"));
    bytes32 public constant SHEAR_TESTNET_V1 = keccak256(bytes("shear-testnet-v1"));
    bytes32 public constant SHEAR_TESTNET_V6 = keccak256(bytes("shear-testnet-v6"));
    bytes32 public constant SHEAR_TESTNET_V7 = keccak256(bytes("shear-testnet-v7"));
    bytes32 public constant SHEAR_TESTNET_V8 = keccak256(bytes("shear-testnet-v8"));
    bytes32 public constant SHEAR_TESTNET_V9 = keccak256(bytes("shear-testnet-v9"));
    bytes32 public constant SHEAR_TESTNET_V10 = keccak256(bytes("shear-testnet-v10"));
    bytes32 public constant SHEAR_TESTNET_V11 = keccak256(bytes("shear-testnet-v11"));
    bytes32 public constant SHEAR_TESTNET_V12 = keccak256(bytes("shear-testnet-v12"));
    bytes32 public constant SHEAR_MAINNET = keccak256(bytes("shear-v1"));
    bytes32 public constant PROGRAM_ID = keccak256(bytes("shear-reserve-v1"));

    uint256 public constant PI_NANOS = 314_159_265_358;
    uint256 public constant EPOCH_DAYS_TESTNET = 4;
    uint256 public constant EPOCH_DAYS_MAINNET = 400;
    uint256 public constant EPOCH_DAYS = EPOCH_DAYS_MAINNET;
    uint256 public constant JOIN_CUTOFF_DAYS = 99;
    uint256 public constant STAKE_CUTOFF_QUARTER_DEN = 4;
    uint256 public constant DAY_MS = 86_400_000;
    uint256 public constant EPOCH_MS = 400 * 86_400_000;
    uint256 public constant CUTOFF_MS = 99 * 86_400_000;
    uint256 public constant GENESIS_BONUS = 1;
    // Attested 2026-10-15 basket. The single source is crypto/reserve_oracle.js GENESIS_BPS.
    uint256 public constant GENESIS_BPS = 281;
    uint256 public constant ORACLE_MAX_AGE_MS = 14 * 86_400_000;
    uint256 public constant REWARD_DENOM_DAYS = 400;

    enum Vote {
        None,
        IncreaseBonus,
        DecreaseBonus,
        LeaveBonusAsIs
    }

    struct Tranche {
        uint256 amount;
        uint256 epoch;
        uint256 remainMs;
        uint256 fullFrom;
        bool partialPaid;
        // Time-locked note. withdraw() does not pay this principal.
        bool notePrincipal;
        bytes32 commit;
    }

    struct Portal {
        uint256 active;
        uint256 idle;
        Vote vote;
        bool joined;
        uint256 voteEpoch;
        bool rewardTracked;
        uint256 rewardEpoch;
        uint256 accruedReward;
        Tranche[] tranches;
        /// 0: a tranche-less balance is locked in currentEpoch.
        /// Otherwise the lock epoch is legacyEpochPlus - 1, pinned before a roll.
        uint256 legacyEpochPlus;
        bool hiddenStake;
        /// Principal was released while a hidden reward was still due.
        bool hiddenRewardOpen;
    }

    bytes32 public immutable magic;
    uint256 public epochStart;
    uint256 public currentEpoch;
    bool public bonusEnacted;
    uint256 public liveHashBonusNanos;
    mapping(bytes32 => Portal) private portals;
    /// keccak portal id → sha256("shear-portal-v1" || dest), the JS portal id.
    mapping(bytes32 => bytes32) internal portalSha;
    bytes32[] internal portalKeys;
    mapping(bytes32 => bool) internal portalListed;
    /// Portal id → sha256("shear-reward-owner-v1" || ownerPub). Zero is missing.
    mapping(bytes32 => bytes32) internal ownerOf;
    /// Ed25519 verify precompile. Input is pubkey || sig || message. Output is uint256 1.
    address internal constant ED25519 = address(0x101);
    /// Settlement index → merkle root the node already computed.
    mapping(uint256 => bytes32) internal rewardRootOf;
    /// Earning epoch → vault-lock root. Same key the node stores.
    mapping(uint256 => bytes32) internal vaultRootOf;
    /// Root frozen when the earning epoch opened. A full claim proves against this.
    mapping(uint256 => bytes32) internal epochStartRootOf;
    /// Bit 255 set once the leaf count and open height are committed.
    mapping(uint256 => uint256) internal epochCensus;
    /// epoch → proposal → tag → seq | (choice << 8). Choice 1 up, 2 down, 3 hold.
    mapping(uint256 => mapping(bytes32 => mapping(bytes32 => uint256))) internal ballotOf;
    /// epoch → proposal → hold<<128 | down<<64 | up.
    mapping(uint256 => mapping(bytes32 => uint256)) internal ballotCount;
    /// 0 unknown, 1 down, 2 hold, 3 up.
    mapping(uint256 => mapping(bytes32 => uint256)) internal ballotStep;
    /// Vault proof precompile. Returns 1, 2, or 0.
    address internal constant VAULT_ZK = address(0x102);
    /// Settlement indexes that have a stored root, in commit order.
    uint256[] internal rewardEpochs;
    /// Greatest committed index, stored as index+1 so epoch 0 is representable.
    /// Commits are monotonic, so this and the previous one answer archive
    /// queries without scanning the list.
    uint256 internal rewardHi;
    /// Previous greatest, same +1 encoding. Zero means there is no earlier root.
    uint256 internal rewardHiPrev;
    mapping(bytes32 => bool) internal nullifierMinted;
    /// Open index through which this portal's reward was already credited.
    mapping(bytes32 => uint256) private creditedThrough;
    uint256 public totalLocked;
    uint256 public votesIncrease;
    uint256 public votesDecrease;
    uint256 public votesHold;
    uint256 public annualBps;
    uint256 public epochBps;
    uint256 public nextEpochBps;
    uint256 public oracleAsOfMs;
    uint256 public enactedUp;
    uint256 public enactedDown;
    uint256 public enactedHold;
    int256 public enactedDelta;
    uint256 public enactedLiveBonus;
    uint256 public enactedAtMs;
    uint256 public enactedAtEpoch;
    /// Leaf commits this withdraw retired. Cleared before the call returns.
    bytes32[] private retiredScratch;
    /// Retire DLEQs already accepted in this Shear block. Reset when the time changes.
    uint256 private retireDleqsUsed;
    uint256 private retireDleqsStamp;
    bool private retireBindSet;
    bytes32 private retireBindScratch;

    modifier onlyShear() {
        _assertShear();
        _;
    }

    constructor(bytes32 shearMagic) {
        magic = shearMagic;
        annualBps = GENESIS_BPS;
        epochBps = GENESIS_BPS;
        nextEpochBps = GENESIS_BPS;
        liveHashBonusNanos = GENESIS_BONUS;
        _assertShear();
    }

    function _assertShear() internal view {
        uint256 id;
        assembly {
            id := chainid()
        }
        if (id == 1 || id == 56 || id == 137 || id == 10 || id == 42161 || id == 43114 || id == 8453) {
            revert NotShear();
        }
        if (magic != SHEAR_TESTNET && magic != SHEAR_TESTNET_V3 && magic != SHEAR_TESTNET_V4 && magic != SHEAR_TESTNET_V5 && magic != SHEAR_TESTNET_V1 && magic != SHEAR_TESTNET_V6 && magic != SHEAR_TESTNET_V7 && magic != SHEAR_TESTNET_V8 && magic != SHEAR_TESTNET_V9 && magic != SHEAR_TESTNET_V10 && magic != SHEAR_TESTNET_V11 && magic != SHEAR_TESTNET_V12 && magic != SHEAR_MAINNET) revert NotShear();
    }

    function epochDaysOf() public view returns (uint256) {
        return magic == SHEAR_MAINNET ? EPOCH_DAYS_MAINNET : EPOCH_DAYS_TESTNET;
    }

    function epochLengthMs() public view returns (uint256) {
        return epochDaysOf() * DAY_MS;
    }

    /// Mainnet closes 99 days before the epoch ends. Testnet closes at the
    /// last quarter. A lock with less time left earns no stake reward.
    function cutoffLengthMs() public view returns (uint256) {
        if (magic == SHEAR_MAINNET) return JOIN_CUTOFF_DAYS * DAY_MS;
        return epochLengthMs() / STAKE_CUTOFF_QUARTER_DEN;
    }

    function remainingMs(uint256 nowTs) public view returns (uint256) {
        uint256 span = epochLengthMs();
        if (epochStart == 0 || bonusEnacted) return span;
        uint256 end = epochStart + span;
        if (nowTs >= end) return 0;
        return end - nowTs;
    }

    function remainingDays(uint256 nowTs) public view returns (uint256) {
        return remainingMs(nowTs) / DAY_MS;
    }

    function canJoin(uint256 nowTs) public view returns (bool) {
        if (clockGenesis != 0) {
            uint256 span = epochLengthMs();
            uint256 idx = _chainEpoch(nowTs);
            uint256 end = clockGenesis + (idx + 1) * span;
            uint256 left = nowTs >= end ? 0 : end - nowTs;
            return left >= cutoffLengthMs();
        }
        if (epochStart == 0 || bonusEnacted) return true;
        return remainingMs(nowTs) >= cutoffLengthMs();
    }

    function epochOpen(uint256 nowTs) public view returns (bool) {
        if (epochStart == 0 || bonusEnacted) return true;
        return remainingMs(nowTs) > 0;
    }

    function portalId(bytes calldata dest) public pure returns (bytes32) {
        return keccak256(abi.encodePacked("shear-portal-v1", dest));
    }

    function observeRate(uint256 bps, uint256 nowTs) external view onlyShear {
        bps;
        nowTs;
        revert RateBundled();
    }

    uint256 public rateCommitEpoch;
    uint256 internal genesisTs;
    uint256 internal clockGenesis;
    bool internal deferEpochRoll;
    /// Portal whose legacy principal a withdraw in this block still pays.
    mapping(bytes32 => bool) internal withdrawHold;
    mapping(bytes32 => bool) internal withdrawHoldSha;
    bytes32[] internal heldIds;
    bytes32[] internal heldShas;
    mapping(uint256 => uint256) public epochRateOf;
    mapping(uint256 => bool) internal epochRateKnown;
    /// sha256 portal id → epoch → roll consumed that epoch's tranche set.
    mapping(bytes32 => mapping(uint256 => bool)) internal rolledEpoch;
    /// sha256 portal id → epoch → principal left, so a roll cannot replay.
    mapping(bytes32 => mapping(uint256 => bool)) internal withdrewEpochOf;

    /// First non-zero chain genesis wins. Settlement and rate keys share it.
    /// A later call that names a different genesis reverts.
    function _pinClock(uint256 chainGenesis) internal {
        if (chainGenesis == 0) return;
        if (clockGenesis == 0) clockGenesis = chainGenesis;
        else if (clockGenesis != chainGenesis) revert BadRate();
    }

    function pinClock(uint256 chainGenesis) external onlyShear {
        _pinClock(chainGenesis);
    }

    /// Chain epoch index, the same integer as JS vortexEpochIndex: 0 at genesis.
    /// epochIdx must equal that derived index. A repeated index reverts.
    /// Epoch 0 is not rewritten to 1. currentEpoch is this same index.
    function commitRate(uint256 epochIdx, uint256 bps, uint256 nowTs, uint256 chainGenesis) external onlyShear {
        if (bps > 100_000 / 10) revert BadRate();
        _pinClock(chainGenesis);
        uint256 g = clockGenesis;
        uint256 derived = (g == 0 || nowTs <= g) ? 0 : (nowTs - g) / epochLengthMs();
        if (epochIdx != derived) revert BadRate();
        if (epochRateKnown[epochIdx]) revert BadRate();
        epochRateOf[epochIdx] = bps;
        epochRateKnown[epochIdx] = true;
        nextEpochBps = bps;
        rateCommitEpoch = epochIdx;
    }

    /// Chain-genesis vortex index. Unpinned, the index is 0. A first lock
    /// does not install a clock, and genesisTs is not a fallback.
    function _chainEpoch(uint256 nowTs) internal view returns (uint256) {
        uint256 g = clockGenesis;
        if (g == 0 || nowTs <= g) return 0;
        return (nowTs - g) / epochLengthMs();
    }

    /// A commit or a stamped gap wins. Otherwise the newest earlier rate,
    /// so a later epoch's rate cannot flow backward into a gap.
    function _rateFor(uint256 epochIdx) internal view returns (uint256) {
        if (epochRateKnown[epochIdx]) return epochRateOf[epochIdx];
        for (uint256 e = epochIdx; e > 0; e--) {
            if (epochRateKnown[e - 1]) return epochRateOf[e - 1];
        }
        return epochBps;
    }

    /// Epoch length in 90s blocks. rate_e is the total for this many blocks.
    function _epochBlocks() internal view returns (uint256) {
        return epochDaysOf() * 960;
    }

    /// Sixteen periods tile the epoch. On the 400-day epoch each is 25 days.
    uint256 internal constant PERIODS_PER_EPOCH = 16;

    /// floor(amount * rate_e * heldBlocks / (epochBlocks * 10000)).
    /// rate_e is the total for the whole epoch, not a daily rate.
    /// heldBlocks == epochBlocks is floor(amount * rate_e / 10000).
    function _partial(uint256 amount, uint256 bps, uint256 remain, uint256 span) internal pure returns (uint256) {
        if (amount == 0 || bps == 0 || remain == 0 || span == 0) return 0;
        return (amount * bps * remain) / (span * 10000);
    }

    /// Exclusive end of settlement. Completed epochs, including a gap, are
    /// due immediately. The open epoch is not included.
    function _payIndex(uint256 nowTs) internal view returns (uint256) {
        uint256 chain = _chainEpoch(nowTs);
        bool ended = epochStart != 0 && nowTs >= epochStart + epochLengthMs();
        if (chain == 0 && !ended) return 0;
        return chain;
    }

    /// Credits locked before the cutoff. The final window is not in this sum.
    function _preCutoffStake(Portal storage p, uint256 cut) internal view returns (uint256 sum) {
        uint256 n = p.tranches.length;
        for (uint256 i = 0; i < n; i++) {
            if (p.tranches[i].remainMs >= cut) sum += p.tranches[i].amount;
        }
    }

    /// Stake that counts toward π in `epoch`. Pre-cutoff credits count in
    /// every epoch, including a later top-up. A post-cutoff credit counts
    /// once the epoch is after the one it arrived in. Remain 0 is a legacy
    /// credit and does not count.
    function _qualifyingStake(Portal storage p, uint256 epoch, uint256 cut) internal view returns (uint256 sum) {
        uint256 n = p.tranches.length;
        for (uint256 i = 0; i < n; i++) {
            Tranche storage t = p.tranches[i];
            if (t.remainMs >= cut) sum += t.amount;
            else if (t.remainMs > 0 && epoch > t.epoch) sum += t.amount;
        }
    }

    /// Qualifying stake for epochs `0 .. epochs-1`, built once.
    /// Pre-cutoff amounts count in every epoch. A post-cutoff amount starts
    /// at the epoch after it arrived. Remain 0 does not count.
    function _stakeSeries(Portal storage p, uint256 epochs, uint256 cut)
        internal
        view
        returns (uint256[] memory at)
    {
        at = new uint256[](epochs);
        if (epochs == 0) return at;
        uint256 pre = 0;
        uint256[] memory delta = new uint256[](epochs);
        uint256 n = p.tranches.length;
        for (uint256 i = 0; i < n; i++) {
            Tranche storage t = p.tranches[i];
            if (t.remainMs >= cut) pre += t.amount;
            else if (t.remainMs > 0) {
                uint256 start = t.epoch + 1;
                if (start < epochs) delta[start] += t.amount;
            }
        }
        uint256 run = pre;
        for (uint256 e = 0; e < epochs; e++) {
            run += delta[e];
            at[e] = run;
        }
    }

    /// One forward pass of `_rateFor`. A gap keeps the newest earlier rate.
    function _rateSeries(uint256 epochs) internal view returns (uint256[] memory rates) {
        rates = new uint256[](epochs);
        uint256 carry = epochBps;
        bool have = false;
        for (uint256 e = 0; e < epochs; e++) {
            if (epochRateKnown[e]) {
                carry = epochRateOf[e];
                have = true;
                rates[e] = carry;
            } else if (have) {
                rates[e] = carry;
            } else {
                rates[e] = epochBps;
            }
        }
    }

    /// The arrival epoch pays the time still left when that epoch's stake
    /// is at least π. Later full epochs pay on their own qualification, so
    /// a post-cutoff π misses only its arrival epoch. An epoch still under
    /// π is not marked paid.
    function _settle(Portal storage p, uint256 nowTs) internal {
        uint256 nowIdx = _payIndex(nowTs);
        if (nowIdx == 0) return;
        uint256 span = epochLengthMs();
        uint256 cut = cutoffLengthMs();
        uint256[] memory stakeAt = _stakeSeries(p, nowIdx, cut);
        uint256[] memory rates = _rateSeries(nowIdx);
        uint256 accrued = p.accruedReward;
        uint256 n = p.tranches.length;
        for (uint256 i = 0; i < n; i++) {
            Tranche storage t = p.tranches[i];
            if (!t.partialPaid && nowIdx > t.epoch) {
                if (t.remainMs >= cut && stakeAt[t.epoch] >= PI_NANOS) {
                    accrued += _partial(t.amount, rates[t.epoch], t.remainMs, span);
                    t.partialPaid = true;
                } else if (t.remainMs < cut) {
                    t.partialPaid = true;
                }
            }
            if (nowIdx > t.fullFrom && t.remainMs > 0) {
                uint256 e = t.fullFrom;
                for (; e < nowIdx; e++) {
                    if (stakeAt[e] < PI_NANOS) break;
                    accrued += (t.amount * rates[e]) / 10000;
                }
                t.fullFrom = e;
            }
        }
        p.accruedReward = accrued;
    }

    function rewardNanos(uint256 active, uint256 bps) public pure returns (uint256) {
        return (active * bps) / 10000;
    }

    function _halfUpDiv(int256 num, int256 den) internal pure returns (int256) {
        if (den == 0) return 0;
        int256 sign = num < 0 ? int256(-1) : int256(1);
        uint256 an = uint256(num < 0 ? -num : num);
        uint256 ad = uint256(den < 0 ? -den : den);
        return sign * int256((an + ad / 2) / ad);
    }

    /// Plain average of every in-range tenth. Same integers as
    /// crypto/reserve_oracle.js trimmedMeanBps. ok is false under quorum.
    /// Negatives stay in the sum. The 0 floor applies to the result only.
    function trimmedMeanBps(int256[] memory tenths) public pure returns (bool ok, uint256 bps) {
        int256 sum = 0;
        uint256 n = 0;
        for (uint256 i = 0; i < tenths.length; i++) {
            int256 t = tenths[i];
            if (t < -1000 || t > 100000) continue;
            sum += t;
            n++;
        }
        if (n < 10) return (false, 0);
        int256 whole = _halfUpDiv(_halfUpDiv(sum, int256(uint256(n))), 10);
        if (whole < 0) return (true, 0);
        return (true, uint256(whole));
    }

    /// Plain average of all 14 attested tenths. Sum 39400 → 2814 tenths → 281 bps.
    function _bundledEpochBps() internal pure returns (uint256) {
        uint256 sum = 3875 + 3750 + 2575 + 1250 + 2250 + 4600 + 2750 + 0
            + 1750 + 4500 + 2100 + 3000 + 3250 + 3750;
        uint256 tenthsMean = (sum + 7) / 14;
        return (tenthsMean + 5) / 10;
    }

    /// A commit already stored for this epoch wins. The first open takes
    /// the bundle. Every later epoch with no commit keeps the running rate.
    function _applyEpochRate(uint256 nowTs, bool firstOpen) internal {
        uint256 idx = _chainEpoch(nowTs);
        if (!epochRateKnown[idx]) {
            uint256 proposal = firstOpen ? _bundledEpochBps() : epochBps;
            epochRateOf[idx] = proposal;
            epochRateKnown[idx] = true;
        }
        epochBps = epochRateOf[idx];
        annualBps = epochBps;
    }

    /// Start of a consensus block, before its rows. An enacted epoch rolls
    /// onto the chain index and adopts that epoch's rate.
    function syncEpoch(uint256 nowTs) external onlyShear {
        if (deferEpochRoll) return;
        if (bonusEnacted) _syncEpoch(nowTs);
    }

    /// Hold the roll for the rest of the block. A same-block lock must not
    /// close the epoch a withdraw in that block is settling.
    function holdEpochRoll(bool hold) external onlyShear {
        deferEpochRoll = hold;
    }

    function _syncEpoch(uint256 nowTs) internal {
        if (clockGenesis == 0) return;
        uint256 idx = _chainEpoch(nowTs);
        if (epochStart == 0) {
            currentEpoch = idx;
            epochStart = clockGenesis + idx * epochLengthMs();
            bonusEnacted = false;
            _applyEpochRate(nowTs, true);
            return;
        }
        if (idx == currentEpoch) return;
        if (!bonusEnacted) return;
        // Walk the skipped epochs in order. A commit is that epoch's rate
        // and becomes the last paid rate. A gap with no commit keeps it.
        // The epoch we open, if it has no commit, pays that same rate.
        uint256 carried = epochBps;
        for (uint256 e = currentEpoch + 1; e < idx; e++) {
            if (!epochRateKnown[e]) {
                epochRateOf[e] = carried;
                epochRateKnown[e] = true;
            } else {
                carried = epochRateOf[e];
            }
        }
        if (!epochRateKnown[idx]) epochBps = carried;
        votesIncrease = 0;
        votesDecrease = 0;
        votesHold = 0;
        uint256 leftEpoch = currentEpoch;
        currentEpoch = idx;
        epochStart = clockGenesis + idx * epochLengthMs();
        bonusEnacted = false;
        _applyEpochRate(nowTs, false);
        _activateBallot(leftEpoch);
    }

    /// The amount is the commitment. `nanos` is not an argument.
    function lock(bytes calldata dest, bytes32 commit, uint256 nowTs, bytes32 ownerCommit, bool qualifies) external onlyShear {
        _lock(dest, commit, nowTs, false, ownerCommit, qualifies);
    }

    /// Same credit as lock, with the time-locked note flag set.
    function lockNote(bytes calldata dest, bytes32 commit, uint256 nowTs, bool notePrincipal, bytes32 ownerCommit, bool qualifies) external onlyShear {
        _lock(dest, commit, nowTs, notePrincipal, ownerCommit, qualifies);
    }

    /// A withdraw in this block keeps this portal's legacy principal.
    function holdWithdraw(bytes calldata dest) external onlyShear {
        if (dest.length == 0) revert BadDest();
        bytes32 id = portalId(dest);
        bytes32 shaId = sha256(abi.encodePacked("shear-portal-v1", dest));
        if (!withdrawHold[id]) {
            withdrawHold[id] = true;
            heldIds.push(id);
        }
        if (!withdrawHoldSha[shaId]) {
            withdrawHoldSha[shaId] = true;
            heldShas.push(shaId);
        }
    }

    function clearWithdrawHolds() external onlyShear {
        _clearWithdrawHolds();
    }

    function _clearWithdrawHolds() internal {
        uint256 n = heldIds.length;
        for (uint256 i = 0; i < n; i++) withdrawHold[heldIds[i]] = false;
        uint256 m = heldShas.length;
        for (uint256 i = 0; i < m; i++) withdrawHoldSha[heldShas[i]] = false;
        delete heldIds;
        delete heldShas;
    }

    function _lock(bytes calldata dest, bytes32 commit, uint256 nowTs, bool notePrincipal, bytes32 ownerCommit, bool qualifies) internal {
        if (commit == bytes32(0)) revert BadAmount();
        if (dest.length == 0) revert BadDest();
        if (clockGenesis == 0) revert ClockUnpinned();
        if (epochStart != 0 && !bonusEnacted && remainingMs(nowTs) == 0) revert NeedEnact();
        if (bonusEnacted && !deferEpochRoll) _syncEpoch(nowTs);
        bytes32 id = portalId(dest);
        if (!portalListed[id]) {
            portalListed[id] = true;
            portalKeys.push(id);
            portalSha[id] = sha256(abi.encodePacked("shear-portal-v1", dest));
        }
        Portal storage p = portals[id];
        // Every lock names its owner. A later lock must name the same one.
        if (ownerCommit == bytes32(0)) revert OwnerMissing();
        bytes32 prior = ownerOf[id];
        if (prior != bytes32(0) && prior != ownerCommit) revert Unsigned();
        if (prior == bytes32(0)) ownerOf[id] = ownerCommit;
        _settle(p, nowTs);
        uint256 idx = _chainEpoch(nowTs);
        uint256 span = epochLengthMs();
        uint256 remain = 0;
        if (clockGenesis != 0) {
            uint256 end = clockGenesis + (idx + 1) * span;
            if (nowTs < end) remain = end - nowTs;
            if (remain > span) remain = span;
        }
        p.tranches.push(Tranche({
            amount: 0,
            epoch: idx,
            remainMs: remain,
            fullFrom: idx + 1,
            partialPaid: false,
            notePrincipal: notePrincipal,
            commit: commit
        }));
        p.rewardTracked = true;
        p.hiddenStake = true;
        if (qualifies && !p.joined) {
            p.joined = true;
            _syncEpoch(nowTs);
        } else if (p.joined && epochStart == 0) {
            // Clock pinned after the first lock. The next credit opens the chain epoch.
            _syncEpoch(nowTs);
        }
    }

    function vote(bytes calldata dest, Vote choice, uint256 nowTs) external view onlyShear {
        dest;
        choice;
        nowTs;
        revert NotVoter();
    }

    function enact(uint256 nowTs) external onlyShear {
        if (epochStart == 0) revert EpochNotEnded();
        if (nowTs < epochStart + epochLengthMs()) revert EpochNotEnded();
        if (bonusEnacted) revert AlreadyEnacted();
        uint256 up = votesIncrease;
        uint256 down = votesDecrease;
        uint256 hold = votesHold;
        uint256 m = up;
        if (down > m) m = down;
        if (hold > m) m = hold;
        uint256 winners = 0;
        int256 delta = 0;
        if (up == m && m > 0) { winners += 1; delta = 1; }
        if (down == m && m > 0) { winners += 1; delta = -1; }
        if (hold == m && m > 0) { winners += 1; delta = 0; }
        if (winners == 1 && delta > 0) liveHashBonusNanos += 1;
        else         if (winners == 1 && delta < 0) {
            if (liveHashBonusNanos <= GENESIS_BONUS) delta = 0;
            else liveHashBonusNanos -= 1;
        }
        bonusEnacted = true;
        enactedUp = up;
        enactedDown = down;
        enactedHold = hold;
        enactedDelta = winners == 1 ? delta : int256(0);
        enactedLiveBonus = liveHashBonusNanos;
        enactedAtMs = nowTs;
        enactedAtEpoch = currentEpoch;
    }

    function _rewardTaken(bytes32 id, Portal storage p, uint256 nowIdx) internal view returns (bool) {
        uint256 n = p.tranches.length;
        for (uint256 i = 0; i < n; i++) {
            if (nowIdx <= p.tranches[i].epoch) continue;
            for (uint256 e = p.tranches[i].epoch; e < nowIdx; e++) {
                if (_taken(id, e)) return true;
            }
        }
        return false;
    }

    function _hex64(bytes32 value) internal pure returns (string memory) {
        bytes16 alphabet = 0x30313233343536373839616263646566;
        bytes memory out = new bytes(64);
        for (uint256 i = 0; i < 32; i++) {
            uint8 b = uint8(value[i]);
            out[i * 2] = alphabet[b >> 4];
            out[i * 2 + 1] = alphabet[b & 0x0f];
        }
        return string(out);
    }

    function _dec(uint256 n) internal pure returns (string memory) {
        if (n == 0) return "0";
        uint256 x = n;
        uint256 digits = 0;
        while (x != 0) {
            digits += 1;
            x /= 10;
        }
        bytes memory out = new bytes(digits);
        x = n;
        while (x != 0) {
            digits -= 1;
            out[digits] = bytes1(uint8(48 + (x % 10)));
            x /= 10;
        }
        return string(out);
    }

    function _nullifier(bytes32 shaId, uint256 epoch) internal pure returns (bytes32) {
        return sha256(abi.encodePacked("shear-reserve-v1", _hex64(shaId), _dec(epoch), "withdraw"));
    }

    function _u64le(uint256 n) internal pure returns (bytes memory) {
        bytes memory out = new bytes(8);
        uint256 v = n;
        for (uint256 i = 0; i < 8; i++) {
            out[i] = bytes1(uint8(v));
            v >>= 8;
        }
        return out;
    }

    function _ownerCommit(bytes32 ownerPub) internal pure returns (bytes32) {
        return sha256(abi.encodePacked("shear-reward-owner-v1", ownerPub));
    }

    function _leaf(bytes32 nullifier, uint256 nanos, bytes32 ownerPub) internal pure returns (bytes32) {
        return sha256(abi.encodePacked(
            "shear-reward-leaf-v1",
            nullifier,
            _u64le(nanos),
            _ownerCommit(ownerPub)
        ));
    }

    function _u32le(uint256 n) internal pure returns (bytes memory) {
        bytes memory out = new bytes(4);
        uint256 v = n;
        for (uint256 i = 0; i < 4; i++) {
            out[i] = bytes1(uint8(v));
            v >>= 8;
        }
        return out;
    }

    function _authMessage(
        bytes memory tag,
        bytes32 nullifier,
        uint256 nanos,
        bytes calldata proof,
        bytes calldata dest
    ) internal pure returns (bytes memory) {
        return abi.encodePacked(tag, nullifier, _u64le(nanos), _u32le(proof.length), proof, _u32le(dest.length), dest);
    }

    function _ed25519(bytes32 ownerPub, bytes calldata sig, bytes memory message) internal view returns (bool) {
        if (sig.length != 64) return false;
        (bool ok, bytes memory out) = ED25519.staticcall(abi.encodePacked(ownerPub, sig, message));
        return ok && out.length == 32 && uint256(bytes32(out)) == 1;
    }

    function _authPub(bytes calldata auth) internal pure returns (bytes32) {
        return bytes32(auth[0:32]);
    }

    /// Ordered commitment of the matured non-note tranches this withdraw releases.
    function _trancheSet(Portal storage p, uint256 chain) internal view returns (bytes32 h) {
        h = sha256("shear-tranche-set-v1");
        uint256 n = p.tranches.length;
        for (uint256 i = 0; i < n; i++) {
            Tranche storage t = p.tranches[i];
            if (chain <= t.epoch || t.notePrincipal) continue;
            h = sha256(abi.encodePacked(h, t.commit, t.epoch, t.remainMs));
        }
    }

    /// Owner signature over the portal id, the principal, the book magic,
    /// the chain id, the release epoch, the tranche set, and the payout.
    /// A signature from an earlier release does not authorize a later one.
    function _withdrawAuthOk(
        bytes32 id,
        uint256 nanos,
        bytes calldata auth,
        bytes32 trancheSet,
        uint256 chain,
        bytes32 txBind
    ) internal view returns (bool) {
        if (auth.length < 96 || nanos > 9007199254740991) return false;
        return _ed25519(
            _authPub(auth),
            auth[32:96],
            abi.encodePacked(
                "shear-withdraw-owner-v1",
                id,
                _u64le(nanos),
                magic,
                _u64le(block.chainid),
                _u64le(chain),
                trancheSet,
                txBind,
                _u32le(auth.length - 96),
                auth[96:]
            )
        );
    }

    /// auth is ownerPub(32) || sig(64) || dest. proof may be empty.
    function _authOk(
        bytes memory tag,
        bytes32 id,
        uint256 nanos,
        bytes calldata proof,
        bytes calldata auth
    ) internal view returns (bool) {
        if (auth.length < 96) return false;
        return _ed25519(
            _authPub(auth),
            auth[32:96],
            _authMessage(tag, id, nanos, proof, auth[96:])
        );
    }

    function _verify(bytes32 leaf, bytes calldata proof, bytes32 root) internal pure returns (bool) {
        if (proof.length % 33 != 0) return false;
        bytes32 h = leaf;
        for (uint256 i = 0; i < proof.length;) {
            uint8 side = uint8(proof[i]);
            bytes32 sib = bytes32(proof[i + 1:i + 33]);
            if (side == 1) h = sha256(abi.encodePacked(sib, h));
            else if (side == 0) h = sha256(abi.encodePacked(h, sib));
            else return false;
            unchecked { i += 33; }
        }
        return h == root;
    }

    function _taken(bytes32 id, uint256 epoch) internal view returns (bool) {
        return nullifierMinted[_nullifier(portalSha[id], epoch)];
    }

    function _portalAccrual(bytes32 id, uint256 nowIdx)
        internal
        view
        returns (uint256[] memory epochs, uint256[] memory amounts)
    {
        Portal storage p = portals[id];
        uint256 span = epochLengthMs();
        uint256 cut = cutoffLengthMs();
        if (nowIdx == 0) return (new uint256[](0), new uint256[](0));
        uint256[] memory sums = new uint256[](nowIdx);
        bool[] memory hit = new bool[](nowIdx);
        uint256[] memory stakeAt = _stakeSeries(p, nowIdx, cut);
        uint256[] memory rates = _rateSeries(nowIdx);
        uint256 n = p.tranches.length;
        for (uint256 i = 0; i < n; i++) {
            Tranche storage t = p.tranches[i];
            if (t.remainMs >= cut && !t.partialPaid && nowIdx > t.epoch && stakeAt[t.epoch] >= PI_NANOS) {
                uint256 part = _partial(t.amount, rates[t.epoch], t.remainMs, span);
                if (part > 0) {
                    sums[t.epoch] += part;
                    hit[t.epoch] = true;
                }
            }
            if (nowIdx > t.fullFrom && t.remainMs > 0) {
                for (uint256 e = t.fullFrom; e < nowIdx; e++) {
                    if (stakeAt[e] < PI_NANOS) break;
                    uint256 full = (t.amount * rates[e]) / 10000;
                    if (full > 0) {
                        sums[e] += full;
                        hit[e] = true;
                    }
                }
            }
        }
        uint256 count = 0;
        for (uint256 e = 0; e < nowIdx; e++) {
            if (!hit[e] || sums[e] == 0 || sums[e] > 9007199254740991) continue;
            if (_taken(id, e) || _archived(e, nowIdx)) continue;
            count += 1;
        }
        epochs = new uint256[](count);
        amounts = new uint256[](count);
        uint256 w = 0;
        for (uint256 e = 0; e < nowIdx; e++) {
            if (!hit[e] || sums[e] == 0 || sums[e] > 9007199254740991) continue;
            if (_taken(id, e) || _archived(e, nowIdx)) continue;
            epochs[w] = e;
            amounts[w] = sums[e];
            w += 1;
        }
    }

    /// Greatest committed index that is <= nowIdx. Roots are ordered, so the
    /// live greatest and the one before it are enough.
    function _greatestAtOrBelow(uint256 nowIdx) internal view returns (bool ok, uint256 k) {
        if (rewardHi == 0) return (false, 0);
        uint256 hi = rewardHi - 1;
        if (hi <= nowIdx) return (true, hi);
        if (rewardHiPrev == 0) return (false, 0);
        uint256 prev = rewardHiPrev - 1;
        if (prev <= nowIdx) return (true, prev);
        return (false, 0);
    }

    /// An earlier root already holds this reward epoch. The root stored at
    /// nowIdx does not count, so a recommit of this index lists the same rows.
    function _archived(uint256 epoch, uint256 nowIdx) internal view returns (bool) {
        if (rewardHi == 0) return false;
        uint256 hi = rewardHi - 1;
        if (hi < nowIdx) return hi > epoch;
        if (rewardHiPrev == 0) return false;
        uint256 prev = rewardHiPrev - 1;
        return prev < nowIdx && prev > epoch;
    }

    /// A stored root covers reward epoch `epoch` when it was committed at a
    /// later settlement index that is already due.
    function _rootCovers(uint256 epoch, uint256 nowIdx) internal view returns (bool) {
        (bool ok, uint256 k) = _greatestAtOrBelow(nowIdx);
        return ok && k > epoch;
    }

    /// True when a stored root already archived this portal's interest.
    /// The claim owns that interest. This looks at one portal, not the set.
    function _interestArchived(Portal storage p, uint256 nowIdx) internal view returns (bool) {
        if (rewardHi == 0 || nowIdx == 0) return false;
        (bool covered, uint256 cover) = _greatestAtOrBelow(nowIdx);
        if (!covered || cover == 0) return false;
        uint256 cut = cutoffLengthMs();
        uint256 span = epochLengthMs();
        uint256[] memory stakeAt = _stakeSeries(p, nowIdx, cut);
        uint256[] memory rates = _rateSeries(nowIdx);
        uint256 n = p.tranches.length;
        for (uint256 i = 0; i < n; i++) {
            Tranche storage t = p.tranches[i];
            if (t.remainMs >= cut && nowIdx > t.epoch && stakeAt[t.epoch] >= PI_NANOS) {
                if (_partial(t.amount, rates[t.epoch], t.remainMs, span) > 0 && t.epoch < cover) return true;
            }
            if (t.remainMs > 0 && nowIdx > t.epoch + 1) {
                uint256 stop = nowIdx;
                if (cover < stop) stop = cover;
                for (uint256 e = t.epoch + 1; e < stop; e++) {
                    if (stakeAt[e] < PI_NANOS) break;
                    if ((t.amount * rates[e]) / 10000 == 0) continue;
                    return true;
                }
            }
        }
        return false;
    }

    /// A root committed before this settlement already holds one of this
    /// portal's rewards. This block's withdraw then pays principal only.
    function _hasPriorArchive(Portal storage p, uint256 nowIdx) internal view returns (bool) {
        if (rewardHi == 0 || nowIdx == 0) return false;
        uint256 cut = cutoffLengthMs();
        uint256 span = epochLengthMs();
        uint256[] memory stakeAt = _stakeSeries(p, nowIdx, cut);
        uint256[] memory rates = _rateSeries(nowIdx);
        uint256 n = p.tranches.length;
        for (uint256 i = 0; i < n; i++) {
            Tranche storage t = p.tranches[i];
            if (t.remainMs >= cut && nowIdx > t.epoch && stakeAt[t.epoch] >= PI_NANOS) {
                if (_partial(t.amount, rates[t.epoch], t.remainMs, span) > 0 && _archived(t.epoch, nowIdx)) return true;
            }
            if (t.remainMs > 0 && nowIdx > t.epoch + 1) {
                for (uint256 e = t.epoch + 1; e < nowIdx; e++) {
                    if (stakeAt[e] < PI_NANOS) break;
                    if ((t.amount * rates[e]) / 10000 == 0) continue;
                    if (_archived(e, nowIdx)) return true;
                }
            }
        }
        return false;
    }

    /// A claim already minted one of this portal's due leaves, or a stored
    /// root is holding them. A withdraw in this same block still pays.
    function _rewardHeld(bytes32 id, Portal storage p, uint256 nowTs) internal view returns (bool) {
        uint256 nowIdx = _payIndex(nowTs);
        if (_rewardTaken(id, p, nowIdx)) return true;
        if (_hasPriorArchive(p, nowIdx)) return true;
        if (withdrawHold[id]) return false;
        return _interestArchived(p, nowIdx);
    }

    /// The withdraw paid these leaves. A later claim of the same leaf reverts.
    function _mintDue(bytes32 id, uint256 nowIdx) internal {
        (uint256[] memory epochs,) = _portalAccrual(id, nowIdx);
        for (uint256 r = 0; r < epochs.length; r++) {
            nullifierMinted[_nullifier(portalSha[id], epochs[r])] = true;
        }
    }

    /// Store the root the node computed. Portal count does not change the
    /// cost. An empty root is not stored. A second root for this index must
    /// match. Principal is not released here.
    function commitRewards(uint256 nowTs, bytes32 root) external onlyShear returns (bytes32) {
        uint256 nowIdx = _payIndex(nowTs);
        if (nowIdx == 0) revert EpochNotEnded();
        bytes32 empty = sha256("shear-empty-root-v1");
        if (root == bytes32(0) || root == empty) return empty;
        bytes32 prior = rewardRootOf[nowIdx];
        if (prior != bytes32(0) && prior != root) revert BadAmount();
        if (prior == bytes32(0)) {
            rewardEpochs.push(nowIdx);
            uint256 stamped = nowIdx + 1;
            if (stamped > rewardHi) {
                rewardHiPrev = rewardHi;
                rewardHi = stamped;
            }
        }
        rewardRootOf[nowIdx] = root;
        return root;
    }

    /// Store the vault-lock root under the earning epoch. A zero root reverts
    /// so a missing root is not confused with an empty set. The empty marker
    /// is not stored. A second root for this epoch must match.
    function commitVaultRoot(uint256 earn, bytes32 root) external onlyShear returns (bytes32) {
        if (root == bytes32(0)) revert BadAmount();
        bytes32 emptyRoot = sha256("shear-empty-root-v1");
        if (root == emptyRoot) return emptyRoot;
        bytes32 prior = vaultRootOf[earn];
        if (prior != bytes32(0) && prior != root) revert BadAmount();
        vaultRootOf[earn] = root;
        return root;
    }

    /// Snapshot the vault-lock root at the moment the earning epoch opens.
    /// A later lock is not in this root, so it cannot prove a full claim.
    function commitEpochStartRoot(uint256 earn, bytes32 root) external onlyShear returns (bytes32) {
        if (root == bytes32(0)) revert BadAmount();
        bytes32 prior = epochStartRootOf[earn];
        if (prior != bytes32(0) && prior != root) revert BadAmount();
        epochStartRootOf[earn] = root;
        return root;
    }

    /// Leaf count committed with the frozen root, and the height that root opened.
    /// A second commit must match. Height 0 is a real open, so the high bit is the flag.
    function commitEpochCensus(uint256 epoch, uint256 leafCount, uint256 openHeight) external onlyShear {
        if (leafCount > type(uint64).max || openHeight > type(uint64).max) revert BadAmount();
        uint256 packed = (uint256(1) << 255) | (leafCount << 64) | openHeight;
        uint256 prior = epochCensus[epoch];
        if (prior != 0 && prior != packed) revert BadAmount();
        epochCensus[epoch] = packed;
    }

    function castVote(
        bytes calldata proof,
        bytes calldata output,
        uint8 paramId,
        int8 choice,
        uint32 seq,
        uint256 height,
        uint256 epoch
    ) external onlyShear returns (uint256 up, uint256 down, uint256 hold, uint256 turnout) {
        if (paramId > 1 || choice < -1 || choice > 1) revert BadAmount();
        if (seq == 0 || seq > 8) revert VoteLocked();
        uint256 census = epochCensus[epoch];
        if (census == 0) revert NotVoter();
        uint256 openH = census & ((uint256(1) << 64) - 1);
        uint256 closeH = openH + _voteCloseDay() * 960;
        if (height < openH || height > closeH) revert EpochClosed();
        if (epochStartRootOf[epoch] == bytes32(0)) revert NotVoter();
        bytes32 pid = _proposalId(epoch, paramId);
        uint256 code = _voteCode(proof, output, epoch, choice, seq, pid);
        if (code == 2) revert BadAmount();
        if (code != 1) revert Unsigned();
        bytes32 tag = _voteTag(proof, epoch, pid);
        uint256 prior = ballotOf[epoch][pid][tag];
        uint256 priorSeq = prior & 0xff;
        if (priorSeq != 0 && seq <= priorSeq) revert VoteLocked();
        uint256 priorChoice = (prior >> 8) & 3;
        uint256 nextChoice = choice == 1 ? 1 : (choice < 0 ? 2 : 3);
        uint256 counts = ballotCount[epoch][pid];
        uint256 cUp = counts & ((uint256(1) << 64) - 1);
        uint256 cDown = (counts >> 64) & ((uint256(1) << 64) - 1);
        uint256 cHold = (counts >> 128) & ((uint256(1) << 64) - 1);
        if (priorChoice == 1 && cUp > 0) cUp -= 1;
        else if (priorChoice == 2 && cDown > 0) cDown -= 1;
        else if (priorChoice == 3 && cHold > 0) cHold -= 1;
        if (nextChoice == 1) cUp += 1;
        else if (nextChoice == 2) cDown += 1;
        else cHold += 1;
        ballotOf[epoch][pid][tag] = uint256(seq) | (nextChoice << 8);
        ballotCount[epoch][pid] = cUp | (cDown << 64) | (cHold << 128);
        return (cUp, cDown, cHold, cUp + cDown + cHold);
    }

    function tallyBallot(uint8 paramId, uint256 epoch, uint256 height) external onlyShear returns (int256) {
        if (paramId > 1) revert BadAmount();
        bytes32 pid = _proposalId(epoch, paramId);
        uint256 prior = ballotStep[epoch][pid];
        if (prior != 0) return _unpackStep(prior);
        uint256 census = epochCensus[epoch];
        if (census == 0) revert NotVoter();
        uint256 openH = census & ((uint256(1) << 64) - 1);
        uint256 leaves = (census >> 64) & ((uint256(1) << 64) - 1);
        uint256 closeH = openH + _voteCloseDay() * 960;
        if (height < closeH + 100) revert EpochNotEnded();
        uint256 counts = ballotCount[epoch][pid];
        uint256 cUp = counts & ((uint256(1) << 64) - 1);
        uint256 cDown = (counts >> 64) & ((uint256(1) << 64) - 1);
        uint256 cHold = (counts >> 128) & ((uint256(1) << 64) - 1);
        int256 step = 0;
        uint256 turnout = cUp + cDown + cHold;
        if (leaves > 0 && turnout * 5 >= leaves) {
            uint256 directed = cUp + cDown;
            if (cUp > cDown && cUp * 3 >= directed * 2) step = 1;
            else if (cDown > cUp && cDown * 3 >= directed * 2) step = -1;
        }
        ballotStep[epoch][pid] = _packStep(step);
        return step;
    }

    function _voteCloseDay() internal view returns (uint256) {
        uint256 days_ = epochDaysOf();
        uint256 cut = magic == SHEAR_MAINNET ? JOIN_CUTOFF_DAYS : days_ / STAKE_CUTOFF_QUARTER_DEN;
        return days_ - cut;
    }

    function _proposalId(uint256 epoch, uint8 paramId) internal pure returns (bytes32) {
        bytes memory name = paramId == 0 ? bytes("hb") : bytes("rr");
        return sha256(abi.encodePacked("shear-vote-proposal-v1", _u64le(epoch), name));
    }

    function _packStep(int256 step) internal pure returns (uint256) {
        if (step > 0) return 3;
        if (step < 0) return 1;
        return 2;
    }

    function _unpackStep(uint256 packed) internal pure returns (int256) {
        if (packed == 3) return 1;
        if (packed == 1) return -1;
        return 0;
    }

    function _clampStep(uint256 current, int256 dir, uint256 floor_, uint256 ceil_) internal pure returns (uint256) {
        if (dir == 0) return current;
        if (current < 10) return current;
        uint256 delta = current / 10;
        uint256 next = dir > 0 ? current + delta : (current > delta ? current - delta : floor_);
        if (next < floor_) next = floor_;
        if (next > ceil_) next = ceil_;
        return next;
    }

    function _activateBallot(uint256 left) internal {
        _activateOne(left, 0, true);
        _activateOne(left, 1, false);
    }

    function _activateOne(uint256 left, uint8 paramId, bool bonus) internal {
        bytes32 pid = _proposalId(left, paramId);
        uint256 packed = ballotStep[left][pid];
        if (packed != 0) {
            int256 step = _unpackStep(packed);
            if (bonus) {
                liveHashBonusNanos = _clampStep(liveHashBonusNanos, step, GENESIS_BONUS, GENESIS_BONUS);
            } else {
                uint256 next = _clampStep(epochBps, step, 100, 2000);
                epochBps = next;
                annualBps = next;
                epochRateOf[currentEpoch] = next;
                epochRateKnown[currentEpoch] = true;
            }
        }
        delete ballotCount[left][pid];
        delete ballotStep[left][pid];
    }

    function _wordAt(bytes calldata blob, uint256 off) internal pure returns (bytes32 word) {
        assembly {
            word := calldataload(add(blob.offset, off))
        }
    }

    function _nullOff(bytes calldata proof) internal pure returns (uint256) {
        if (proof.length < 5 || proof[0] != 0xab) return 0;
        uint256 fs1Len = uint256(uint8(proof[1])) | (uint256(uint8(proof[2])) << 8) | (uint256(uint8(proof[3])) << 16) | (uint256(uint8(proof[4])) << 24);
        return 5 + fs1Len + 389;
    }

    /// Vote tag is the vote null point at byte 9. Not the claim null point.
    function _voteTag(bytes calldata proof, uint256 epoch, bytes32 pid) internal pure returns (bytes32) {
        if (proof.length < 41 || proof[0] != 0x56) return bytes32(0);
        return sha256(abi.encodePacked("shear-vote-v1", _wordAt(proof, 9), _u64le(epoch), pid));
    }

    function _voteCode(
        bytes calldata proof,
        bytes calldata output,
        uint256 epoch,
        int8 choice,
        uint32 seq,
        bytes32 pid
    ) internal view returns (uint256) {
        if (proof.length < 2 || proof[0] != 0x56 || output.length < 96) return 0;
        bytes32 root = epochStartRootOf[epoch];
        if (root == bytes32(0)) return 2;
        bytes1 cb = choice < 0 ? bytes1(0xff) : bytes1(uint8(int8(choice)));
        bytes memory book = _magicBook();
        (bool ok, bytes memory out) = VAULT_ZK.staticcall(abi.encodePacked(
            bytes("shear-vote-v2"),
            root,
            _u64le(epoch),
            cb,
            _u32le(seq),
            pid,
            _u32le(book.length),
            book,
            proof
        ));
        if (!ok || out.length < 32) return 0;
        return uint256(bytes32(out));
    }

    /// The utf8 book the proof was built under. Mainnet is not the testnet string.
    function _magicBook() internal view returns (bytes memory) {
        return magic == SHEAR_MAINNET ? bytes("shear-v1") : bytes("shear-testnet-v12");
    }

    function _vaultReward(bytes calldata proof) internal pure returns (uint256) {
        if (proof.length < 5 || proof[0] != 0xab) return 0;
        uint256 fs1Len = uint256(uint8(proof[1])) | (uint256(uint8(proof[2])) << 8) | (uint256(uint8(proof[3])) << 16) | (uint256(uint8(proof[4])) << 24);
        uint256 off = 5 + fs1Len + 321 + 4 + 8 + 8;
        if (off + 8 > proof.length) return 0;
        uint256 reward = 0;
        for (uint256 i = 0; i < 8; i++) {
            reward |= uint256(uint8(proof[off + i])) << (8 * i);
        }
        return reward;
    }

    /// Header: root || nullifier || u64 epoch || u32 bps || u64 span || u64 reward || u32 magicLen || magic.
    function _vaultHead(bytes32 root, bytes32 nullifier, uint256 epoch, bytes calldata proof) internal view returns (bytes memory) {
        uint256 span = _epochBlocks();
        uint256 bps = _rateFor(epoch / PERIODS_PER_EPOCH);
        uint256 reward = _vaultReward(proof);
        bytes memory book = _magicBook();
        return abi.encodePacked(
            root, nullifier, _u64le(epoch), _u32le(bps), _u64le(span), _u64le(reward), _u32le(book.length), book
        );
    }

    /// 1 accepts. 2 is a bad reward. 0 is not this proof. A missing root is 2,
    /// so the claim can be retried after the root is committed.
    /// Membership is the full lock set. No remainder index selects a leaf.
    function _vaultCode(bytes32 nullifier, uint256 epoch, bytes calldata proof, bytes calldata output) internal view returns (uint256) {
        if (proof.length < 2 || proof[0] != 0xab) return 0;
        if (output.length < 96) return 2;
        if (_vaultReward(proof) == 0) return 2;
        bytes32 root = epochStartRootOf[epoch];
        if (root == bytes32(0)) return 2;
        (bool ok, bytes memory out) = VAULT_ZK.staticcall(abi.encodePacked(
            _vaultHead(root, nullifier, epoch, proof),
            _u32le(output.length),
            output,
            proof
        ));
        if (!ok || out.length < 32) return 0;
        return uint256(bytes32(out));
    }

    /// A retire outside withdrawRetire would burn a nullifier before the epoch
    /// ends. Principal moves only inside withdrawRetire, at or after epoch end.
    function retire(bytes32, bytes calldata) external view onlyShear {
        revert EpochNotEnded();
    }

    /// A vault proof mints nothing here. It spends the nullifier. Anything else stays closed.
    function claim(
        bytes32 nullifier,
        uint256 nanos,
        uint256 rootIndex,
        bytes calldata proof,
        bytes calldata auth
    ) external onlyShear returns (uint256) {
        if (proof.length < 2 || proof[0] != 0xab) revert ClaimUnavailable();
        // rootIndex is the period. A claim older than the two-epoch window is closed.
        uint256 claimChain = rootIndex / 16;
        if (currentEpoch > claimChain + 2) revert ClaimUnavailable();
        if (nullifierMinted[nullifier]) revert AlreadyMinted();
        uint256 reward = _vaultReward(proof);
        if (reward == 0 || reward != nanos) revert BadAmount();
        uint256 code = _vaultCode(nullifier, rootIndex, proof, auth);
        if (code == 2) revert BadAmount();
        if (code != 1) revert Unsigned();
        nullifierMinted[nullifier] = true;
        return reward;
    }

    /// A matured qualifying commitment. The interest integer stays hidden.
    function _hiddenDue(Portal storage p, uint256 nowTs) internal view returns (bool) {
        if (p.hiddenRewardOpen) return true;
        if (!p.hiddenStake || !p.joined) return false;
        uint256 chain = _chainEpoch(nowTs);
        if (chain == 0) return false;
        uint256 cut = cutoffLengthMs();
        uint256 n = p.tranches.length;
        for (uint256 i = 0; i < n; i++) {
            Tranche storage t = p.tranches[i];
            if (t.commit == bytes32(0) || t.notePrincipal) continue;
            if (t.remainMs >= cut && chain > t.epoch) return true;
            if (chain > t.fullFrom && t.remainMs > 0) return true;
        }
        return false;
    }

    /// The owner's signed roll. The nullifier is not an argument: a roll that
    /// named both the portal and the claim nullifier would link them. The
    /// claim spends the nullifier on its own. The signature binds the chain
    /// id and this book's magic.
    function roll(
        bytes calldata dest,
        uint256 nowTs,
        uint256 epoch,
        bytes calldata auth
    ) external onlyShear returns (uint256) {
        bytes32 id = portalId(dest);
        if (ownerOf[id] == bytes32(0)) revert OwnerMissing();
        if (auth.length < 96 || _ownerCommit(_authPub(auth)) != ownerOf[id]) revert Unsigned();
        // The same sha256 portal id the JS roll signs. keccak portalId is the storage key.
        bytes32 shaId = portalSha[id];
        if (shaId == bytes32(0)) revert Unsigned();
        if (epoch != currentEpoch) revert EpochNotEnded();
        Portal storage p = portals[id];
        if (rolledEpoch[shaId][epoch]) revert AlreadyMinted();
        bytes32 withdrawId = _nullifier(shaId, _chainEpoch(nowTs));
        if (nullifierMinted[withdrawId] || withdrewEpochOf[shaId][epoch]) revert AlreadyMinted();
        bytes32 set = _rollSet(p);
        bytes memory message = abi.encodePacked(
            "shear-reward-roll-v1",
            shaId,
            _u64le(epoch),
            _u64le(block.chainid),
            magic,
            set
        );
        if (!_ed25519(_authPub(auth), auth[32:96], message)) revert Unsigned();
        rolledEpoch[shaId][epoch] = true;
        _settle(p, nowTs);
        return 1;
    }

    /// Same ordered hash as JS rollTrancheSet. A re-lock changes it.
    function _rollSet(Portal storage p) internal view returns (bytes32 h) {
        h = sha256("shear-roll-tranche-v1");
        uint256 n = p.tranches.length;
        for (uint256 i = 0; i < n; i++) {
            if (p.tranches[i].commit == bytes32(0)) continue;
            h = sha256(abi.encodePacked(h, p.tranches[i].commit, _u64le(p.tranches[i].epoch)));
        }
    }

    /// `auth` is ownerPub(32) || sig(64) || payout dest. The signature covers
    /// the portal id, the principal, this book's magic, the chain id, the
    /// release epoch, the matured tranche set, and that payout. The call
    /// itself names the lock, so the withdraw is linkable to the lock.
    /// `reward` is zero: the stake reward waits for the ZK claim. `earned`
    /// is the qualified amount that claim will pay.
    /// Refuses when a matured hidden leaf is still on the portal. A leaf
    /// leaves only through withdrawRetire, which burns its claim nullifiers.
    function withdraw(bytes calldata dest, uint256 nowTs, bytes calldata auth) external onlyShear returns (uint256 principal, uint256 reward, uint256 earned) {
        return _withdraw(dest, nowTs, auth, bytes(""));
    }

    /// Same withdraw, and the retire proofs burn the claim nullifiers of the
    /// leaves it releases. π is paid once per leaf, not once per epoch.
    /// Blob: u32le leaves || leaves × (u32le nullifierCount || nullifiers || u32le proofLen || proof).
    /// Each proof is verified once.
    function withdrawRetire(
        bytes calldata dest,
        uint256 nowTs,
        bytes calldata auth,
        bytes calldata retireBlob
    ) external onlyShear returns (uint256 principal, uint256 reward, uint256 earned) {
        return _withdraw(dest, nowTs, auth, retireBlob);
    }

    function _withdraw(bytes calldata dest, uint256 nowTs, bytes calldata auth, bytes memory retireBlob) internal returns (uint256 principal, uint256 reward, uint256 earned) {
        // No early withdraw. Principal moves only at or after the lock epoch's end.
        // A later top-up does not re-lock principal whose epoch has already ended.
        if (_payIndex(nowTs) == 0) revert EpochNotEnded();
        bytes32 id = portalId(dest);
        // No recorded owner is not a license to take the principal.
        if (ownerOf[id] == bytes32(0)) revert OwnerMissing();
        uint256 chainNow = _chainEpoch(nowTs);
        bytes32 withdrawId = _nullifier(portalSha[id], chainNow);
        // The interest withdraw id is checked even when no vault proof is attached.
        if (portalSha[id] != bytes32(0) && nullifierMinted[withdrawId]) revert AlreadyMinted();
        if (portalSha[id] != bytes32(0) && rolledEpoch[portalSha[id]][currentEpoch]) revert AlreadyMinted();
        Portal storage p = portals[id];
        uint256 active = p.active;
        uint256 idleBal = p.idle;
        if (active + idleBal == 0 && !p.hiddenStake) {
            if (creditedThrough[id] != 0) revert AlreadyMinted();
            revert BadAmount();
        }
        uint256 chain = _chainEpoch(nowTs);
        // Fold the qualified reward onto the portal and leave it there.
        // This pays principal only. It does not retire the leaves.
        _settle(p, nowTs);
        // Hash the matured set before the release loop drops those tranches.
        bytes32 trancheSet = _trancheSet(p, chain);
        uint256 hiddenRelease = _retireLeaves(p, chain, nowTs, retireBlob);
        // No proof bytes on this call. A matured hidden leaf stays, and the
        // withdraw does not drop it. An empty blob cannot retire, so it reverts.
        if (retireBlob.length == 0 && _maturedHiddenExists(p, chain)) revert Unsigned();
        if (_hiddenDue(p, nowTs)) p.hiddenRewardOpen = true;
        uint256 release = 0;
        uint256 noteMatured = 0;
        uint256 hiddenCount = 0;
        uint256 kept = 0;
        uint256 credits = p.tranches.length;
        for (uint256 i = 0; i < credits; i++) {
            if (chain <= p.tranches[i].epoch || p.tranches[i].notePrincipal) {
                if (chain > p.tranches[i].epoch && p.tranches[i].notePrincipal) {
                    noteMatured += p.tranches[i].amount;
                }
                if (kept != i) p.tranches[kept] = p.tranches[i];
                kept += 1;
            } else if (p.tranches[i].commit != bytes32(0)) {
                // Drop only a leaf this call retired. Any other matured
                // hidden commit stays on the portal.
                if (_isRetired(p.tranches[i].commit)) {
                    hiddenCount += 1;
                } else {
                    if (kept != i) p.tranches[kept] = p.tranches[i];
                    kept += 1;
                }
            } else {
                release += p.tranches[i].amount;
            }
        }
        if (release == 0 && hiddenCount == 0) {
            if (noteMatured > 0) revert NotePrincipal();
            revert EpochNotEnded();
        }
        while (p.tranches.length > kept) p.tranches.pop();
        // Legacy principal was booked on active and idle. A hidden leaf was
        // not, so its π is not debited from those balances. The owner signs
        // the sum: legacy principal plus one π per retired leaf.
        earned = p.accruedReward;
        reward = 0;
        uint256 signed = release + hiddenRelease;
        if (auth.length < 96 || _ownerCommit(_authPub(auth)) != ownerOf[id]) revert Unsigned();
        if (!_withdrawAuthOk(portalSha[id], signed, auth, trancheSet, chain, retireBindScratch)) revert Unsigned();
        if (release > 0) {
            if (release > active) {
                uint256 rest = release - active;
                p.active = 0;
                if (rest > p.idle) revert BadAmount();
                p.idle -= rest;
            } else {
                p.active = active - release;
            }
            totalLocked -= release;
        }
        principal = signed;
        uint256 left = p.active + p.idle;
        bool stillHidden = false;
        uint256 remainCredits = p.tranches.length;
        for (uint256 i = 0; i < remainCredits; i++) {
            if (p.tranches[i].commit != bytes32(0)) stillHidden = true;
        }
        if (left == 0 && !stillHidden) {
            p.rewardTracked = false;
            p.rewardEpoch = 0;
            p.joined = false;
            p.vote = Vote.None;
            p.voteEpoch = 0;
        } else if (!stillHidden && left < PI_NANOS) {
            p.joined = false;
            p.vote = Vote.None;
            p.voteEpoch = 0;
        }
        if (portalSha[id] != bytes32(0)) {
            nullifierMinted[withdrawId] = true;
            withdrewEpochOf[portalSha[id]][currentEpoch] = true;
        }
        _clearRetired();
    }

    function _readU32(bytes memory b, uint256 off) internal pure returns (uint256) {
        return uint256(uint8(b[off]))
            | (uint256(uint8(b[off + 1])) << 8)
            | (uint256(uint8(b[off + 2])) << 16)
            | (uint256(uint8(b[off + 3])) << 24);
    }

    function _copyAt(bytes memory blob, uint256 off, uint256 len) internal pure returns (bytes memory out) {
        out = new bytes(len);
        assembly ("memory-safe") {
            let src := add(blob, add(32, off))
            let dst := add(out, 32)
            let end := add(dst, len)
            for {} lt(dst, end) {
                dst := add(dst, 32)
                src := add(src, 32)
            } {
                mstore(dst, mload(src))
            }
        }
    }

    function _clearRetired() internal {
        while (retiredScratch.length > 0) retiredScratch.pop();
    }

    function _isRetired(bytes32 commit) internal view returns (bool) {
        uint256 n = retiredScratch.length;
        for (uint256 i = 0; i < n; i++) {
            if (retiredScratch[i] == commit) return true;
        }
        return false;
    }

    function _maturedHiddenExists(Portal storage p, uint256 chain) internal view returns (bool) {
        uint256 n = p.tranches.length;
        for (uint256 i = 0; i < n; i++) {
            if (chain <= p.tranches[i].epoch || p.tranches[i].notePrincipal) continue;
            if (p.tranches[i].commit != bytes32(0)) return true;
        }
        return false;
    }

    /// Period index of chain time. Period 0 is the first slice of epoch 0.
    function _chainPeriod(uint256 nowTs) internal view returns (uint256) {
        uint256 epoch = _chainEpoch(nowTs);
        uint256 g = clockGenesis;
        uint256 span = epochLengthMs();
        if (g == 0 || span == 0 || nowTs <= g) return epoch * PERIODS_PER_EPOCH;
        uint256 into = nowTs - (g + epoch * span);
        uint256 periodMs = span / PERIODS_PER_EPOCH;
        uint256 sub = 0;
        if (periodMs != 0 && into != 0) sub = into / periodMs;
        if (sub >= PERIODS_PER_EPOCH) sub = PERIODS_PER_EPOCH - 1;
        return epoch * PERIODS_PER_EPOCH + sub;
    }

    function _readU64(bytes memory b, uint256 off) internal pure returns (uint256 v) {
        for (uint256 i = 0; i < 8; i++) {
            v |= uint256(uint8(b[off + i])) << (8 * i);
        }
    }

    /// The three rows are the withdraw period through the next two, and the
    /// trailing tx bind is the one the owner signed. The block holds 64 DLEQs.
    function _retireWindowOk(bytes memory proof, uint256 period) internal pure returns (bool) {
        uint256 n = _retireRows(proof);
        if (n != 3) return false;
        uint256 leafAt = 12 + (n * RETIRE_ROW);
        if (proof.length != leafAt + 64 + 32) return false;
        bool seen0;
        bool seen1;
        bool seen2;
        for (uint256 i = 0; i < n; i++) {
            uint256 at = _readU64(proof, 12 + (i * RETIRE_ROW));
            if (at == period) seen0 = true;
            else if (at == period + 1) seen1 = true;
            else if (at == period + 2) seen2 = true;
            else return false;
        }
        return seen0 && seen1 && seen2;
    }

    function _takeRetireDleqs(uint256 nowTs, uint256 rows) internal {
        if (retireDleqsStamp != nowTs) {
            retireDleqsStamp = nowTs;
            retireDleqsUsed = 0;
        }
        retireDleqsUsed += rows;
        if (retireDleqsUsed > 64) revert Unsigned();
    }

    /// One π per distinct leaf commit. Each retire proof is verified once.
    /// The indexed nullifiers have to be the ones inside that proof.
    /// Rows cover the withdraw period through the next two and share one tx bind.
    function _retireLeaves(Portal storage p, uint256 chain, uint256 nowTs, bytes memory blob) internal returns (uint256) {
        _clearRetired();
        retireBindSet = false;
        retireBindScratch = bytes32(0);
        if (blob.length == 0) return 0;
        if (blob.length < 4) revert Unsigned();
        uint256 leaves = _readU32(blob, 0);
        if (leaves == 0 || leaves > 16) revert Unsigned();
        uint256 off = 4;
        uint256 period = _chainPeriod(nowTs);
        for (uint256 i = 0; i < leaves; i++) {
            if (off + 4 > blob.length) revert Unsigned();
            uint256 nNull = _readU32(blob, off);
            off += 4;
            if (nNull == 0 || off + (nNull * 32) + 4 > blob.length) revert Unsigned();
            bytes32[] memory ids = new bytes32[](nNull);
            for (uint256 j = 0; j < nNull; j++) {
            bytes32 id = _wordMem(blob, off);
            if (nullifierMinted[id]) revert AlreadyMinted();
                ids[j] = id;
                off += 32;
            }
            uint256 proofLen = _readU32(blob, off);
            off += 4;
            if (proofLen == 0 || off + proofLen > blob.length) revert Unsigned();
            bytes memory proof = _copyAt(blob, off, proofLen);
            off += proofLen;
            uint256 rows = _retireRows(proof);
            if (!_retireWindowOk(proof, period)) revert Unsigned();
            _takeRetireDleqs(nowTs, rows);
            bytes32 bind = _wordMem(proof, proof.length - 32);
            if (!retireBindSet) {
                retireBindScratch = bind;
                retireBindSet = true;
            } else if (bind != retireBindScratch) {
                revert Unsigned();
            }
            if (!_retireIdsMatch(proof, ids)) revert Unsigned();
            bytes memory book = _magicBook();
            (bool ok, bytes memory out) = VAULT_ZK.staticcall(
                abi.encodePacked(ids[0], bytes("shear-retire-v1"), _u32le(book.length), book, proof)
            );
            if (!ok || out.length < 32 || uint256(bytes32(out)) != 1) revert Unsigned();
            bytes32 commit = _retireLeafCommit(proof);
            if (commit == bytes32(0) || !_maturedHidden(p, chain, commit)) revert Unsigned();
            if (!_isRetired(commit)) {
                if (retiredScratch.length == 16) revert Unsigned();
                retiredScratch.push(commit);
            }
            for (uint256 j = 0; j < nNull; j++) nullifierMinted[ids[j]] = true;
        }
        if (off != blob.length) revert Unsigned();
        return retiredScratch.length * PI_NANOS;
    }

    /// u64 period || A1 || A2 || s || claim nullifier || retire nullifier.
    uint256 internal constant RETIRE_ROW = 168;

    function _retireRows(bytes memory proof) internal pure returns (uint256) {
        if (proof.length < 12) return 0;
        return _readU32(proof, 8);
    }

    function _wordMem(bytes memory b, uint256 off) internal pure returns (bytes32 word) {
        assembly ("memory-safe") {
            word := mload(add(b, add(32, off)))
        }
    }

    function _retireIdsMatch(bytes memory proof, bytes32[] memory ids) internal pure returns (bool) {
        uint256 n = _retireRows(proof);
        if (n < 1 || n > 3) return false;
        uint256 leafAt = 12 + (n * RETIRE_ROW);
        if (proof.length != leafAt + 64 + 32) return false;
        for (uint256 j = 0; j < ids.length; j++) {
            bool found = false;
            for (uint256 i = 0; i < n; i++) {
                uint256 row = 12 + (i * RETIRE_ROW);
                if (ids[j] == _wordMem(proof, row + 104) || ids[j] == _wordMem(proof, row + 136)) found = true;
            }
            if (!found) return false;
        }
        return true;
    }

    function _maturedHidden(Portal storage p, uint256 chain, bytes32 commit) internal view returns (bool) {
        uint256 n = p.tranches.length;
        for (uint256 i = 0; i < n; i++) {
            if (chain <= p.tranches[i].epoch || p.tranches[i].notePrincipal) continue;
            if (p.tranches[i].commit == commit) return true;
        }
        return false;
    }

    /// Leaf commit inside a retire proof. Layout matches the JS blob.
    function _retireLeafCommit(bytes memory proof) internal pure returns (bytes32 commit) {
        if (proof.length < 12 + RETIRE_ROW + 64 + 32) return bytes32(0);
        uint256 n = _readU32(proof, 8);
        if (n < 1 || n > 3) return bytes32(0);
        uint256 leafAt = 12 + (n * RETIRE_ROW);
        if (proof.length != leafAt + 64 + 32) return bytes32(0);
        commit = _wordMem(proof, leafAt + 32);
    }

    function publicView(uint256 nowTs)
        external
        view
        returns (
            uint256 start,
            uint256 daysLeft,
            uint256 locked,
            uint256 up,
            uint256 down,
            uint256 hold,
            uint256 rateBps,
            uint256 bonus,
            bool enacted,
            uint256 epoch
        )
    {
        uint256 showUp = bonusEnacted ? enactedUp : votesIncrease;
        uint256 showDown = bonusEnacted ? enactedDown : votesDecrease;
        uint256 showHold = bonusEnacted ? enactedHold : votesHold;
        return (
            epochStart,
            remainingDays(nowTs),
            totalLocked,
            showUp,
            showDown,
            showHold,
            epochBps,
            liveHashBonusNanos,
            bonusEnacted,
            currentEpoch
        );
    }

    function portalOf(bytes calldata dest)
        external
        view
        returns (uint256 active, uint256 idle, Vote vote, bool joined, uint256 voteEpoch)
    {
        Portal storage p = portals[portalId(dest)];
        return (p.active, p.idle, p.vote, p.joined, p.voteEpoch);
    }
}
