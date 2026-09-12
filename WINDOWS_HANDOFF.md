# Windows pointer — Shear

**Do not use this file as a pin list.** The formatted Windows box has **no local repo**. Start here:

**https://github.com/rgsneddon/handoff/blob/main/WINDOWS.md**

Full inventory (every repo / every platform):

**https://github.com/rgsneddon/handoff/blob/main/HANDOFF.md**

The Windows machine was **formatted** (2026-09-11) to recover from an error. There is **no** leftover tree, **no** zip, **no** Flutter, **no** Visual Studio / WSL. Clone from GitHub, then download — do **not** recut.

```
gh auth login
git clone https://github.com/rgsneddon/handoff.git %USERPROFILE%\handoff
git clone https://github.com/rgsneddon/shear-testnet.git %USERPROFILE%\shear-testnet
git clone https://github.com/rgsneddon/ShearK.git %USERPROFILE%\ShearK
notepad %USERPROFILE%\handoff\WINDOWS.md
```

Do **not** `git -C` a path until after `git clone`.

Current pin: wallet **0.30** on `rgsneddon/shear-testnet`, miner **ShearK 1.6** on `rgsneddon/ShearK`. **0.30 Windows zip is on tag** (`shear-wallet-0.30-windows.zip` sha256 `8bc28d5255e14935e2ec7afc5cd43d89a217c84247eff40edfe25da667bc29a8`). Miner 1.6 Windows zip is on tag (`ShearK-Miner-1.6-windows.zip` sha256 `879a0024297962cd9a97bf544dcd1fe1656a546d82ea37cfa6f6a2615befb5fb`, `example.bat` is `YOUR_SSA1.worker`). Linux/Arch 0.30 already on the tag. Download; do **not** recut **0.30**. Do **not** recut **0.29**. Do **not** recut **0.28**. Do **not** pack a second windows zip. Do **not** attach zips from the dead disk. Do **not** attach a Darwin binary as `*-linux.zip`. Privacy-class v3 is Mac-side WIP — do **not** pack v3 clients on this box.
