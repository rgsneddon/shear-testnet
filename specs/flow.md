# continuity-tethered Flow (CTF)

Product name: **continuity-tethered Flow**. Short: **CTF**.

Paid dests need an **independent Closure `C`** from the wallet password (view secret). Do **not** imply `C` from rest-frame `S` (that degenerate path lets anyone with `shear1` scan dests).

## Addresses

| | Form | Share? | On chain? |
|--|------|--------|-----------|
| Rest-frame `S` | `shear1` | Never | Never (`verifyBlock` rejects) |
| Silent ID | `she1` payment code (index 0, 1, 2, …) | Yes | Never |
| Issued dest | `shp1` (round dest + index 0, 1, 2, …) | No | Yes |
| Reserve vault | `shp1` stable (`shear-reserve-v1` root, height 0) | Collator sees dest | Yes |

```
V = password / view secret
C = SHA256(chronoflux-G-v1 || V)
t = SHA256(chronoflux-J-v1 || C || continuity_{h-1} || height)
round dest = shp1(SHA256(chronoflux-J-v1 || S || t)[0:20])
t_n = SHA256(chronoflux-J-n-v1 || C || index u64le)
dest_n = shp1(SHA256(chronoflux-J-v1 || S || t_n)[0:20])
she1_n = she1(SHA256(shear-she1-v2 || scanPub_n || spendPub_n)[0:20])  // short public ID, unlimited
```

Same `(S, C, index)` always regenerates the same `shp1`. Same `(V, S, n)` regenerates `she1`. No cap on index. Miner `--user` is `shp1`. Pool pays dest as-is. Rest-frame `shear1` is never a dest login. she is private.

Password = view key = `shewall.json` seal. Never POST `V`/`C`/`shear1`.

## Memo

Optional on Flow send. Ciphertext opaque on the wire. Public explorer: **memo yes/no only**. Plaintext only in sender and recipient **wallet explorer** tabs. Continuum: **you have a new memo** until opened.

## Vortex

Default vector: **The Reserve**. Add third-party vortice by pasting a creator-issued key (`issueVorticeKey` / `parseVorticeKey`). Third-party vortice cannot mint SHE.
