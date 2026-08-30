// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * The Reserve — Shear's first Vortex program. Nodes execute this bytecode.
 *
 * Deposit is legal any time an epoch is open. Coin locked in the first 301
 * days is staked (interest, vote). Coin locked in the last 99 days is idle
 * (no interest) but still unlocks a vote if the portal holds ≥ π, even on a
 * first-ever deposit. A wallet may change its vote only in the first 301
 * days. At epoch end the unique plurality of {increase, decrease, hold}
 * enacts ±1 protocol unit on the live hash bonus. The 1 SHE pot never
 * moves. Interest is minted by the Shear node on withdraw, only for this
 * program id, only on staked principal. Nodes do not fetch HTTP; they
 * CALL observeRate with the Reserve oracle reading. This contract refuses
 * well-known foreign chain ids.
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

contract Reserve {
    bytes32 public constant SHEAR_TESTNET = keccak256(bytes("shear-testnet-v2"));
    bytes32 public constant SHEAR_TESTNET_V1 = keccak256(bytes("shear-testnet-v1"));
    bytes32 public constant SHEAR_MAINNET = keccak256(bytes("shear-v1"));
    bytes32 public constant PROGRAM_ID = keccak256(bytes("shear-reserve-v1"));

    uint256 public constant PI_NANOS = 314_159_265_358;
    uint256 public constant EPOCH_DAYS = 400;
    uint256 public constant JOIN_CUTOFF_DAYS = 99;
    uint256 public constant DAY_MS = 86_400_000;
    uint256 public constant EPOCH_MS = 400 * 86_400_000;
    uint256 public constant CUTOFF_MS = 99 * 86_400_000;
    uint256 public constant MAX_BPS = 10_000;
    uint256 public constant GENESIS_BONUS = 1;

    enum Vote {
        None,
        IncreaseBonus,
        DecreaseBonus,
        LeaveBonusAsIs
    }

    struct Portal {
        uint256 staked;
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

    modifier onlyShear() {
        _assertShear();
        _;
    }

    constructor(bytes32 shearMagic) {
        magic = shearMagic;
        annualBps = 425;
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
        if (magic != SHEAR_TESTNET && magic != SHEAR_TESTNET_V1 && magic != SHEAR_MAINNET) revert NotShear();
    }

    function remainingMs(uint256 nowTs) public view returns (uint256) {
        if (epochStart == 0 || bonusEnacted) return EPOCH_MS;
        uint256 end = epochStart + EPOCH_MS;
        if (nowTs >= end) return 0;
        return end - nowTs;
    }

    function remainingDays(uint256 nowTs) public view returns (uint256) {
        return remainingMs(nowTs) / DAY_MS;
    }

    function canJoin(uint256 nowTs) public view returns (bool) {
        if (epochStart == 0 || bonusEnacted) return true;
        return remainingMs(nowTs) >= CUTOFF_MS;
    }

    function epochOpen(uint256 nowTs) public view returns (bool) {
        if (epochStart == 0 || bonusEnacted) return true;
        return remainingMs(nowTs) > 0;
    }

    function portalId(bytes calldata dest) public pure returns (bytes32) {
        return keccak256(abi.encodePacked("shear-portal-v1", dest));
    }

    function observeRate(uint256 bps, uint256 nowTs) external onlyShear {
        nowTs;
        if (bps > MAX_BPS) revert BadRate();
        annualBps = bps;
    }

    function _maybeOpenEpoch(uint256 nowTs) internal {
        if (epochStart == 0) {
            currentEpoch = 1;
            epochStart = nowTs;
            bonusEnacted = false;
            return;
        }
        if (bonusEnacted) {
            currentEpoch += 1;
            epochStart = nowTs;
            bonusEnacted = false;
            votesIncrease = 0;
            votesDecrease = 0;
            votesHold = 0;
        }
    }

    function deposit(bytes calldata dest, uint256 nanos, uint256 nowTs) external onlyShear {
        if (nanos == 0) revert BadAmount();
        if (dest.length == 0) revert BadDest();
        if (epochStart != 0 && !bonusEnacted && remainingMs(nowTs) == 0) revert NeedEnact();
        bytes32 id = portalId(dest);
        Portal storage p = portals[id];
        bool staking = canJoin(nowTs);
        if (staking) p.staked += nanos;
        else p.idle += nanos;
        totalLocked += nanos;
        if (!p.joined && (p.staked + p.idle) >= PI_NANOS) {
            p.joined = true;
            _maybeOpenEpoch(nowTs);
        }
    }

    function addMore(bytes calldata dest, uint256 nanos, uint256 nowTs) external onlyShear {
        this.deposit(dest, nanos, nowTs);
    }

    function vote(bytes calldata dest, Vote choice, uint256 nowTs) external onlyShear {
        bytes32 id = portalId(dest);
        Portal storage p = portals[id];
        if (!p.joined || (p.staked + p.idle) < PI_NANOS) revert NotVoter();
        if (choice == Vote.None) revert NotVoter();
        if (epochStart == 0) revert NotVoter();
        if (bonusEnacted) revert EpochClosed();
        bool first = (p.vote == Vote.None || p.voteEpoch != currentEpoch);
        if (!first && remainingMs(nowTs) < CUTOFF_MS) revert VoteLocked();
        if (!first) {
            if (p.vote == Vote.IncreaseBonus) votesIncrease -= 1;
            if (p.vote == Vote.DecreaseBonus) votesDecrease -= 1;
            if (p.vote == Vote.LeaveBonusAsIs) votesHold -= 1;
        }
        p.vote = choice;
        p.voteEpoch = currentEpoch;
        if (choice == Vote.IncreaseBonus) votesIncrease += 1;
        if (choice == Vote.DecreaseBonus) votesDecrease += 1;
        if (choice == Vote.LeaveBonusAsIs) votesHold += 1;
    }

    function enact(uint256 nowTs) external onlyShear {
        if (epochStart == 0) revert EpochNotEnded();
        if (nowTs < epochStart + EPOCH_MS) revert EpochNotEnded();
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
            if (liveHashBonusNanos > 0) liveHashBonusNanos -= 1;
        }
        bonusEnacted = true;
    }

    function withdraw(bytes calldata dest, uint256 nowTs) external onlyShear returns (uint256 principal, uint256 interest) {
        if (epochStart == 0 || nowTs < epochStart + EPOCH_MS) revert EpochNotEnded();
        if (!bonusEnacted) revert NeedEnact();
        bytes32 id = portalId(dest);
        Portal storage p = portals[id];
        uint256 staked = p.staked;
        uint256 idle = p.idle;
        principal = staked + idle;
        if (principal == 0) revert BadAmount();
        interest = (staked * annualBps * EPOCH_DAYS) / (10000 * 365);
        totalLocked -= principal;
        if (p.voteEpoch == currentEpoch) {
            if (p.vote == Vote.IncreaseBonus && votesIncrease > 0) votesIncrease -= 1;
            if (p.vote == Vote.DecreaseBonus && votesDecrease > 0) votesDecrease -= 1;
            if (p.vote == Vote.LeaveBonusAsIs && votesHold > 0) votesHold -= 1;
        }
        p.staked = 0;
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
        return (
            epochStart,
            remainingDays(nowTs),
            totalLocked,
            votesIncrease,
            votesDecrease,
            votesHold,
            annualBps,
            liveHashBonusNanos,
            bonusEnacted,
            currentEpoch
        );
    }

    function portalOf(bytes calldata dest)
        external
        view
        returns (uint256 staked, uint256 idle, Vote vote, bool joined, uint256 voteEpoch)
    {
        Portal storage p = portals[portalId(dest)];
        return (p.staked, p.idle, p.vote, p.joined, p.voteEpoch);
    }
}
