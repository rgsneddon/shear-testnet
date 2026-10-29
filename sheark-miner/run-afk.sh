#!/bin/bash
set -euo pipefail
# shellcheck disable=SC1091
. /etc/default/sheark-v4-afk
# PR146: jit-full by default; the miner drops to light jit when the unit's
# MemoryMax (cgroup) or the host's free memory is short. --threads only when
# SHEARK_THREADS is a positive number; otherwise the miner chooses (CPUs,
# cgroup CPU quota, L3, one CPU left free on a desktop).
args=(
  --pool "${SHEARK_POOL:?}"
  --user "${SHEARK_USER:?}"
  --blu "${SHEARK_BLU:?}"
  --backend "${SHEARK_BACKEND:-jit-full}"
)
threads=${SHEARK_THREADS:-}
if [[ "$threads" =~ ^[0-9]+$ ]] && [ "$threads" -ge 1 ]; then
  args+=(--threads "$threads")
fi
exec /opt/shear-v4/sheark-miner/ShearK-Miner "${args[@]}" --require-tls
