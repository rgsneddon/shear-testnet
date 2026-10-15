#!/bin/sh
# Recompute the spend generator set and check vectors/generators.txt.
# The set is E(H) (the commitment blind), B (spend auth), Blake2b T/U/V,
# and the Selene/Helios points. Prints "pending PA+CA ratification" and the
# digest. Exits 1 when a recomputed point or the digest does not match.
set -eu
cd "$(dirname "$0")/.."
exec cargo run --quiet --release --bin fs1_generators
