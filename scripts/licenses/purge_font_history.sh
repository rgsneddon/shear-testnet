#!/usr/bin/env bash
# Prepare a copy of the repository with the Nevia and Urema font files removed
# from every commit. This rewrites history in a separate mirror clone only. It
# never pushes. Pushing the result is a force-push of every branch and tag and
# needs Russell's explicit GO first; see docs/font-history-removal.md.
#
# usage: scripts/licenses/purge_font_history.sh WORKDIR [REMOTE_URL]
set -euo pipefail
WORK="${1:?usage: purge_font_history.sh WORKDIR [REMOTE_URL]}"
URL="${2:-https://github.com/rgsneddon/shear-testnet.git}"
command -v git-filter-repo >/dev/null || { echo "install git-filter-repo first (pip install git-filter-repo)" >&2; exit 1; }
[[ ! -e "$WORK" ]] || { echo "$WORK already exists; use a fresh directory" >&2; exit 1; }

git clone --mirror "$URL" "$WORK/shear-testnet.git"
cd "$WORK/shear-testnet.git"

git log --all --name-only --format= | grep -iE '\.(otf|ttf|woff2?|eot)$' | sort -u > ../fonts-before.txt
echo "font paths in history: $(wc -l < ../fonts-before.txt) (list in $WORK/fonts-before.txt)"

git filter-repo --force --invert-paths \
  --path-glob '*.otf' --path-glob '*.ttf' --path-glob '*.woff' \
  --path-glob '*.woff2' --path-glob '*.eot'

left="$(git log --all --name-only --format= | grep -icE '\.(otf|ttf|woff2?|eot)$' || true)"
[[ "$left" == "0" ]] || { echo "font paths still present after rewrite: $left" >&2; exit 1; }
git count-objects -vH
echo
echo "Rewrite done in $WORK/shear-testnet.git. Nothing has been pushed."
echo "Only after Russell's GO, and with pushes frozen:"
echo "  cd $WORK/shear-testnet.git && git push --force --mirror $URL"
