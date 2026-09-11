# Reserve notes (shear-testnet-v3)

The Reserve stays a complete product surface. Privacy-class may wrap the vault as a confidential note. It does not delete the vault.

- Program: `shear-reserve-v1`. Exactly one stable vault note per identity (`shear-reserve-v1` root, height 0).
- Kinds: `lock`, `vote`, `withdraw` (amount-bound mint only). `wrapMintForbidden`. Third-party vortice cannot mint SHE.
- Interest: `floor(staked * committedBps / 10000)` over 400 days. Idle (late 99 days) = 0 interest, can still vote.
- `committedBps` is the last `observeRate` sealed in a prior block. verifyBlock does not read `reserve/latest.json`.
- Oracle: unweighted mean of the frozen 14-bank basket. Default 264 bps until first sealed observe.
- Wrong amount = `mint_amount`. Vote cannot set `liveHashBonusNanos < 1`. The 1 SHE pot is not on the ballot.
- Portal check at admit. Openings local-only; stripped before chain.bin / P2P / public RPC.
- EVM `Reserve.sol` + gate remain. Levy cap 0.001 SHE, 50/50 finder / Reserve vault.
- Wallet Vortex hosts The Reserve. APIs `/api/vault/reserve` stay.
