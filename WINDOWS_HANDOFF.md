# Windows pointer — Shear

**Do not use this file as a pin list.** The only leftover / pin list the Windows box should read is:

**https://github.com/rgsneddon/handoff/blob/main/HANDOFF.md**

The Windows machine was **formatted**. There is no local repo. Clone from GitHub:

```
gh auth login
git clone https://github.com/rgsneddon/handoff.git %USERPROFILE%\handoff
git clone https://github.com/rgsneddon/shear-testnet.git %USERPROFILE%\shear-testnet
git clone https://github.com/rgsneddon/ShearK.git %USERPROFILE%\ShearK
```

Then read `HANDOFF.md` (top **Updated: 2026-09-11** block + section **Shear**).

Current pin: wallet **0.30** on `rgsneddon/shear-testnet`, miner **ShearK 1.6** on `rgsneddon/ShearK`. Leftover on this box: pack **`shear-wallet-0.30-windows.zip`** onto tag **0.30**. Linux/Arch 0.30 already on the tag. Miner 1.6 Windows zip already on the tag (`example.bat` is `YOUR_SSA1.worker`). Do **not** recut **0.29**. Do **not** recut **0.28**. Do **not** attach zips from the dead disk. Do **not** attach a Darwin binary as `*-linux.zip`.
