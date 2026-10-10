#!/bin/bash
set -euo pipefail
# shellcheck disable=SC1091
. /etc/default/sheark-v4-afk
threads=${SHEARK_THREADS:-1}
if [ "$threads" -lt 1 ]; then threads=1; fi
exec /opt/shear-v4/sheark-miner/ShearK-Miner \
  --pool "${SHEARK_POOL:?}" \
  --user "${SHEARK_USER:?}" \
  --backend "${SHEARK_BACKEND:-jit}" \
  --threads "$threads" \
  --require-tls
