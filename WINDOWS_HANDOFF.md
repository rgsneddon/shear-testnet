# Windows pointer — Shear

**Start:** [`HANDOFF_OPS.md`](HANDOFF_OPS.md)

Live pins are always the **latest** clients:

| Client | Pin | Repo |
|--------|-----|------|
| Wallet | **0.35** | this tree, tag [`0.35`](https://github.com/rgsneddon/shear-testnet/releases/tag/0.35) |
| Miner | **ShearK 2.3** | [`rgsneddon/ShearK`](https://github.com/rgsneddon/ShearK/releases/tag/2.3) |

```
gh repo clone rgsneddon/shear-testnet %USERPROFILE%\shear-testnet
cd /d %USERPROFILE%\shear-testnet
git checkout feat/admit-v2
git pull
notepad HANDOFF_OPS.md
```
