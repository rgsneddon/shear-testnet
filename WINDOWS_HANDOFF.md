# Windows pointer — Shear

**Do not use this file as a pin list.** The only leftover / pin list the Windows box should read is:

**https://github.com/rgsneddon/handoff/blob/main/HANDOFF.md**

The Windows machine was **formatted** (2026-09-11) to recover from an error. There is **no local repo** on that disk. Clone from GitHub:

```
gh auth login
git clone https://github.com/rgsneddon/handoff.git %USERPROFILE%\handoff
git clone https://github.com/rgsneddon/shear-testnet.git %USERPROFILE%\shear-testnet
git clone https://github.com/rgsneddon/ShearK.git %USERPROFILE%\ShearK
```

Do **not** `git -C` a path until after `git clone`. Then read `HANDOFF.md` (top **Updated: 2026-09-12** block + section **Shear**).

Current pin: wallet **0.30** on `rgsneddon/shear-testnet`, miner **ShearK 1.6** on `rgsneddon/ShearK`. **0.30 Windows zip is on tag** (`shear-wallet-0.30-windows.zip` sha256 `8bc28d5255e14935e2ec7afc5cd43d89a217c84247eff40edfe25da667bc29a8`). Miner 1.6 Windows zip is on tag (`example.bat` is `YOUR_SSA1.worker`). Linux/Arch 0.30 already on the tag. Download; do **not** recut **0.30**. Do **not** recut **0.29**. Do **not** recut **0.28**. Do **not** pack a second windows zip. Do **not** attach zips from the dead disk. Do **not** attach a Darwin binary as `*-linux.zip`.
