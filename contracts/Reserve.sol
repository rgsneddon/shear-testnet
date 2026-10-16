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
 * on the claim. The signature does publish the spend key, so a reader who
 * saved that key from the lock can match them.
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
        // Time-locked note. withdraw() does not pay this principal.
        bool notePrincipal;
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
    /// Settlement indexes that have a stored root, in commit order.
    uint256[] internal rewardEpochs;
    mapping(bytes32 => bool) internal nullifierMinted;
    /// Leaf a same-block withdraw pays, so a claim of that leaf reverts.
    mapping(bytes32 => bool) internal settledByWithdraw;
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

    /// The arrival epoch pays the time still left when that epoch's stake
    /// is at least π. Later full epochs pay on their own qualification, so
    /// a post-cutoff π misses only its arrival epoch. An epoch still under
    /// π is not marked paid.
    function _settle(Portal storage p, uint256 nowTs) internal {
        uint256 nowIdx = _payIndex(nowTs);
        uint256 span = epochLengthMs();
        uint256 cut = cutoffLengthMs();
        uint256 n = p.tranches.length;
        for (uint256 i = 0; i < n; i++) {
            Tranche storage t = p.tranches[i];
            if (!t.partialPaid && nowIdx > t.epoch) {
                if (t.remainMs >= cut && _qualifyingStake(p, t.epoch, cut) >= PI_NANOS) {
                    p.accruedReward += _partial(t.amount, _rateFor(t.epoch), t.remainMs, span);
                    t.partialPaid = true;
                } else if (t.remainMs < cut) {
                    t.partialPaid = true;
                }
            }
            if (nowIdx > t.fullFrom && t.remainMs > 0) {
                uint256 e = t.fullFrom;
                for (; e < nowIdx; e++) {
                    if (_qualifyingStake(p, e, cut) < PI_NANOS) break;
                    p.accruedReward += (t.amount * _rateFor(e)) / 10000;
                }
                t.fullFrom = e;
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

    function _legacyLockEpoch(Portal storage p) internal view returns (uint256) {
        if (p.legacyEpochPlus == 0) return currentEpoch;
        return p.legacyEpochPlus - 1;
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

    function lock(bytes calldata dest, uint256 nanos, uint256 nowTs, bytes32 ownerCommit) external onlyShear {
        _lock(dest, nanos, nowTs, false, ownerCommit);
    }

    /// Same credit as lock, with the time-locked note flag set.
    function lockNote(bytes calldata dest, uint256 nanos, uint256 nowTs, bool notePrincipal, bytes32 ownerCommit) external onlyShear {
        _lock(dest, nanos, nowTs, notePrincipal, ownerCommit);
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

    function _lock(bytes calldata dest, uint256 nanos, uint256 nowTs, bool notePrincipal, bytes32 ownerCommit) internal {
        if (nanos == 0) revert BadAmount();
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
            partialPaid: false,
            notePrincipal: notePrincipal
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
        _lock(dest, nanos, nowTs, false, bytes32(0));
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

    /// Owner signature over (portal id, principal, payout dest). No proof.
    function _withdrawAuthOk(bytes32 id, uint256 nanos, bytes calldata auth) internal view returns (bool) {
        if (auth.length < 96 || nanos == 0 || nanos > 9007199254740991) return false;
        return _ed25519(
            _authPub(auth),
            auth[32:96],
            abi.encodePacked(
                "shear-withdraw-owner-v1",
                id,
                _u64le(nanos),
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
        uint256 n = p.tranches.length;
        for (uint256 i = 0; i < n; i++) {
            Tranche storage t = p.tranches[i];
            if (t.remainMs >= cut && !t.partialPaid && nowIdx > t.epoch && _qualifyingStake(p, t.epoch, cut) >= PI_NANOS) {
                uint256 part = _partial(t.amount, _rateFor(t.epoch), t.remainMs, span);
                if (part > 0) {
                    sums[t.epoch] += part;
                    hit[t.epoch] = true;
                }
            }
            if (nowIdx > t.fullFrom && t.remainMs > 0) {
                for (uint256 e = t.fullFrom; e < nowIdx; e++) {
                    if (_qualifyingStake(p, e, cut) < PI_NANOS) break;
                    uint256 full = (t.amount * _rateFor(e)) / 10000;
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

    /// An earlier root already holds this reward epoch. The root stored at
    /// nowIdx does not count, so a recommit of this index lists the same rows.
    function _archived(uint256 epoch, uint256 nowIdx) internal view returns (bool) {
        uint256 n = rewardEpochs.length;
        for (uint256 i = 0; i < n; i++) {
            uint256 k = rewardEpochs[i];
            if (epoch < k && k < nowIdx) return true;
        }
        return false;
    }

    /// A stored root covers reward epoch `epoch` when it was committed at a
    /// later settlement index that is already due.
    function _rootCovers(uint256 epoch, uint256 nowIdx) internal view returns (bool) {
        uint256 n = rewardEpochs.length;
        for (uint256 i = 0; i < n; i++) {
            uint256 k = rewardEpochs[i];
            if (k > epoch && k <= nowIdx) return true;
        }
        return false;
    }

    /// True when a stored root already archived this portal's interest.
    /// The claim owns that interest. This looks at one portal, not the set.
    function _interestArchived(Portal storage p, uint256 nowIdx) internal view returns (bool) {
        if (rewardEpochs.length == 0 || nowIdx == 0) return false;
        uint256 cut = cutoffLengthMs();
        uint256 span = epochLengthMs();
        uint256 n = p.tranches.length;
        for (uint256 i = 0; i < n; i++) {
            Tranche storage t = p.tranches[i];
            if (t.remainMs >= cut && nowIdx > t.epoch && _qualifyingStake(p, t.epoch, cut) >= PI_NANOS) {
                if (_partial(t.amount, _rateFor(t.epoch), t.remainMs, span) > 0 && _rootCovers(t.epoch, nowIdx)) return true;
            }
            if (t.remainMs > 0 && nowIdx > t.epoch + 1) {
                for (uint256 e = t.epoch + 1; e < nowIdx; e++) {
                    if (_qualifyingStake(p, e, cut) < PI_NANOS) break;
                    if ((t.amount * _rateFor(e)) / 10000 == 0) continue;
                    if (_rootCovers(e, nowIdx)) return true;
                }
            }
        }
        return false;
    }

    /// A root committed before this settlement already holds one of this
    /// portal's rewards. This block's withdraw then pays principal only.
    function _hasPriorArchive(Portal storage p, uint256 nowIdx) internal view returns (bool) {
        if (rewardEpochs.length == 0 || nowIdx == 0) return false;
        uint256 cut = cutoffLengthMs();
        uint256 span = epochLengthMs();
        uint256 n = p.tranches.length;
        for (uint256 i = 0; i < n; i++) {
            Tranche storage t = p.tranches[i];
            if (t.remainMs >= cut && nowIdx > t.epoch && _qualifyingStake(p, t.epoch, cut) >= PI_NANOS) {
                if (_partial(t.amount, _rateFor(t.epoch), t.remainMs, span) > 0 && _archived(t.epoch, nowIdx)) return true;
            }
            if (t.remainMs > 0 && nowIdx > t.epoch + 1) {
                for (uint256 e = t.epoch + 1; e < nowIdx; e++) {
                    if (_qualifyingStake(p, e, cut) < PI_NANOS) break;
                    if ((t.amount * _rateFor(e)) / 10000 == 0) continue;
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

    /// This block's withdraw pays its own leaves. Mark them before the claim
    /// transactions run. The mark is the holds in this block, not every portal.
    function _sealHeldRewards(uint256 nowIdx) internal {
        uint256 n = heldIds.length;
        for (uint256 i = 0; i < n; i++) {
            if (_hasPriorArchive(portals[heldIds[i]], nowIdx)) continue;
            (uint256[] memory epochs,) = _portalAccrual(heldIds[i], nowIdx);
            for (uint256 j = 0; j < epochs.length; j++) {
                settledByWithdraw[_nullifier(portalSha[heldIds[i]], epochs[j])] = true;
            }
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
        if (prior == bytes32(0)) rewardEpochs.push(nowIdx);
        rewardRootOf[nowIdx] = root;
        _sealHeldRewards(nowIdx);
        return root;
    }

    /// Reward claims wait for the ZK FS-1 ownership proof. Until that activates,
    /// every claim reverts. The leaf machinery stays for that later proof.
    function claim(
        bytes32 nullifier,
        uint256 nanos,
        uint256 rootIndex,
        bytes calldata proof,
        bytes calldata auth
    ) external onlyShear returns (uint256) {
        revert ClaimUnavailable();
    }

    /// `auth` is ownerPub(32) || sig(64) || payout dest. The signature covers
    /// the portal id, the principal, and that payout. The call itself names
    /// the lock, so the withdraw is linkable to the lock. `reward` is zero:
    /// the stake reward waits for the ZK claim. `earned` is the qualified
    /// amount that claim will pay.
    function withdraw(bytes calldata dest, uint256 nowTs, bytes calldata auth) external onlyShear returns (uint256 principal, uint256 reward, uint256 earned) {
        // Each deposit unlocks at the end of its own lock epoch. A later
        // top-up does not re-lock principal whose epoch has already ended.
        if (_payIndex(nowTs) == 0) revert EpochNotEnded();
        bytes32 id = portalId(dest);
        // No recorded owner is not a license to take the principal.
        if (ownerOf[id] == bytes32(0)) revert OwnerMissing();
        Portal storage p = portals[id];
        uint256 active = p.active;
        uint256 idleBal = p.idle;
        if (active + idleBal == 0) {
            if (creditedThrough[id] != 0) revert AlreadyMinted();
            revert BadAmount();
        }
        uint256 chain = _chainEpoch(nowTs);
        // Fold the qualified reward onto the portal and leave it there.
        // This pays principal only. It does not retire the leaves.
        _settle(p, nowTs);
        uint256 release = 0;
        uint256 noteMatured = 0;
        uint256 kept = 0;
        uint256 credits = p.tranches.length;
        for (uint256 i = 0; i < credits; i++) {
            if (chain <= p.tranches[i].epoch || p.tranches[i].notePrincipal) {
                if (chain > p.tranches[i].epoch && p.tranches[i].notePrincipal) {
                    noteMatured += p.tranches[i].amount;
                }
                if (kept != i) p.tranches[kept] = p.tranches[i];
                kept += 1;
            } else {
                release += p.tranches[i].amount;
            }
        }
        // No tranche list: one legacy credit for the whole balance. It is
        // payable only after its lock epoch. The lock instant was not stored,
        // so this credit does not earn.
        if (credits == 0 && chain > _legacyLockEpoch(p)) release = active + idleBal;
        if (release == 0) {
            if (noteMatured > 0) revert NotePrincipal();
            revert EpochNotEnded();
        }
        while (p.tranches.length > kept) p.tranches.pop();
        // Principal only. The qualified reward stays on the portal for the
        // ZK claim. The recorded owner must sign (portal id, principal, payout).
        earned = p.accruedReward;
        reward = 0;
        if (auth.length < 96 || _ownerCommit(_authPub(auth)) != ownerOf[id]) revert Unsigned();
        if (!_withdrawAuthOk(portalSha[id], release, auth)) revert Unsigned();
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
            p.legacyEpochPlus = 0;
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
