// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * The Reserve — Shear's first Vortex program. Nodes execute this bytecode.
 *
 * Lock is legal while an epoch is open and the chain clock is pinned. An
 * unpinned clock rejects the lock. Vault epochs are chain vortex epochs.
 * Coin locked while at least the stake cutoff remains is an active
 * lock and can vote. Coin locked in the final stake window is idle: it earns
 * no stake reward, and its owner can still vote. Mainnet's window is the
 * last 99 days. Testnet's window is the last quarter of the epoch. A lock
 * or top-up made before that window, staked or idle,
 * earns its epoch's rate times the time still left in that chain epoch, by
 * integer floor, then each later full epoch before the open one. A
 * completed gap is paid immediately, at that epoch's committed rate or
 * else the last paid rate, including a commit on a skipped epoch. It does
 * not wait for a later enact. Each deposit, the original lock and every
 * top-up, stays locked until its own epoch has ended. A later top-up does
 * not re-lock earlier principal. Each tranche keeps the pro-rata of its
 * own lock epoch. After that epoch ends, any later block can withdraw
 * that deposit. A deposit whose epoch is still open stays in the reserve.
 * The still-open epoch is not paid. A portal votes once per epoch;
 * a second cast reverts VoteLocked(). At epoch end the unique plurality of {increase, decrease,
 * hold} enacts ±1 protocol unit on the live hash bonus. It does not set
 * the reserve rate. The freeze is the trimmed mean of the attested 14-bank
 * policy tenths (FED 3625, BOE 3750, ECB 2075, BOJ 500, BOC 2750, RBA 3600,
 * RBNZ 3000, SNB 0, RIKSBANK 2000, NORGES 4000, DNBANK 1600, BOK 2500,
 * BOI 4000, CNB 3500): drop 2 high and 2 low, half-up the middle 10,
 * 2840 tenths → 284 bps, floored at 0.
 * It is written only when an epoch opens. There is no per-epoch step and
 * no aggregate cap. A caller cannot select the rate.
 * The 1 SHE pot never moves. The reserve reward is minted by consensus on
 * release, for this program id, on every lock, idle or active, pro-rata.
 * Principal stays in the user's own time-locked note. This contract refuses
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
    // Placeholder. The single source is crypto/reserve_oracle.js GENESIS_BPS.
    uint256 public constant GENESIS_BPS = 284;
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
    }

    bytes32 public immutable magic;
    uint256 public epochStart;
    uint256 public currentEpoch;
    bool public bonusEnacted;
    uint256 public liveHashBonusNanos;
    mapping(bytes32 => Portal) private portals;
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
    mapping(uint256 => uint256) public epochRateOf;
    mapping(uint256 => bool) internal epochRateKnown;

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

    /// floor(amount * bps * remain / epochLength / 10000).
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

    /// The arrival epoch pays the time still left. Later full epochs pay
    /// through the open index, so a finished gap is included and the open
    /// epoch is not.
    function _settle(Portal storage p, uint256 nowTs) internal {
        uint256 nowIdx = _payIndex(nowTs);
        uint256 span = epochLengthMs();
        uint256 cut = cutoffLengthMs();
        uint256 n = p.tranches.length;
        for (uint256 i = 0; i < n; i++) {
            Tranche storage t = p.tranches[i];
            if (t.remainMs < cut) continue;
            if (!t.partialPaid && nowIdx > t.epoch) {
                p.accruedReward += _partial(t.amount, _rateFor(t.epoch), t.remainMs, span);
                t.partialPaid = true;
            }
            if (nowIdx > t.fullFrom) {
                for (uint256 e = t.fullFrom; e < nowIdx; e++) {
                    p.accruedReward += (t.amount * _rateFor(e)) / 10000;
                }
                t.fullFrom = nowIdx;
            }
        }
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

    /// Same integers as crypto/reserve_oracle.js trimmedMeanBps. ok is false under quorum.
    function trimmedMeanBps(int256[] memory tenths) public pure returns (bool ok, uint256 bps) {
        int256[] memory vals = new int256[](tenths.length);
        uint256 n = 0;
        for (uint256 i = 0; i < tenths.length; i++) {
            int256 t = tenths[i];
            if (t < -1000 || t > 100000) continue;
            vals[n] = t;
            n++;
        }
        if (n < 10) return (false, 0);
        for (uint256 i = 1; i < n; i++) {
            int256 key = vals[i];
            uint256 j = i;
            while (j > 0 && vals[j - 1] > key) {
                vals[j] = vals[j - 1];
                j--;
            }
            vals[j] = key;
        }
        uint256 start = 2;
        uint256 end = n - 2;
        if (end <= start) return (false, 0);
        int256 sum = 0;
        for (uint256 i = start; i < end; i++) sum += vals[i];
        int256 whole = _halfUpDiv(_halfUpDiv(sum, int256(uint256(end - start))), 10);
        if (whole < 0) return (true, 0);
        return (true, uint256(whole));
    }

    /// Sorted attested tenths. Drop the two lowest and two highest, half-up.
    function _bundledEpochBps() internal pure returns (uint256) {
        uint256 sum = 1600 + 2000 + 2075 + 2500 + 2750 + 3000 + 3500 + 3600 + 3625 + 3750;
        uint256 tenthsMean = (sum + 5) / 10;
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
        currentEpoch = idx;
        epochStart = clockGenesis + idx * epochLengthMs();
        bonusEnacted = false;
        _applyEpochRate(nowTs, false);
    }

    function lock(bytes calldata dest, uint256 nanos, uint256 nowTs) external onlyShear {
        if (nanos == 0) revert BadAmount();
        if (dest.length == 0) revert BadDest();
        if (clockGenesis == 0) revert ClockUnpinned();
        if (epochStart != 0 && !bonusEnacted && remainingMs(nowTs) == 0) revert NeedEnact();
        if (bonusEnacted && !deferEpochRoll) _syncEpoch(nowTs);
        bytes32 id = portalId(dest);
        Portal storage p = portals[id];
        _settle(p, nowTs);
        bool staking = canJoin(nowTs);
        if (staking) p.active += nanos;
        else p.idle += nanos;
        uint256 idx = _chainEpoch(nowTs);
        uint256 span = epochLengthMs();
        uint256 remain = 0;
        if (clockGenesis != 0) {
            uint256 end = clockGenesis + (idx + 1) * span;
            if (nowTs < end) remain = end - nowTs;
            if (remain > span) remain = span;
        }
        p.tranches.push(Tranche({
            amount: nanos,
            epoch: idx,
            remainMs: remain,
            fullFrom: idx + 1,
            partialPaid: false
        }));
        p.rewardTracked = true;
        totalLocked += nanos;
        if (!p.joined && (p.active + p.idle) >= PI_NANOS) {
            p.joined = true;
            _syncEpoch(nowTs);
        } else if (p.joined && epochStart == 0) {
            // Clock pinned after the first lock. The next credit opens the chain epoch.
            _syncEpoch(nowTs);
        }
    }

    function addMore(bytes calldata dest, uint256 nanos, uint256 nowTs) external onlyShear {
        this.lock(dest, nanos, nowTs);
    }

    function vote(bytes calldata dest, Vote choice, uint256 nowTs) external onlyShear {
        nowTs;
        bytes32 id = portalId(dest);
        Portal storage p = portals[id];
        if (!p.joined || (p.active + p.idle) < PI_NANOS) revert NotVoter();
        if (choice == Vote.None) revert NotVoter();
        if (epochStart == 0) revert NotVoter();
        if (bonusEnacted) revert EpochClosed();
        if (choice == Vote.DecreaseBonus && liveHashBonusNanos <= GENESIS_BONUS) revert UnitFloor();
        bool first = (p.vote == Vote.None || p.voteEpoch != currentEpoch);
        if (!first) revert VoteLocked();
        p.vote = choice;
        p.voteEpoch = currentEpoch;
        if (choice == Vote.IncreaseBonus) votesIncrease += 1;
        if (choice == Vote.DecreaseBonus) votesDecrease += 1;
        if (choice == Vote.LeaveBonusAsIs) votesHold += 1;
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

    function withdraw(bytes calldata dest, uint256 nowTs) external onlyShear returns (uint256 principal, uint256 reward) {
        // Each deposit unlocks at the end of its own lock epoch. A later
        // top-up does not re-lock principal whose epoch has already ended.
        if (_payIndex(nowTs) == 0) revert EpochNotEnded();
        bytes32 id = portalId(dest);
        Portal storage p = portals[id];
        uint256 active = p.active;
        uint256 idleBal = p.idle;
        if (active + idleBal == 0) revert BadAmount();
        uint256 chain = _chainEpoch(nowTs);
        _settle(p, nowTs);
        uint256 release = 0;
        uint256 kept = 0;
        uint256 credits = p.tranches.length;
        for (uint256 i = 0; i < credits; i++) {
            if (chain <= p.tranches[i].epoch) {
                if (kept != i) p.tranches[kept] = p.tranches[i];
                kept += 1;
            } else {
                release += p.tranches[i].amount;
            }
        }
        if (credits == 0) release = active + idleBal;
        if (release == 0) revert EpochNotEnded();
        while (p.tranches.length > kept) p.tranches.pop();
        // Each completed chain epoch pays at the rate committed for that epoch.
        reward = p.accruedReward;
        p.accruedReward = 0;
        if (release > active) {
            uint256 rest = release - active;
            p.active = 0;
            if (rest > p.idle) revert BadAmount();
            p.idle -= rest;
        } else {
            p.active = active - release;
        }
        totalLocked -= release;
        principal = release;
        uint256 left = p.active + p.idle;
        bool leave = left == 0 || left < PI_NANOS;
        if (leave && p.voteEpoch == currentEpoch) {
            if (p.vote == Vote.IncreaseBonus && votesIncrease > 0) votesIncrease -= 1;
            if (p.vote == Vote.DecreaseBonus && votesDecrease > 0) votesDecrease -= 1;
            if (p.vote == Vote.LeaveBonusAsIs && votesHold > 0) votesHold -= 1;
        }
        if (left == 0) {
            p.rewardTracked = false;
            p.rewardEpoch = 0;
            p.joined = false;
            p.vote = Vote.None;
            p.voteEpoch = 0;
        } else if (left < PI_NANOS) {
            p.joined = false;
            p.vote = Vote.None;
            p.voteEpoch = 0;
        }
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
