#!/bin/bash
# Build every distro pack and run its smoke test.
# Writes tarballs and SHA256SUMS under scripts/packaging/out/ (gitignored).
# Does not tag, deploy, SSH, or cut genesis.
set -euo pipefail

ROOT="$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)"
cd "${ROOT}"
OUT="${ROOT}/scripts/packaging/out"
mkdir -p "${OUT}"

if docker info >/dev/null 2>&1; then
  DOCKER=(docker)
elif sudo docker info >/dev/null 2>&1; then
  DOCKER=(sudo docker)
else
  echo "docker is not running" >&2
  exit 1
fi

DISTROS=(ubuntu debian fedora opensuse)
if [ "$#" -gt 0 ]; then
  DISTROS=("$@")
fi

for distro in "${DISTROS[@]}"; do
  case "${distro}" in
    ubuntu|debian|fedora|opensuse) ;;
    *)
      echo "unknown distro: ${distro}" >&2
      exit 1
      ;;
  esac
  log="${OUT}/${distro}-build.log"
  smoke="${OUT}/${distro}-smoke.log"
  echo "build ${distro} -> ${log}"
  "${DOCKER[@]}" build \
    -f "scripts/packaging/Dockerfile.${distro}" \
    -t "shear-v12-pack:${distro}" \
    . | tee "${log}"
  echo "smoke ${distro} -> ${smoke}"
  "${DOCKER[@]}" run --rm "shear-v12-pack:${distro}" | tee "${smoke}"
  rm -rf "${OUT}/${distro}"
  mkdir -p "${OUT}/${distro}"
  cid="$("${DOCKER[@]}" create "shear-v12-pack:${distro}")"
  "${DOCKER[@]}" cp "${cid}:/out/." "${OUT}/${distro}/"
  "${DOCKER[@]}" rm "${cid}" >/dev/null
  (
    cd "${OUT}/${distro}"
    sha256sum -c SHA256SUMS
  )
done

{
  for distro in "${DISTROS[@]}"; do
    while IFS= read -r line; do
      printf '%s  %s/%s\n' "$(printf '%s' "$line" | awk '{print $1}')" "${distro}" "$(printf '%s' "$line" | awk '{print $2}')"
    done < "${OUT}/${distro}/SHA256SUMS"
  done
} > "${OUT}/SHA256SUMS"
echo "wrote ${OUT}/SHA256SUMS"
cat "${OUT}/SHA256SUMS"
