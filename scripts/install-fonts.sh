#!/usr/bin/env bash
# Installs fonts needed for Chromium to render non-Latin scripts (Hebrew, Arabic)
# and emoji correctly in screenshots. Without these, such text renders as blank
# boxes ("tofu") even though the underlying HTML/text content is captured fine.
#
# Safe to run as a non-root user: installs into ~/.local/share/fonts.
# For Docker images built as root, this still works (installs into /root/.local/share/fonts) -
# just make sure the app runs as the same user, or copy the fonts to a system font dir instead.

set -euo pipefail

FONT_DIR="$HOME/.local/share/fonts"
mkdir -p "$FONT_DIR"

declare -A FONTS=(
  ["NotoSansHebrew.ttf"]="https://github.com/google/fonts/raw/main/ofl/notosanshebrew/NotoSansHebrew%5Bwdth,wght%5D.ttf"
  ["NotoSansArabic.ttf"]="https://github.com/google/fonts/raw/main/ofl/notosansarabic/NotoSansArabic%5Bwdth,wght%5D.ttf"
  ["NotoColorEmoji.ttf"]="https://github.com/google/fonts/raw/main/ofl/notocoloremoji/NotoColorEmoji-Regular.ttf"
)

for name in "${!FONTS[@]}"; do
  if [ ! -f "$FONT_DIR/$name" ]; then
    echo "Downloading $name..."
    curl -fsSL -o "$FONT_DIR/$name" "${FONTS[$name]}"
  else
    echo "$name already present, skipping."
  fi
done

fc-cache -f "$FONT_DIR"
echo "Fonts installed to $FONT_DIR"
