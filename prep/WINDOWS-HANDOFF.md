# Windows laptop leftover — wallet 0.27 / ShearK 1.5

Open this on Windows. Copy-paste the commands. No secrets. Do **not** start mainnet. Do **not** edit pool withdraw.

Launch: **Friday 11 September 2026**, 21:00 BST.

## 0. Do not

- Do not flip DNS except the already-approved `p2p` A record
- Do not restart Germany systemd
- Do not mine `shear-testnet-v2` into a mainnet datadir
- Do not recut wallet below 0.27 or miner below 1.5
- Do not treat a SmartScreen-blocked unsigned exe as “the official mainnet pack”. Note the warning, then Unblock + Run anyway only for leftover test/mainnet-preview zips from this tag

## 1. Pins to match

| | |
|---|---|
| Wallet public pin | **0.27** (title `[testnet] Shear wallet 0.27` until cutover) |
| Miner | **ShearK-Miner 1.5** |
| Live testnet magic | `shear-testnet-v2` |
| Mainnet magic (preview only, do not advertise) | `shear-v1` |

## 2. Files the laptop should have

Expected names on tag **0.27** (this Mac does not pack them):

| File | present? |
|---|---|
| `shear-wallet-0.27-windows.zip` | Y/N |
| `shear-wallet-0.27-linux.zip` | Y/N |
| `shear-wallet-0.27-archlinux.zip` | Y/N |
| `ShearK-Miner-1.5-windows.zip` | Y/N |

Mainnet-preview ShearK (optional): put `ShearK-Miner-mainnet.exe` next to the 1.5 leftover, not inside the wallet zip. Wallet Windows leftover stays 0.27 testnet until you pack a mainnet profile on this box.

## 3. Commands (PowerShell)

After unzip of ShearK 1.5:

```
.\ShearK-Miner.exe --selftest
.\ShearK-Miner.exe --print-config
```

Expect:

- selftest digest still `64d41fa97f5ebea8a7e2a2625b1824467ce9d081bf29b0b2ae0a7fe617599895`
- v1 vector must fail (that digest must **not** print as the v2 selftest)
- testnet leftover: `"magic":"shear-testnet-v2"`
- mainnet-preview only: `"magic":"shear-v1"`
- `"version":"1.5"`, `feePct=0`, personalisation `ShearHash-v2`

Wallet leftover:

- Properties → Unblock on the zip/exe if Defender flags it
- Window title / about pin is **0.27**
- No miner bundled
- Testnet profile still talks to pool.shear.digital
- If a mainnet profile exists: seeds must list `p2p.shear.digital:30303` and `46.224.132.83:30303` — **do not press connect to a live mainnet book**

DNS:

```
Resolve-DnsName p2p.shear.digital -Type A
```

Expect `46.224.132.83`. If NXDOMAIN, write that down; do not invent a record.

## 4. What “checked” means

- [ ] 0.27 Windows leftover zip present
- [ ] 0.27 Linux leftover zip present (if that laptop holds it)
- [ ] ShearK 1.5 Windows `--selftest` pass
- [ ] `--print-config` magic recorded
- [ ] Defender/SmartScreen note recorded (unsigned testnet)
- [ ] `p2p.shear.digital` A record result recorded
- [ ] No live Germany service touched
- [ ] No mainnet mining started

## 5. Pass back

Paste the ticked file (or a short `WINDOWS CHECK:` block) into the next chat before cutover.
