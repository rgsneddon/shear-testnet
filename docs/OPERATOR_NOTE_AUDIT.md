# Operator note — feat/audit-feasible-now

Workstream IDs in this branch (A1–E):

- **A1** Stratum auth on in prod example; dest-only rejected when auth on (`test_audit_hardening.js`).
- **A2** Bind `127.0.0.1` in prod sample; nginx TLS sample; cleartext warning on pool UI/stats.
- **A3** Tip-reset lost-work metric (`lostWorkHashes`).
- **A4** Open-share fingerprint dedup; dest-persisted vardiff; busy/reject budget.
- **A5** Withdraw audit log (`admin-audit.jsonl`).
- **A6** Folded `proven_*` matches dest sum.
- **A7** `alerts.concentration` / `alerts.shareBlock` on `/api/stats`.
- **B1** Trusted skip-pow unreachable from P2P.
- **B2** MAX_PEERS + DEFAULT_SEEDS match docs.
- **B3** ADMITv1 grep CI; native pin file; zero-challenge still reject.
- **B4** Emit requires `SHEAR_MAINNET_EMIT=1` **and** `SHEAR_MAINNET_EMIT_CONFIRM=I_UNDERSTAND_SHEAR_MAINNET`. Defaults unset.
- **C1–C4** Refuse plaintext session; POST-only viewKey; Dart ADMITv1 quarantined; prove temp wiped; wallet **0.36** / ShearK **≥ 2.4**.
- **D1–D5** Apex `/docs/`; 0.36 / 2.4 pins; unpublished dmg hidden; explorer vhost; cleartext warning; stale 0.34/2.2 scrubbed from primary CTAs.
- **E** ShearK banner 2.4.

Also in this branch (post-audit book law):

- Epoch pot: 1.00 → −0.01 / epoch → 0.20 floor; testnet 4d / mainnet 400d; fingerprinted.
- Hash-bonus unit never 0 (`HASH_UNIT_FLOOR=1`).
- Public pool auto-pays π SHE to miner `ssa1` (pool dest signs; hash bonus fee-free; 1% only on pot). Wallet pull deprecated (410).

## Still human ops (not faked)

- `docs.shear.digital` SAN/vhost is retired in public nav: href `https://shear.digital/docs/` only. Ops may DNS-retire the `docs.` name; do not invent a cert in-repo.
- Fleet binary rollout + **datadir wipe** for the new fingerprint (`/var/lib/shear/testnet-v4*`).
- Second physical pool / extra hashrate.
- External ADMIT/BP+ audit engagement.
- `SHEAR_MAINNET_EMIT` decision — **do not set**. Double-key still required. Launch date is not decided.
- macOS `.dmg` for wallet 0.36 (MacBook / HANDOFF §6b). Android APK was packed on Windows.
