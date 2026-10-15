#!/bin/bash
# Build Shear Sentinel v19, the wallet, and ShearK 2.9 inside one distro image.
# rustup update stable is required: zeroize 1.9 uses Rust edition 2024.
set -euo pipefail

DISTRO="${SHEAR_DISTRO:?SHEAR_DISTRO is required}"
SRC="${SHEAR_SRC:-/src}"
PREFIX="${SHEAR_PREFIX:-/opt/shear-v12}"
OUT="${SHEAR_OUT:-/out}"
NODE_VERSION="${SHEAR_NODE_VERSION:-22.23.3}"
NODE_SHA256="${SHEAR_NODE_SHA256:-df450af89261115ef9f9e3830c3eeb2cc9213b63c720b1af623cb5dcbe2e02de}"
FLUTTER_VERSION="${SHEAR_FLUTTER_VERSION:-3.47.7}"
FLUTTER_SHA256="${SHEAR_FLUTTER_SHA256:-af7455f540df951184c7953fbe3cf884766e7541dacf8571f9f582db03dd6230}"
JOBS="${SHEAR_JOBS:-2}"
export SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-1700000000}"
export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-1}"
export CI=true
export PATH="/usr/local/bin:/root/.cargo/bin:${PATH}"

log() { printf '== %s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

log "distro ${DISTRO}"
cat /etc/os-release

if ! command -v rustup >/dev/null 2>&1; then
  log "install rustup"
  curl --proto '=https' --tlsv1.2 -fsSL https://sh.rustup.rs | sh -s -- -y --default-toolchain none
  # shellcheck disable=SC1091
  . /root/.cargo/env
fi
log "rustup update stable"
rustup update stable
rustup default stable
rustc --version
rustc --version > /tmp/shear-rustc.txt

log "node ${NODE_VERSION}"
curl -fsSL -o /tmp/node.tar.xz "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz"
echo "${NODE_SHA256}  /tmp/node.tar.xz" | sha256sum -c -
tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1
hash -r
node --version
test -f /usr/local/include/node/node_api.h

if ! id builder >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash builder
fi
log "flutter ${FLUTTER_VERSION}"
curl -fsSL -o /tmp/flutter.tar.xz \
  "https://storage.googleapis.com/flutter_infra_release/releases/stable/linux/flutter_linux_${FLUTTER_VERSION}-stable.tar.xz"
echo "${FLUTTER_SHA256}  /tmp/flutter.tar.xz" | sha256sum -c -
rm -rf /usr/local/flutter
tar -xJf /tmp/flutter.tar.xz -C /usr/local
chown -R builder:builder /usr/local/flutter /src/wallet
install -d -o builder -g builder /home/builder
cat > /usr/local/bin/as-builder << 'EOF'
#!/bin/bash
set -euo pipefail
export HOME=/home/builder
export PATH="/usr/local/flutter/bin:/usr/local/bin:${PATH}"
export PUB_CACHE=/home/builder/.pub-cache
export CI=true
export FLUTTER_SUPPRESS_ANALYTICS=true
cd /src/wallet
exec "$@"
EOF
chmod 755 /usr/local/bin/as-builder
su -s /bin/bash builder -c 'git config --global --add safe.directory /usr/local/flutter'
su -s /bin/bash builder -c '/usr/local/bin/as-builder flutter config --no-analytics --enable-linux-desktop'
su -s /bin/bash builder -c '/usr/local/bin/as-builder flutter --version'
su -s /bin/bash builder -c '/usr/local/bin/as-builder dart --version'

log "npm ci --ignore-scripts"
cd "${SRC}"
npm ci --no-audit --no-fund --ignore-scripts

log "randomx"
RX="${SRC}/crypto/randomx"
rm -rf "${RX}/build"
cmake -S "${RX}" -B "${RX}/build" -DCMAKE_BUILD_TYPE=Release -DARCH=default
cmake --build "${RX}/build" -j"${JOBS}"
test -f "${RX}/build/librandomx.a"

log "ShearK miner"
make -C "${SRC}/sheark-miner" -j"${JOBS}"
bash "${SRC}/sheark-miner/pack/selftest.sh" "${SRC}/sheark-miner/ShearK-Miner"

log "native addons"
cargo build --release --locked --manifest-path "${SRC}/crypto/native/admit/Cargo.toml"
make -C "${SRC}/crypto/native" shearhash.node shearadmit.node
test -f "${SRC}/crypto/native/shearhash.node"
test -f "${SRC}/crypto/native/shearadmit.node"
node -e 'const r=require("module").createRequire("/src/package.json"); const h=r("/src/crypto/native/shearhash.node"); const a=r("/src/crypto/native/shearadmit.node"); if (typeof h.hash!=="function"||typeof a.noteH!=="function") process.exit(1); console.log("built", h.backend());'

log "wallet CLI"
su -s /bin/bash builder -c '/usr/local/bin/as-builder flutter pub get --enforce-lockfile'
# dart compile exe refuses packages that ship build hooks (objective_c via jni).
# dart build cli runs those hooks and emits a standalone binary.
su -s /bin/bash builder -c '/usr/local/bin/as-builder dart build cli'
CLI_BIN="$(find /src/wallet/build/cli -type f -name shear | head -n 1 || true)"
if [ -z "${CLI_BIN}" ]; then
  find /src/wallet/build -print >&2 || true
  echo "dart build cli did not produce a shear binary" >&2
  exit 1
fi
"${CLI_BIN}" version
cp -a "${CLI_BIN}" /tmp/shear-cli
chmod 755 /tmp/shear-cli
if ldd /tmp/shear-cli | grep -q 'not found'; then
  ldd /tmp/shear-cli >&2 || true
  echo "wallet CLI is missing libraries after it is copied out of the bundle" >&2
  exit 1
fi

if [ "${SHEAR_PACK_DESKTOP:-1}" = "1" ]; then
  log "wallet desktop"
  su -s /bin/bash builder -c '/usr/local/bin/as-builder flutter build linux --release'
  test -x "${SRC}/wallet/build/linux/x64/release/bundle/shear_wallet"
fi

log "stage packs"
export SHEAR_DISTRO SHEAR_SRC="${SRC}" SHEAR_PREFIX="${PREFIX}" SHEAR_OUT="${OUT}"
python3 "${SRC}/scripts/packaging/stage_packs.py"

{
  echo "distro=${DISTRO}"
  echo "os=$(. /etc/os-release && printf '%s %s' "$NAME" "$VERSION")"
  echo "rustc=$(cat /tmp/shear-rustc.txt)"
  echo "node=$(node --version)"
  echo "flutter=${FLUTTER_VERSION}"
  echo "desktop=${SHEAR_PACK_DESKTOP:-1}"
  echo "source_date_epoch=${SOURCE_DATE_EPOCH}"
} > "${OUT}/BUILDINFO.txt"
cat "${OUT}/BUILDINFO.txt"

log "drop toolchains from the image"
rm -rf /usr/local/flutter /home/builder/.pub-cache /root/.cargo /root/.rustup /root/.npm \
  "${SRC}/crypto/randomx/build" "${SRC}/crypto/native/admit/target" \
  "${SRC}/node_modules" "${SRC}/wallet/build" "${SRC}/wallet/.dart_tool" \
  /tmp/flutter.tar.xz /tmp/node.tar.xz
log "build-inside done ${DISTRO}"
