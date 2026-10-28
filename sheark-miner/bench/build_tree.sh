#!/usr/bin/env bash
# R41: build ShearK-Miner and rxbench in a checkout, the way the packs build
# (x86-64 baseline, static GCC runtime). rxbench.c may come from another tree,
# so one bench drives both the base and the optimised objects.
#   build_tree.sh TREE [RXBENCH_C]
# Env: JOBS (default nproc), SODIUM_PREFIX (a local libsodium, optional).
set -euo pipefail
T=$(cd "$1" && pwd)
RXB=${2:-$T/sheark-miner/bench/rxbench.c}
JOBS=${JOBS:-$(nproc)}
M=$T/sheark-miner
cd "$T"
mk=(make -C sheark-miner CC=gcc CXX=g++ -j"$JOBS")
[ -n "${SODIUM_PREFIX:-}" ] && mk+=(SODIUM_PREFIX="$SODIUM_PREFIX")
"${mk[@]}"
mkdir -p "$M/bench"
case "$(uname -m)" in x86_64) BASE="-march=x86-64 -mtune=generic" ;; *) BASE="" ;; esac
DEF=""
grep -q shear_hash_hard_aes "$M/src/shear_hash.h" && DEF="-DRXBENCH_HAVE_HARD_AES"
gcc $BASE -O3 -Wall -Wextra -std=c11 -pthread $DEF -I"$M/src" -I"$T/crypto/randomx/src" -c -o "$M/bench/rxbench.o" "$RXB"
g++ $BASE -O3 -pthread -o "$M/bench/rxbench" "$M/bench/rxbench.o" "$M/src/shear_hash.o" "$M/src/sha256.o" "$M/src/sha512.o" \
  "$T/crypto/randomx/build/librandomx.a" -lm -static-libgcc -static-libstdc++
# R41 trees: a second rxbench whose shear_hash.c hides hardware AES, so the
# soft-AES path (CPUs without AES-NI or ARMv8 AES) meets the golden corpus here.
if [ -n "$DEF" ]; then
  gcc $BASE -O3 -Wall -Wextra -std=c11 -pthread -DSHEARK_TEST_SOFT_AES -I"$M/src" -I"$T/crypto/randomx/src" \
    -c -o "$M/bench/shear_hash_softaes.o" "$M/src/shear_hash.c"
  g++ $BASE -O3 -pthread -o "$M/bench/rxbench-softaes" "$M/bench/rxbench.o" "$M/bench/shear_hash_softaes.o" "$M/src/sha256.o" "$M/src/sha512.o" \
    "$T/crypto/randomx/build/librandomx.a" -lm -static-libgcc -static-libstdc++
fi
# micro: the miner's per-hash additions (shear_key, BluNotes keys and binding).
SINC=""; SLIB=""
[ -n "${SODIUM_PREFIX:-}" ] && SINC="-I$SODIUM_PREFIX/include" && SLIB="-L$SODIUM_PREFIX/lib/x86_64-linux-gnu -L$SODIUM_PREFIX/lib"
gcc $BASE -O3 -Wall -Wextra -std=c11 -pthread $SINC -I"$M/src" -c -o "$M/bench/micro.o" "$(dirname "$RXB")/micro.c"
g++ $BASE -O3 -pthread -o "$M/bench/micro" "$M/bench/micro.o" "$M/src/shear_hash.o" "$M/src/sha256.o" "$M/src/sha512.o" "$M/src/blunote.o"   "$T/crypto/randomx/build/librandomx.a" $SLIB -lsodium -lm -static-libgcc -static-libstdc++
# The node addon (it compiles this tree's shear_hash.c): the loopback pool
# verifies shares in-process with it, as the live pool does, instead of
# spawning ShearK-Miner --verify per share.
make -C crypto/native shearhash.node CC=gcc
echo "built $M/ShearK-Miner and $M/bench/rxbench at $(git -C "$T" rev-parse --short HEAD)"
