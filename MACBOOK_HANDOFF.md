# MacBook handoff — Apple wallet 0.37

**GitHub (merged main):** https://github.com/rgsneddon/shear-testnet  
**This file on main:** https://github.com/rgsneddon/shear-testnet/blob/main/MACBOOK_HANDOFF.md  
**Wallet tag:** https://github.com/rgsneddon/shear-testnet/releases/tag/0.37  
**Miner:** https://github.com/rgsneddon/ShearK/releases/tag/2.4  
**Ops:** [`HANDOFF_OPS.md`](HANDOFF_OPS.md) §6b

Windows already published:

| Asset | Pack host |
|-------|-----------|
| `shear-wallet-0.37-windows.zip` | Windows |
| `shear-wallet-0.37-android.apk` | Windows |
| `shear-wallet-0.37-linux.zip` | `77.42.91.84` |
| `shear-wallet-0.37-archlinux.zip` | `77.42.91.84` |

macOS `.dmg` **cannot** be built on Windows. Do this on the Mac (`/Users/russellsneddon/shear` or a clone):

```
git clone https://github.com/rgsneddon/shear-testnet.git ~/shear-testnet
cd ~/shear-testnet
git checkout main
git pull
cd wallet
flutter --version            # 3.44.6+ is fine
brew list libsodium >/dev/null || brew install libsodium
PACK_REBUILD=1 ./pack_macos.sh
python3 pack/sign_and_notarize.py
# writes wallet/dist/shear-wallet-0.37-macos.dmg
gh release upload 0.36 dist/shear-wallet-0.37-macos.dmg --repo rgsneddon/shear-testnet --clobber
```

Then on `main`, replace the site span `macOS — coming soon` with:

`https://github.com/rgsneddon/shear-testnet/releases/download/0.37/shear-wallet-0.37-macos.dmg`

- Drag-to-Applications DMG. Do not ship a zip.
- Developer ID `Russell Sneddon (SFCBP95595)`.
- Do **not** bundle ShearK in the wallet.
- Do **not** recut 0.34. Do **not** set `SHEAR_MAINNET_EMIT`.
- Magic stays `shear-testnet-v4`. The new cut is fingerprint (`POT_SCHED`), not v5.

Key name on this Mac for fleet SSH: `id_ed25519_restore_privacy_eu`. Live VPS:

| Box | IP | Hostname |
|-----|-----|----------|
| shear-pool | `77.42.91.84` | `pool.shear.digital` |
| p2p-a | `157.180.70.110` | `p2p.shear.digital` |
| p2p-b | `2.28.8.89` | `r2r.shear.digital` |
| p2p-c | `178.156.222.223` | `b2b.shear.digital` |

Dedicated-de is dead. Magic stays `shear-testnet-v4`.
