# Note H and the FS-1 generator pin

Two curve parameters stay fixed. Note H is consensus. The FS-1 generator tree is vendored and not wired into consensus.

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

## FS-1 generator digest

FS-1 membership parameters come from the vendored `generalized-bulletproofs` crate. They are not a consensus generator set. `shear-fs1` is not linked from `shear_admit`.

The pin is `crypto/native/vendor/monero-oxide-77788c3/ADMIT_PIN.json`.

- monero-oxide commit: `77788c368145127f2dde2ac3e2ddce919f3ddd01`
- crypto tree: `6ba344ad5412c103dab278845a8b418886fdd3d5`
- generator crate `generalized-bulletproofs` dirSha256: `fdafff2e1972bdf910b51d6c1d4502c1dc749c1a4c1e42cc92ed9f43495f968d`

dirSha256 is sha256 over the sorted relative paths. Each file is the utf-8 path, a NUL, the length as u64be, then the raw bytes. `crypto/fs1_pin.test.js` recomputes that digest.
