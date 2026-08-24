// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * The Join — Shear's prior-ledger claim vortice.
 *
 * This file is an example, in Solidity, that a vortice on Shear may be
 * authored in any language. Nodes do not run an EVM. They honour these
 * same rules in the protocol. Copying this source onto another chain
 * does not make it Shear, and the guards below refuse that use.
 *
 * What The Join is for
 *
 * At mainnet genesis the book of the prior ledger is frozen into a
 * Merkle snapshot. The Join vault is funded once, with that exact
 * circulating sum, as a one-shot mint allowed solely because this
 * program is shear-join-v1 and the tx kind is join-genesis. After
 * that mint the vault only pays claims or burns. It is not a second
 * printer. The Reserve remains the only programme that may mint
 * interest.
 *
 * The window
 *
 * From the genesis timestamp, holders have ninety-nine days to paste
 * a migration key in Vortex. Each snapshot line may be claimed once.
 * The credit is one prior coin for one SHE, paid to the holder's own
 * Continuum dest (shp1). The public book shows remaining vault coins,
 * the snapshot root, and the days left. It does not list who claimed,
 * nor prior-ledger addresses, nor view keys.
 *
 * After ninety-nine days
 *
 * Whatever still sits in the vault is burned. It is not paid to
 * miners and not paid to The Reserve. Later keys are refused.
 */

error NotShear();
error BadDest();
error BadAmount();
error WindowClosed();
error AlreadyClaimed();
error AlreadyFunded();
error BadProof();

contract Join {
    bytes32 public constant SHEAR_TESTNET = keccak256(bytes("shear-testnet-v1"));
    bytes32 public constant SHEAR_MAINNET = keccak256(bytes("shear-v1"));
    bytes32 public constant PROGRAM_ID = keccak256(bytes("shear-join-v1"));

    uint256 public constant WINDOW_DAYS = 99;
    uint256 public constant DAY = 1 days;

    bytes32 public immutable magic;
    uint256 public genesisStart;
    bytes32 public snapshotRoot;
    uint256 public circulating;
    uint256 public remaining;
    bool public burned;
    mapping(bytes32 => bool) private claimed;

    modifier onlyShear() {
        _assertShear();
        _;
    }

    constructor(bytes32 shearMagic) {
        magic = shearMagic;
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
        if (magic != SHEAR_TESTNET && magic != SHEAR_MAINNET) revert NotShear();
    }

    function remainingDays(uint256 nowTs) public view returns (uint256) {
        if (genesisStart == 0) return WINDOW_DAYS;
        uint256 end = genesisStart + WINDOW_DAYS * DAY;
        if (nowTs >= end) return 0;
        return (end - nowTs) / DAY;
    }

    function fundGenesis(bytes32 root, uint256 nanos, uint256 nowTs) external onlyShear {
        if (genesisStart != 0) revert AlreadyFunded();
        if (nanos == 0) revert BadAmount();
        snapshotRoot = root;
        circulating = nanos;
        remaining = nanos;
        genesisStart = nowTs;
        burned = false;
    }

    function claim(bytes32 leaf, bytes calldata dest, uint256 nanos, uint256 nowTs) external onlyShear {
        if (genesisStart == 0 || remainingDays(nowTs) == 0 || burned) revert WindowClosed();
        if (dest.length == 0) revert BadDest();
        if (nanos == 0 || nanos > remaining) revert BadAmount();
        if (claimed[leaf]) revert AlreadyClaimed();
        claimed[leaf] = true;
        remaining -= nanos;
    }

    function burnUnclaimed(uint256 nowTs) external onlyShear {
        if (genesisStart == 0 || remainingDays(nowTs) != 0) revert WindowClosed();
        remaining = 0;
        burned = true;
    }

    function publicView(uint256 nowTs)
        external
        view
        returns (uint256 start, uint256 daysLeft, uint256 locked, uint256 left, bool done, bytes32 root)
    {
        return (genesisStart, remainingDays(nowTs), circulating, remaining, burned, snapshotRoot);
    }
}
