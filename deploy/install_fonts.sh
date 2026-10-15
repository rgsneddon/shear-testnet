#!/usr/bin/env bash
# Copy webfonts into the sites.
#
# Great Vibes (SIL OFL 1.1) is committed at fonts/greatvibes/ as the live
# great-vibes.css and its six greatvibes-*.woff2 files. The TTF is not
# referenced, so it is not shipped. The directory is copied to each site as
# /fonts/greatvibes/. .gitignore keeps that source tracked.
#
# Nevia and Urema are not in git (see docs/licensing-audit.md, decision 1).
# They come from Shear's purchased licence package, unpacked outside the
# repository, and are copied only when SHEAR_FONTS_DIR is set:
#
#   $SHEAR_FONTS_DIR/nevia/woff2/Nevia-{Light,LightCondensed,Regular,ExtraBold,ExtraBoldCondensed,Black}.woff2
#   $SHEAR_FONTS_DIR/urema/woff2/Urema-Variable.woff2
#
# Only those WOFF2 webfonts are deployed. Desktop formats (.otf/.ttf) of the
# commercial faces are never copied.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

GV_SRC="$ROOT/fonts/greatvibes"
GV_FILES=(
  OFL.txt
  great-vibes.css
  greatvibes-RWmMoKWR9v4ksMfaWd_JN9XIiaQ6DQ.woff2
  greatvibes-RWmMoKWR9v4ksMfaWd_JN9XBiaQ6DQ.woff2
  greatvibes-RWmMoKWR9v4ksMfaWd_JN9XJiaQ6DQ.woff2
  greatvibes-RWmMoKWR9v4ksMfaWd_JN9XKiaQ6DQ.woff2
  greatvibes-RWmMoKWR9v4ksMfaWd_JN9XLiaQ6DQ.woff2
  greatvibes-RWmMoKWR9v4ksMfaWd_JN9XFiaQ.woff2
)
for name in "${GV_FILES[@]}"; do
  [[ -f "$GV_SRC/$name" ]] || { echo "install_fonts: fonts/greatvibes/$name is missing" >&2; exit 1; }
done

GV_SITES=(site site/boot explorer mempool pool/public team)
for site in "${GV_SITES[@]}"; do
  dest="$ROOT/$site/fonts/greatvibes"
  mkdir -p "$dest"
  cp -a "$GV_SRC/." "$dest/"
done

FILES=(
  nevia/woff2/Nevia-Light.woff2
  nevia/woff2/Nevia-LightCondensed.woff2
  nevia/woff2/Nevia-Regular.woff2
  nevia/woff2/Nevia-ExtraBold.woff2
  nevia/woff2/Nevia-ExtraBoldCondensed.woff2
  nevia/woff2/Nevia-Black.woff2
  urema/woff2/Urema-Variable.woff2
)
BRAND_SITES=(brand site/brand site/boot/brand explorer/brand mempool/brand pool/public/brand team/brand)

if [[ -n "${SHEAR_FONTS_DIR:-}" ]]; then
  for f in "${FILES[@]}"; do
    [[ -f "$SHEAR_FONTS_DIR/$f" ]] || { echo "install_fonts: missing $SHEAR_FONTS_DIR/$f" >&2; exit 1; }
  done
  for site in "${BRAND_SITES[@]}"; do
    for f in "${FILES[@]}"; do
      install -D -m 0644 "$SHEAR_FONTS_DIR/$f" "$ROOT/$site/fonts/$f"
    done
  done
  commercial="${#BRAND_SITES[@]} sites x ${#FILES[@]} commercial fonts"
else
  commercial="commercial fonts skipped (SHEAR_FONTS_DIR unset)"
fi

# Nevia and Urema must not be tracked. Great Vibes under fonts/greatvibes/ may be.
tracked="$(git -C "$ROOT" ls-files -- '*.woff2' '*.woff' '*.otf' '*.eot' '*.ttf' || true)"
bad="$(printf '%s\n' "$tracked" | grep -v -E '^(fonts/greatvibes/.*)?$' | grep -v '^$' || true)"
if [[ -n "$bad" ]]; then
  echo "install_fonts: licensed font files are tracked by git; refusing" >&2
  printf '%s\n' "$bad" >&2
  exit 1
fi
echo "install_fonts_ok greatvibes ${#GV_SITES[@]} sites; $commercial"
