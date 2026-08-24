// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * The Reserve — Shear's first Vortex program.
 *
 * This file is an example, in Solidity, that a vortice on Shear may be
 * authored in any language. Nodes do not run an EVM. They honour these
 * same rules in the protocol. Copying this source onto another chain
 * does not make it Shear, and the guards below refuse that use.
 *
 * What the Reserve is for
 *
 * Holders may lock SHE for four hundred days. The lock is a civic act:
 * it buys a vote on the per-hash bonus for the current epoch, and it
 * earns interest on the staked principal at a variable rate observed
 * by The Reserve oracle that lives on every node. The one SHE block
 * pot is not in play. Third-party dapps may not mint. Only this
 * program id, shear-reserve-v1, may mint that interest, and only onto
 * a Shear dest when the epoch ends. A bad oracle reading cannot reorg
 * blocks or steal the pot.
 *
 * Epochs
 *
 * There is no operator start gun. The first epoch begins at the moment
 * the first holder deposits at least π SHE (3.141592653589793…) into
 * their own key-portal. That opens three hundred and one days of
 * staking: deposits in that window are staked, they earn interest, and
 * a portal that holds π may vote. Inside the last ninety-nine days,
 * new deposits are still accepted, but they sit idle. Idle SHE earns
 * no interest and cannot vote. A wallet should only mention that idle
 * window once remaining time has already fallen below ninety-nine
 * days. When the four hundred days are up, staked and idle principal
 * both return to the holder's Continuum spendable dest; interest is
 * minted only on what was staked.
 *
 * Key-portals
 *
 * Every user has a separate portal, keyed by their Reserve vault dest
 * (shp1), never by rest-frame shear1. The public book may show that
 * the program exists, that an epoch is running, the observed rate, and
 * the three vote tallies. It does not list who sits in which portal,
 * nor view keys, nor logins. Each wallet learns only its own portal
 * over the private dest path.
 *
 * Votes
 *
 * A portal that holds at least π SHE in its staked balance may vote to
 * increase the per-hash bonus, decrease it, or leave it as-is
 * (±1 protocol unit = ±10^{-11} SHE). One vote per portal per epoch. The 1 SHE pot does not
 * change. Idle SHE does not unlock a vote.
 *
 * Release
 *
 * After four hundred days, principal returns, and interest on the
 * staked balance is an extra mint allowed solely because this program
 * is shear-reserve-v1. The rate is whatever The Reserve oracle last
 * observed on the nodes — not a figure baked into consensus.
 */

error NotShear();
error BelowPi();
error NotVoter();
error EpochNotEnded();
error BadDest();
error BadAmount();
error BadRate();

contract Reserve {
    bytes32 public constant SHEAR_TESTNET = keccak256(bytes("shear-testnet-v1"));
    bytes32 public constant SHEAR_MAINNET = keccak256(bytes("shear-v1"));
    bytes32 public constant PROGRAM_ID = keccak256(bytes("shear-reserve-v1"));

    uint256 public constant PI_NANOS = 314_159_265_358;
    uint256 public constant EPOCH_DAYS = 400;
    uint256 public constant JOIN_CUTOFF_DAYS = 99;
    uint256 public constant DAY = 1 days;
    uint256 public constant MAX_BPS = 10_000;

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
    }

    bytes32 public immutable magic;
    uint256 public epochStart;
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
        _assertShear();
    }

    /**
     * Refuse well-known foreign chain identifiers and refuse any magic
     * that is not Shear testnet or Shear mainnet. This contract is not
     * a guest on someone else's ledger.
     */
    function _assertShear() internal view {
        uint256 id;
        assembly {
            id := chainid()
        }
        if (id == 1 || id == 56 || id == 137 || id == 10 || id == 42161 || id == 43114 || id == 8453) {
            revert NotShear();
        }
        if (magic != SHEAR_TESTNET && magic != SHEAR_MAINNET) revert NotShear();
    }

    function remainingDays(uint256 nowTs) public view returns (uint256) {
        if (epochStart == 0) return EPOCH_DAYS;
        uint256 end = epochStart + EPOCH_DAYS * DAY;
        if (nowTs >= end) return 0;
        return (end - nowTs) / DAY;
    }

    function canJoin(uint256 nowTs) public view returns (bool) {
        if (epochStart == 0) return true;
        return remainingDays(nowTs) >= JOIN_CUTOFF_DAYS;
    }

    function portalId(bytes calldata dest) public pure returns (bytes32) {
        return keccak256(abi.encodePacked("shear-portal-v1", dest));
    }

    /// Nodes call this when The Reserve oracle observes a new annual rate.
    function observeRate(uint256 bps, uint256 nowTs) external onlyShear {
        nowTs;
        if (bps > MAX_BPS) revert BadRate();
        annualBps = bps;
    }

    function deposit(bytes calldata dest, uint256 nanos, uint256 nowTs) external onlyShear {
        if (nanos == 0) revert BadAmount();
        if (dest.length == 0) revert BadDest();
        bytes32 id = portalId(dest);
        Portal storage p = portals[id];
        if (canJoin(nowTs)) {
            p.staked += nanos;
            if (!p.joined && p.staked >= PI_NANOS) {
                p.joined = true;
                if (epochStart == 0) epochStart = nowTs;
            }
        } else {
            p.idle += nanos;
        }
        totalLocked += nanos;
    }

    function addMore(bytes calldata dest, uint256 nanos, uint256 nowTs) external onlyShear {
        deposit(dest, nanos, nowTs);
    }

    function vote(bytes calldata dest, Vote choice, uint256 nowTs) external onlyShear {
        nowTs;
        bytes32 id = portalId(dest);
        Portal storage p = portals[id];
        if (p.staked < PI_NANOS || !p.joined) revert NotVoter();
        if (choice == Vote.None) revert NotVoter();
        if (p.vote == Vote.IncreaseBonus) votesIncrease -= 1;
        if (p.vote == Vote.DecreaseBonus) votesDecrease -= 1;
        if (p.vote == Vote.LeaveBonusAsIs) votesHold -= 1;
        p.vote = choice;
        if (choice == Vote.IncreaseBonus) votesIncrease += 1;
        if (choice == Vote.DecreaseBonus) votesDecrease += 1;
        if (choice == Vote.LeaveBonusAsIs) votesHold += 1;
    }

    function withdraw(bytes calldata dest, uint256 nowTs) external onlyShear returns (uint256 principal, uint256 interest) {
        if (epochStart == 0 || nowTs < epochStart + EPOCH_DAYS * DAY) revert EpochNotEnded();
        bytes32 id = portalId(dest);
        Portal storage p = portals[id];
        uint256 staked = p.staked;
        uint256 idle = p.idle;
        principal = staked + idle;
        if (principal == 0) revert BadAmount();
        interest = (staked * annualBps * EPOCH_DAYS) / (10000 * 365);
        totalLocked -= principal;
        if (p.vote == Vote.IncreaseBonus) votesIncrease -= 1;
        if (p.vote == Vote.DecreaseBonus) votesDecrease -= 1;
        if (p.vote == Vote.LeaveBonusAsIs) votesHold -= 1;
        p.staked = 0;
        p.idle = 0;
        p.joined = false;
        p.vote = Vote.None;
    }

    /// Public surface: epoch clock, observed rate, and tallies. No per-user portals.
    function publicView(uint256 nowTs)
        external
        view
        returns (uint256 start, uint256 daysLeft, uint256 locked, uint256 up, uint256 down, uint256 hold, uint256 rateBps)
    {
        return (epochStart, remainingDays(nowTs), totalLocked, votesIncrease, votesDecrease, votesHold, annualBps);
    }
}
