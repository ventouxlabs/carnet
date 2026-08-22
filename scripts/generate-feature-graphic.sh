#!/usr/bin/env bash
#
# Generate the Google Play feature graphic (1024x500 PNG) from the app icon
# and the "Stamped Paper" design tokens (DESIGN.md). Output lands in the
# shared fastlane images dir so any store can reuse it.
#
# Requires: ImageMagick (`magick`) and the repo's node_modules (fonts come
# from @expo-google-fonts — run `npm ci` first).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$REPO_ROOT/fastlane/metadata/android/en-US/images/featureGraphic.png"
ICON="$REPO_ROOT/apps/mobile/assets/icon.png"
FONT_TITLE="$REPO_ROOT/node_modules/@expo-google-fonts/space-grotesk/700Bold/SpaceGrotesk_700Bold.ttf"
FONT_TAG="$REPO_ROOT/node_modules/@expo-google-fonts/inter/400Regular/Inter_400Regular.ttf"

# Stamped Paper tokens (light mode) — DESIGN.md is the source of truth.
PAPER="#F5F2EA"
INK="#22201C"
INK_SOFT="#6B665C"
TEAL="#2C6155"

for f in "$ICON" "$FONT_TITLE" "$FONT_TAG"; do
  if [ ! -f "$f" ]; then
    echo "ERROR: missing input $f (run npm ci for fonts)" >&2
    exit 1
  fi
done
if ! command -v magick >/dev/null 2>&1; then
  echo "ERROR: ImageMagick 'magick' not found." >&2
  exit 1
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Icon at 240px with a 48px-radius rounded mask (matches Android's rounded
# launcher shape closely enough for marketing use).
magick "$ICON" -resize 240x240 "$WORK/icon.png"
# Mask must be white-on-black: CopyOpacity reads luminance, so an unfilled
# draw on a transparent canvas would yield an all-black mask (invisible icon).
magick -size 240x240 xc:black -fill white -draw "roundrectangle 0,0,239,239,48,48" "$WORK/mask.png"
magick "$WORK/icon.png" "$WORK/mask.png" -alpha off -compose CopyOpacity -composite "$WORK/icon-rounded.png"

# Canvas: warm paper, teal baseline rule under the wordmark, icon left,
# type block right. Tagline mirrors fastlane short_description.
magick -size 1024x500 "xc:$PAPER" \
  -fill "$TEAL" -draw "rectangle 372,318 952,324" \
  \( "$WORK/icon-rounded.png" \) -geometry +92+130 -composite \
  -font "$FONT_TITLE" -pointsize 104 -fill "$INK" \
  -annotate +372+282 "Carnet" \
  -font "$FONT_TAG" -pointsize 30 -fill "$INK_SOFT" \
  -annotate +374+382 "Mobile-first Markdown capture" \
  -annotate +374+426 "for your Obsidian vault — offline, no server" \
  "$OUT"

magick identify "$OUT"
echo "✓ Wrote $OUT"
