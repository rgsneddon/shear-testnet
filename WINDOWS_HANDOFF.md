# Windows pointer — Shear

**Start:** [`HANDOFF_OPS.md`](HANDOFF_OPS.md)

Live pins are always the **latest** clients:

| Client | Pin | Repo |
|--------|-----|------|
| Wallet | **0.40** | this tree, tag [`0.40`](https://github.com/rgsneddon/shear-testnet/releases/tag/0.40) |
| Miner | **ShearK 2.5** | [`rgsneddon/ShearK`](https://github.com/rgsneddon/ShearK/releases/tag/2.5) |
| Android APK | pack on **this Windows box** (see `HANDOFF_OPS.md` §6a) | `shear-wallet-0.40-android.apk` |
| macOS DMG | **MacBook handoff** (`HANDOFF_OPS.md` §6b) | `shear-wallet-0.40-macos.dmg` |

```
gh repo clone rgsneddon/shear-testnet %USERPROFILE%\shear-testnet
cd /d %USERPROFILE%\shear-testnet
git checkout main
git pull
notepad HANDOFF_OPS.md
notepad MACBOOK_HANDOFF.md
```
