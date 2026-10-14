#!/bin/sh
# Recompute every FS-1 generator from its domain-separated label and check
# vectors/generators.txt. Prints "pending PA+CA ratification" and the digest.
# Exits 1 when a recomputed point or the digest does not match.
set -eu
cd "$(dirname "$0")/.."
exec cargo run --quiet --release --bin fs1_generators
