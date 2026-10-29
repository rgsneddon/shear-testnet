#!/bin/bash
# Unpack a unix zip away from the build tree and prove the bundled OpenSSL loads.
set -euo pipefail
ZIP=${1:?zip}
DIR=$(mktemp -d)
python3 -m zipfile -e "$ZIP" "$DIR"
test -f "$DIR/ShearK-Miner"
test -f "$DIR/example.bat"
test -f "$DIR/example.sh"
shopt -s nullglob
ssl=("$DIR"/libssl*)
crypto=("$DIR"/libcrypto*)
sodium=("$DIR"/libsodium*)
test "${#ssl[@]}" -ge 1
test "${#crypto[@]}" -ge 1
# R28: the BluNotes share keys need the bundled libsodium.
test "${#sodium[@]}" -ge 1
grep -q 'ShearK-Miner-2.9-windows.zip' "$DIR/example.bat"
grep -q 'stratum+ssl://pool.shear.digital:443' "$DIR/example.bat"
grep -q 'stratum+ssl://pool.shear.digital:443' "$DIR/example.sh"
chmod +x "$DIR/ShearK-Miner" "$DIR/example.sh"
HEAD=$(python3 -c 'import sys; print(open(sys.argv[1],"rb").read(4).hex())' "$DIR/ShearK-Miner")
case "$HEAD" in
  7f454c46*) ;;
  feedface*|feedfacf*|cafebabe*|cefaedfe*|cffaedfe*|bebafeca*) ;;
  *) echo "refusing binary magic $HEAD" >&2; exit 1 ;;
esac
case "$(uname -s)" in
  Linux)
    ldd "$DIR/ShearK-Miner" | grep libssl | grep -q "$DIR"
    ldd "$DIR/ShearK-Miner" | grep libcrypto | grep -q "$DIR"
    ldd "$DIR/ShearK-Miner" | grep libsodium | grep -q "$DIR"
    ;;
  Darwin)
    otool -L "$DIR/ShearK-Miner" | grep libssl | grep -q '@executable_path/'
    otool -L "$DIR/ShearK-Miner" | grep libcrypto | grep -q '@executable_path/'
    otool -L "$DIR/ShearK-Miner" | grep libsodium | grep -q '@executable_path/'
    ;;
esac
( cd "$DIR" && ./ShearK-Miner --selftest ) | tee "$DIR/selftest.out"
# R40: the FIPS 180-4 key gives this digest.
grep -q "selftest ok e9e9dee13e2240383e0bdfb65ae962f52d9962a2e3bebd7623d418464ceb8cd4" "$DIR/selftest.out"
