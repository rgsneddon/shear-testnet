# Shear wallet 0.31

Testnet wallet. Tabs: Continuum, Flow, Resistance, Vortex, Shearview, Closure. The Reserve lives under Vortex.

Backup file: encrypted `shewall.bin`. Offer `she1` when someone pays you. Incoming coin lands on a revolving `ssa1` dest. Rest-frame `shear1` stays in Closure.

Mine with **Copy dest**: log ShearK in as `ssa1.worker`. Each hasher dest that produced proven work receives its own hash bonus on the next sealed block. The 1 SHE pot is split among those dests.

Pool: `pool.shear.digital:1111`.

Continuum is spendable, pending transfers until six confirmations, and Copy ID. Already-confirmed SHE loads from the pool on unlock. Open-round hashes stay pending until the next sealed block. Shearview is confirmed transfers; tap a tx for its CTF printout on Resistance. This wallet does not mine.
