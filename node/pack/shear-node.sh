#!/bin/sh
# Portable Shear node. Same entry as `node node/src/node.js`.
set -e
ROOT="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
# Fedora's node is a small binary that needs libnode.so beside it.
export LD_LIBRARY_PATH="$ROOT/runtime${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
if [ -x "$ROOT/runtime/node" ] && "$ROOT/runtime/node" -v >/dev/null 2>&1; then
  NODEBIN="$ROOT/runtime/node"
elif [ -x "$ROOT/runtime/node.exe" ]; then
  NODEBIN="$ROOT/runtime/node.exe"
else
  NODEBIN="${NODEBIN:-node}"
fi
export SHEAR_DATA="${SHEAR_DATA:-$HOME/.shear/testnet-v10}"
export SHEAR_NETWORK="${SHEAR_NETWORK:-shear-testnet-v10}"
export SHEAR_SEEDS="${SHEAR_SEEDS:-p2p.shear.digital:30303,r2r.shear.digital:30303,b2b.shear.digital:30303}"
export SHEAR_RPC_BIND="${SHEAR_RPC_BIND:-127.0.0.1}"
cd "$ROOT"
echo "Shear Sentinel v17"
exec "$NODEBIN" "$ROOT/node/src/node.js" "$@"
