# Cutover HANDOFF — Wednesday before Friday 11 Sep 2026

Launch public line: **Friday 11 September 2026, 21:00 BST**.
This file is for the **later cutover goal**. Prep does not flip.

## Do-not-touch after 18:00 BST on Friday 11 September 2026

- Do not edit live Germany systemd after **18:00 BST on the 11th**
- Do not recut wallet **0.26** or **0.27**
- Do not recut miner below **1.5**
- Do not invent pin **1.0** / **0.28**
- Do not open stratum on `p2p.shear.digital`

## Flip order (cutover goal only)

1. Publish genesis hash from `node crypto/genesis_mainnet.js` output
2. Start `shear-node-mainnet` on 46.224.132.83 (P2P only)
3. Flip staged `prep/site` onto Germany nginx **after** genesis is public
4. Point miners at mainnet magic `shear-v1` (ShearK 1.5 mainnet build)
5. Wallet 0.27 mainnet profile seeds: `p2p.shear.digital:30303`

## Source pin

Wallet **0.27** / miner **1.5**. Branch `prep/mainnet-shear-v1`. Pool snapshot `e018d6d` / tag `snapshot/mainnet-prep-20260907`.
