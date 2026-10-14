# Reserve notes (shear-testnet-v3)

The Reserve stays a complete product surface. Privacy-class may wrap the vault as a confidential note. It does not delete the vault.

- Program: `shear-reserve-v1`. Exactly one stable vault note per identity (`shear-reserve-v1` root, height 0).
- Kinds: `lock`, `vote`, `withdraw` (amount-bound mint only). `wrapMintForbidden`. Third-party vortice cannot mint SHE.
- Reward: `floor(active * epochBps / 10000)` for the epoch (4 days testnet / 400 days mainnet). Idle (last 1 testnet day / 99 mainnet days) = 0 reward, can still vote.
- `epochBps` is the unweighted half-up mean of the attested 14-bank policy rates, frozen when the epoch opens. A vote does not set it. `observeRate` does not set it. verifyBlock does not read `reserve/latest.json` or a local snapshot.
- Banks, in order: FED, BOE, ECB, BOJ, BOC, RBA, RBNZ, SNB, RIKSBANK, NORGES, DNBANK, BOK, BOI, CNB. Each rate is the official base rate in tenths of a basis point (Fed: target-range median; ECB: median of deposit facility and main refinancing rate). Mean is `(sum + 7) / 14` tenths, then `(tenths + 5) / 10` whole bps. This bundle is 36900 tenths → 2636 → 264 bps. Quorum is those 14 ids once each. Anything else keeps the previous epoch bps.
- Live fetches of central-bank websites are not consensus. Nodes cannot be required to observe the same page. A new official rate enters only when a consensus release replaces the attested integers and the fingerprint root.
- Wrong amount = `mint_amount`. Vote cannot set `liveHashBonusNanos < 1`. The 1 SHE pot is not on the ballot.
- Portal check at admit. Openings local-only; stripped before chain.bin / P2P / public RPC.
- EVM `Reserve.sol` + gate remain. Levy cap 0.001 SHE. All of a block's transaction fees go to that block's miners. None is a vault fee share.
- Wallet Vortex hosts The Reserve. APIs `/api/vault/reserve` stay.
