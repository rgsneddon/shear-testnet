#!/usr/bin/env bash
# Copy the licensed Nevia and Urema webfonts into each site's brand/fonts/
# at deploy time. The fonts are not in git (see docs/licensing-audit.md,
# decision 1); they come from Shear's purchased licence package, which must
# be unpacked outside the repository with this layout:
#
#   $SHEAR_FONTS_DIR/nevia/woff2/Nevia-{Light,LightCondensed,Regular,ExtraBold,ExtraBoldCondensed,Black}.woff2
#   $SHEAR_FONTS_DIR/urema/woff2/Urema-Variable.woff2
#
# Only the WOFF2 webfonts are deployed, as the webfont licence covers
# self-hosting on Shear's own sites. Desktop formats (.otf/.ttf) are never copied.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="${SHEAR_FONTS_DIR:?set SHEAR_FONTS_DIR to the unpacked licensed font package}"

FILES=(
  nevia/woff2/Nevia-Light.woff2
  nevia/woff2/Nevia-LightCondensed.woff2
  nevia/woff2/Nevia-Regular.woff2
  nevia/woff2/Nevia-ExtraBold.woff2
  nevia/woff2/Nevia-ExtraBoldCondensed.woff2
  nevia/woff2/Nevia-Black.woff2
  urema/woff2/Urema-Variable.woff2
)
SITES=(brand site/brand site/boot/brand explorer/brand mempool/brand pool/public/brand team/brand)

for f in "${FILES[@]}"; do
  [[ -f "$SRC/$f" ]] || { echo "install_fonts: missing $SRC/$f" >&2; exit 1; }
done

for site in "${SITES[@]}"; do
  for f in "${FILES[@]}"; do
    install -D -m 0644 "$SRC/$f" "$ROOT/$site/fonts/$f"
  done
done

if git -C "$ROOT" ls-files --error-unmatch -- '*.woff2' >/dev/null 2>&1; then
  echo "install_fonts: font files are tracked by git; refusing" >&2
  exit 1
fi
echo "install_fonts_ok ${#SITES[@]} sites x ${#FILES[@]} fonts (git-ignored)"
