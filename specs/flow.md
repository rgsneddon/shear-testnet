# continuity-tethered Flow (CTF)

Product name: **continuity-tethered Flow**. Short: **CTF**.

Paid dests need an **independent Closure `C`** from the wallet password (view secret). Do **not** imply `C` from rest-frame `S` (that degenerate path lets anyone with `shear1` scan dests).

## Addresses

| | Form | Share? | On chain? |
|--|------|--------|-----------|
| Rest-frame `S` | `shear1` | Never | Never (`verifyBlock` rejects) |
| Silent ID | `she1` full payment code (version \|\| X25519 scanPub \|\| Ed25519 spendPub) | Yes — copy this | Never on chain |
| Fingerprint | short 20-byte `she1` display | Display only; not sufficient to pay | Never |
| Issued dest | one-time `ssa1` from ECDH (`shear-silent-v1`) | No | Yes |
| Reserve vault | `ssa1` stable (`shear-reserve-v1` root, height 0) | Clustering beacon | Yes; not a Flow or mining dest |

```
V = password / view secret (never on the book)
full she1 = she1(version || scanPub || spendPub)
short she1 = she1(SHA256(shear-she1-v2 || scanPub || spendPub)[0:20])  // display only
sender eph = fresh X25519
shared = X25519(eph, scanPub)
dest20 = SHA256(shear-silent-v1 || shared || spendMix)[0:20]
vout dest = ssa1(dest20)
```

Two pays to one published code produce two dests. An observer with only the short fingerprint cannot compute either dest. `payoutDest(she1)` is not payable. Miner login is `ssa1.worker` (a dest the wallet exported). `she1` login is an in-memory alias that must resolve to an owned rotating `ssa1` and is never written to disk. The public pool learns whatever you type into stratum; a solo node is the anonymity path for miners. Amounts stay public. Rest-frame `shear1` is never a dest login. she is private.

Password = view key = `shewall.bin` seal. Never POST `V`/`C`/`shear1`.

## Memo

Optional on Flow send. Key is `SHA256(shear-memo-v1 || ECDH shared secret)` for that dest. No dest-only fallback; no memo without a shared secret. Public explorer: amounts, dests, **memo yes/no only**. No memoCt, no memoPlain. Owner wallets decrypt locally after scan.

## Vortex

Default vector: **The Reserve**. Third-party vortice are hosted by their creators, not by the Shear node. A creator mints a `vort1.` deploy key on the node (`mintVorticeDeployKey`). That key names the origin URL and pins a hash of the hosted bytes. Users must paste the deploy key in Vortex; the wallet then fetches that origin, checks the hash, and deploys the dapp. No catalog browse, no enable without the key. Third-party vortice cannot mint SHE.
