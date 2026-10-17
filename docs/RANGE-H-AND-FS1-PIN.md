# Note H and the FS-1 spend-generator pin

Note H is the Pedersen blind. The FS-1 spend digest is the ratified `generators_digest` of the live spend parameters.

## Note H

Pedersen notes and the packed 64-bit range proof use

```
C = v·G + r·H
```

`G` is the ristretto255 base point. `H` is not the RFC 9380 hash-to-curve of a short string.

- Wide hash: `SHA-512("shear-bpplus-v2" || "shear-note-H-v1")`
- Map: ristretto255 `from_uniform_bytes` (RFC 9496)
- Compressed point: `feea2914bda937d74acc1efa93bf1094f65ae709628a7aad9d1b913b6c80c301`

`crypto/note.js` `consensusNoteH`, native `noteH()`, and `h_note` in `crypto/native/admit/src/bpplus.rs` are this point. A change to the domain, the map, or these 32 bytes is a consensus change.

`E` maps that compressed point onto Ed25519. `E(H)` is the spend proof's commitment blind. It is not these 32 ristretto bytes.

## FS-1 spend-generator digest

`generators_digest` is Blake2b-512 over the domain `shear-fs1-generators-v1` and then every compressed point, in this order:

1. `E(H)`, the proof's `G`
2. `B`, the Ed25519 basepoint
3. `T`, `U`, `V`
4. Selene `g`, `h`, `init`, every `g_bold`, every `h_bold`
5. Helios `g`, `h`, `init`, every `g_bold`, every `h_bold`

The ratified spend digest is

```text
4aab173c8065e7e5cff88945399b98cbbb51f647297231d09cb069c82f965288eaaf3ecb9ea88ae4e3de1dde2623710fe5e4f4353c529ef613fac9ff8b0699e6
```

That value is §1.5 of `specs/100c.md` and the `digest` line of `crypto/native/vendor/monero-oxide-77788c3/shear-fs1/vectors/generators.txt`. `crypto/range_packed.test.js` checks this file, that vector, and the spec against one constant.
