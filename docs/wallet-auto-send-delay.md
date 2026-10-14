# Wallet automatic-send delay (PrivA §3 residual)

Policy for the wallet. Not consensus. Manual sends are not delayed.

An automatic send is a miner payout sweep or an auto-consolidation. Continuum on Windows and Android, and the `shear` CLI (the node wallet), all go through `ShearLedger`. The node process uses the same distribution in `node/src/wallet_auto_send.js`. Both copies are this constant:

```
qEpochBlocks = 8
weights = [4, 12, 28, 52, 68, 52, 28, 12]
```

`weights[i]` is the number of CSPRNG bytes that select a delay of `i` whole Q-epochs. The weights sum to 256, so one uniform byte `b` in `0..255` maps to exactly one delay: walk the weights until the cumulative sum is greater than `b`.

A Q-epoch is `qEpochBlocks` sealed-tip blocks. `epoch(S) = floor(S / qEpochBlocks)` for a sealed tip `S >= 0`.

When an automatic send is first queued and no hold is stored:

- draw one byte from the OS CSPRNG (tests may supply the byte);
- `epochs = delay(byte)` from the weights above;
- `epochBase = epoch(S)`;
- `releaseEpoch = epochBase + epochs`;
- store `{v: 1, epochBase, epochs, releaseEpoch}` in the wallet session.

The broadcast is allowed only when `epoch(S) >= releaseEpoch`. A later queue reuses the stored hold. It does not draw again. A wallet restart loads the same record. After the automatic broadcast is accepted, the hold is cleared so the next automatic send draws once more.

A manual send never reads, writes, or clears the hold.

The live credit sync on Continuum (Windows and Android) and `shear sync` queue this hold after the tip is known. They do not broadcast. `ShearLedger.send(automatic: true)` is the broadcast: it reuses the hold and posts only when the sealed tip has reached `releaseEpoch`. A manual `send` leaves the hold alone.

RNG failure stores nothing and does not broadcast (`rng_unavailable`). There is no second distribution.
