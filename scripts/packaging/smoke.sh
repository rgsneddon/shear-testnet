#!/bin/bash
# In-image smoke: node --version, ShearK self-test, wallet CLI, native addons.
set -euo pipefail
fail() { echo "SMOKE FAIL: $*" >&2; exit 1; }

echo "SMOKE distro=${SHEAR_DISTRO:-unknown}"
if [ -f /etc/os-release ]; then
  cat /etc/os-release
fi

command -v node >/dev/null 2>&1 || fail "node is not on PATH"
node --version
node --version | grep -q '^v22\.' || fail "expected Node 22"

echo "SMOKE miner self-test"
SELF=$(ShearK-Miner --selftest 2>&1) || fail "ShearK-Miner --selftest exited $?"
printf '%s\n' "$SELF"
printf '%s\n' "$SELF" | grep -q 'e9e9dee13e2240383e0bdfb65ae962f52d9962a2e3bebd7623d418464ceb8cd4' \
  || fail "ShearHash-v3 digest missing"
if printf '%s\n' "$SELF" | grep -q '5d00a24233609829e59d6e83d9fcd2f262c4014e772a23024fd3db4e66ee2066'; then
  fail "v1 digest must not pass"
fi

echo "SMOKE wallet CLI"
WALLET=$(shear version 2>&1) || fail "shear version exited $?"
printf '%s\n' "$WALLET"
printf '%s\n' "$WALLET" | grep -q 'Shear wallet 0.72' || fail "wallet pin is not 0.72"
printf '%s\n' "$WALLET" | grep -q 'shear-testnet-v12' || fail "wallet magic is not shear-testnet-v12"

echo "SMOKE node print-config"
CFG=$(node /opt/shear-v12/node/src/node.js --print-config 2>/tmp/shear-node-stderr) || fail "print-config exited $?"
printf '%s\n' "$CFG"
printf '%s\n' "$CFG" | grep -q 'Shear Sentinel v19' || fail "display is not Shear Sentinel v19"
printf '%s\n' "$CFG" | grep -q 'shear-testnet-v12' || fail "node magic is not shear-testnet-v12"
if [ -s /tmp/shear-node-stderr ]; then
  echo "SMOKE print-config stderr:"
  cat /tmp/shear-node-stderr
fi

echo "SMOKE native addons"
node --input-type=module -e '
import { createRequire } from "node:module";
import { hashBackendKind } from "/opt/shear-v12/crypto/shear_hash.js";
const require = createRequire("/opt/shear-v12/package.json");
const hash = require("/opt/shear-v12/crypto/native/shearhash.node");
const admit = require("/opt/shear-v12/crypto/native/shearadmit.node");
if (typeof hash.hash !== "function" || typeof hash.backend !== "function") {
  console.error("shearhash exports", Object.keys(hash));
  process.exit(2);
}
if (typeof admit.noteH !== "function" || typeof admit.verify !== "function") {
  console.error("shearadmit exports", Object.keys(admit));
  process.exit(3);
}
const backend = hash.backend();
if (typeof backend !== "string" || backend.length === 0) process.exit(4);
if (hashBackendKind() !== "native") {
  console.error("hashBackendKind", hashBackendKind());
  process.exit(5);
}
console.log("addons ok", backend);
' || fail "native addons"

if [ "${SHEAR_PACK_DESKTOP:-1}" = "1" ]; then
  test -x /opt/shear-v12/wallet-desktop/shear_wallet || fail "desktop shear_wallet missing"
  if ldd /opt/shear-v12/wallet-desktop/shear_wallet | grep -q 'not found'; then
    ldd /opt/shear-v12/wallet-desktop/shear_wallet >&2 || true
    fail "desktop shear_wallet has missing libraries"
  fi
  echo "SMOKE desktop binary ok"
fi

echo "SMOKE OK ${SHEAR_DISTRO:-unknown}"
