#!/usr/bin/env bash
# Prepare a copy of the repository with the Nevia and Urema font files removed
# from every commit. Great Vibes (fonts/greatvibes/, SIL OFL) stays.
# This rewrites history in a separate mirror clone only. It never pushes.
# Pushing the result is a force-push of every branch and tag and needs
# Russell's explicit GO first; see docs/font-history-removal.md.
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

# Nevia and Urema only. A blanket *.ttf glob would also delete fonts/greatvibes/.
git filter-repo --force --invert-paths \
  --path-glob '*[Nn]evia*.otf' --path-glob '*[Nn]evia*.ttf' \
  --path-glob '*[Nn]evia*.woff' --path-glob '*[Nn]evia*.woff2' \
  --path-glob '*[Nn]evia*.eot' \
  --path-glob '*[Uu]rema*.otf' --path-glob '*[Uu]rema*.ttf' \
  --path-glob '*[Uu]rema*.woff' --path-glob '*[Uu]rema*.woff2' \
  --path-glob '*[Uu]rema*.eot'

left="$(git log --all --name-only --format= | grep -iE '\.(otf|ttf|woff2?|eot)$' | grep -viE '^fonts/greatvibes/' || true)"
if [[ -n "$left" ]]; then
  echo "font paths still present outside fonts/greatvibes/:" >&2
  printf '%s\n' "$left" >&2
  exit 1
fi
git count-objects -vH
echo
echo "Rewrite done in $WORK/shear-testnet.git. Nothing has been pushed."
echo "fonts/greatvibes/ was kept. Only after Russell's GO, and with pushes frozen:"
echo "  cd $WORK/shear-testnet.git && git push --force --mirror $URL"
