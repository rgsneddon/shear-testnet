// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * The Reserve — Shear's first Vortex program. Nodes execute this bytecode.
 *
 * Lock is legal any time an epoch is open. Coin locked in the first 301
 * days is an active lock (reserve reward, vote). Coin locked in the last 99
 * days is idle (no reserve reward) but still unlocks a vote if the portal
 * holds ≥ π, even on a first-ever lock. A portal votes once per epoch; a
 * second cast reverts VoteLocked(). At epoch end the unique plurality of
 * {increase, decrease, hold} enacts ±1 protocol unit on the live hash bonus.
 * It does not set the reserve rate. The freeze is the trimmed mean of the
 * attested 14-bank policy tenths (FED 3625, BOE 3750, ECB 2075, BOJ 500,
 * BOC 2750, RBA 3600, RBNZ 3000, SNB 0, RIKSBANK 2000, NORGES 4000,
 * DNBANK 1600, BOK 2500, BOI 4000, CNB 3500): drop 2 high and 2 low,
 * half-up the middle 10, 2840 tenths → 284 bps, floored at 0.
 * It is written only when an epoch opens. There is no per-epoch step and
 * no aggregate cap. A caller cannot select the rate.
 * The 1 SHE pot never moves. The reserve reward
 * is minted by consensus on release, only for this program id, only on the
 * active lock. Principal stays in the user's own time-locked note. This
 * contract refuses well-known foreign chain ids. The Reserve oracle is the
 * bundled quorum. observeRate does not move the rate.
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
    uint256 public constant DAY_MS = 86_400_000;
    uint256 public constant EPOCH_MS = 400 * 86_400_000;
    uint256 public constant CUTOFF_MS = 99 * 86_400_000;
    uint256 public constant MAX_BPS = 10_000;
    uint256 public constant GENESIS_BONUS = 1;
    uint256 public constant GENESIS_BPS = 284;
    uint256 public constant ORACLE_MAX_AGE_MS = 14 * 86_400_000;
    uint256 public constant REWARD_DENOM_DAYS = 400;

    enum Vote {
        None,
        IncreaseBonus,
        DecreaseBonus,
        LeaveBonusAsIs
    }

    struct Portal {
        uint256 active;
        uint256 idle;
        Vote vote;
        bool joined;
        uint256 voteEpoch;
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

    function cutoffLengthMs() public view returns (uint256) {
        return (99 * epochLengthMs()) / 400;
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

    /// Node commit only. A caller bps that is not the recomputed bundle is BadRate.
    function commitRate(uint256 epochIdx, uint256 bps) external onlyShear {
        uint256 want = _bundledEpochBps();
        if (bps != want) revert BadRate();
        if (currentEpoch != 0 && epochIdx != currentEpoch) revert BadRate();
        epochBps = want;
        nextEpochBps = want;
        annualBps = want;
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
            if (t < -1000 || t > 10000) continue;
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

    function _applyEpochRate() internal {
        uint256 proposal = _bundledEpochBps();
        epochBps = proposal;
        nextEpochBps = proposal;
        annualBps = proposal;
    }

    function _maybeOpenEpoch(uint256 nowTs) internal {
        if (epochStart == 0) {
            currentEpoch = 1;
            epochStart = nowTs;
            bonusEnacted = false;
            _applyEpochRate();
            return;
        }
        if (bonusEnacted) {
            currentEpoch += 1;
            epochStart = nowTs;
            bonusEnacted = false;
            votesIncrease = 0;
            votesDecrease = 0;
            votesHold = 0;
            _applyEpochRate();
        }
    }

    function lock(bytes calldata dest, uint256 nanos, uint256 nowTs) external onlyShear {
        if (nanos == 0) revert BadAmount();
        if (dest.length == 0) revert BadDest();
        if (epochStart != 0 && !bonusEnacted && remainingMs(nowTs) == 0) revert NeedEnact();
        bytes32 id = portalId(dest);
        Portal storage p = portals[id];
        bool staking = canJoin(nowTs);
        if (staking) p.active += nanos;
        else p.idle += nanos;
        totalLocked += nanos;
        if (!p.joined && (p.active + p.idle) >= PI_NANOS) {
            p.joined = true;
            _maybeOpenEpoch(nowTs);
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
        else if (winners == 1 && delta < 0) {
            if (liveHashBonusNanos <= GENESIS_BONUS) delta = 0;
            else liveHashBonusNanos -= 1;
        }
        nextEpochBps = epochBps;
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
        if (epochStart == 0 || nowTs < epochStart + epochLengthMs()) revert EpochNotEnded();
        if (!bonusEnacted) revert NeedEnact();
        bytes32 id = portalId(dest);
        Portal storage p = portals[id];
        uint256 active = p.active;
        uint256 idle = p.idle;
        principal = active + idle;
        if (principal == 0) revert BadAmount();
        // Reserve reward: floor(active * epochBps / 10000). do not use 365.
        reward = (active * epochBps) / 10000;
        totalLocked -= principal;
        if (p.voteEpoch == currentEpoch) {
            if (p.vote == Vote.IncreaseBonus && votesIncrease > 0) votesIncrease -= 1;
            if (p.vote == Vote.DecreaseBonus && votesDecrease > 0) votesDecrease -= 1;
            if (p.vote == Vote.LeaveBonusAsIs && votesHold > 0) votesHold -= 1;
        }
        p.active = 0;
        p.idle = 0;
        p.joined = false;
        p.vote = Vote.None;
        p.voteEpoch = 0;
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
