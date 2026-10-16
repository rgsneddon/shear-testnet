#!/usr/bin/env bash
# Build the wallet's Linux libshear_admit.so with the GCC unwinder linked
# statically, so no Linux pack needs or ships libgcc_s.so.1
# (docs/licensing-audit.md decision 4). Extra arguments go to cargo build.
#
# rustc links with -nodefaultlibs and then asks for -lgcc_s by name, so
# -static-libgcc alone changes nothing. A linker script named libgcc_s.so,
# first on the search path, answers -lgcc_s with libgcc_eh.a and libgcc.a.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ADMIT="$HERE/admit"
TARGET_DIR="${CARGO_TARGET_DIR:-$ADMIT/target}"
SO="$TARGET_DIR/release/libshear_admit.so"
CC_BIN="${CC:-cc}"

EH="$("$CC_BIN" -print-file-name=libgcc_eh.a)"
GCC_A="$("$CC_BIN" -print-libgcc-file-name)"
for f in "$EH" "$GCC_A"; do
  case "$f" in
    /*) test -f "$f" || { echo "missing $f for $CC_BIN" >&2; exit 1; } ;;
    *) echo "$CC_BIN has no static libgcc ($f)" >&2; exit 1 ;;
  esac
done

SHIM="$TARGET_DIR/static-libgcc"
mkdir -p "$SHIM"
printf 'INPUT(%s %s)\n' "$EH" "$GCC_A" > "$SHIM/libgcc_s.so"

RUSTFLAGS="${RUSTFLAGS:-} -L native=$SHIM" \
  cargo build --release --manifest-path "$ADMIT/Cargo.toml" --target-dir "$TARGET_DIR" "$@"

python3 "$HERE/../../scripts/licenses/release_notices.py" no-gcc-runtime "$SO"
