# continuity-tethered Flow (CTF)

Product name: **continuity-tethered Flow**. Short: **CTF**.

Paid dests need an **independent Closure `C`** from the wallet password (view secret). Do **not** imply `C` from rest-frame `S` (that degenerate path lets anyone with `shear1` scan dests).

## Addresses

| | Form | Share? | On chain? |
|--|------|--------|-----------|
| Rest-frame `S` | `shear1` | Never | Never (`verifyBlock` rejects) |
| Issued dest | `she1` (index 0, 1, 2, …) | Yes | Yes |
| Legacy dest | `sdcard1` | Yes | Yes (accepted, not issued) |
| Reserve vault | `she1` stable (`shear-reserve-v1` root, height 0) | Collator sees dest | Yes |

```
V = password / view secret
C = SHA256(chronoflux-G-v1 || V)
t_n = SHA256(chronoflux-J-n-v1 || C || index u64le)
dest_n = she1(SHA256(chronoflux-J-v1 || S || t_n)[0:20])
```

Same `(S, C, index)` always regenerates the same `she1`. No cap on `index`. Miner `--user` is `she1` (or still `sdcard1`). Pool pays login as-is. Rest-frame `shear1` is never a dest login.

Password = view key = `shewall.json` seal. Never POST `V`/`C`/`shear1`.

## Memo

Optional on Flow send. Ciphertext opaque on the wire. Public explorer: **memo yes/no only**. Plaintext only in sender and recipient **wallet explorer** tabs. Continuum: **you have a new memo** until opened.

## Vortex

Default vector: **The Reserve**. Add third-party vortice by pasting a creator-issued key (`issueVorticeKey` / `parseVorticeKey`). Third-party vortice cannot mint SHE.
