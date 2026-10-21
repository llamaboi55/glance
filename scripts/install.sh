#!/bin/sh
# One-command install for macOS and Linux:
#   curl -fsSL https://raw.githubusercontent.com/llamaboi55/glance/main/scripts/install.sh | sh
# Downloads the latest release from GitHub and installs it. Run it again to update.
set -eu

REPO="llamaboi55/glance"
API="https://api.github.com/repos/$REPO/releases/latest"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

say() { printf '\033[1;32m==>\033[0m %s\n' "$1"; }
fail() { printf '\033[1;31merror:\033[0m %s\n' "$1" >&2; exit 1; }

command -v curl >/dev/null || fail "curl is required"
# Every download URL of the latest release, one per line.
URLS=$(curl -fsSL "$API" | grep -o '"browser_download_url": *"[^"]*"' | sed 's/.*"\(https[^"]*\)"/\1/') \
  || fail "couldn't reach GitHub. Check your connection and try again."
pick() { printf '%s\n' "$URLS" | grep -E "$1" | head -n 1; }

case "$(uname -s)" in
Darwin)
  URL=$(pick '_universal\.dmg$')
  [ -n "$URL" ] || fail "no macOS build in the latest release yet"
  say "Downloading $(basename "$URL")"
  curl -fL --progress-bar -o "$TMP/Glance.dmg" "$URL"
  MNT="$TMP/mnt"; mkdir -p "$MNT"
  hdiutil attach -nobrowse -quiet -mountpoint "$MNT" "$TMP/Glance.dmg"
  DEST=/Applications
  [ -w "$DEST" ] || DEST="$HOME/Applications"
  mkdir -p "$DEST"
  pkill -x Glance 2>/dev/null || true
  rm -rf "$DEST/Glance.app"
  cp -R "$MNT/Glance.app" "$DEST/"
  hdiutil detach -quiet "$MNT"
  say "Installed to $DEST/Glance.app"
  open "$DEST/Glance.app"
  ;;
Linux)
  ARCH=$(uname -m)
  [ "$ARCH" = x86_64 ] || fail "only x86_64 Linux builds are published so far (you have $ARCH). Build from source: see the README."
  SUDO=""; [ "$(id -u)" -eq 0 ] || SUDO="sudo"
  if command -v apt-get >/dev/null && [ -n "$(pick '_amd64\.deb$')" ]; then
    URL=$(pick '_amd64\.deb$')
    say "Downloading $(basename "$URL")"
    curl -fL --progress-bar -o "$TMP/glance.deb" "$URL"
    say "Installing with apt (it may ask for your password)"
    $SUDO apt-get install -y "$TMP/glance.deb"
  elif { command -v dnf >/dev/null || command -v zypper >/dev/null; } && [ -n "$(pick '\.x86_64\.rpm$')" ]; then
    URL=$(pick '\.x86_64\.rpm$')
    say "Downloading $(basename "$URL")"
    curl -fL --progress-bar -o "$TMP/glance.rpm" "$URL"
    say "Installing (it may ask for your password)"
    if command -v dnf >/dev/null; then $SUDO dnf install -y "$TMP/glance.rpm"; else $SUDO zypper --non-interactive install --allow-unsigned-rpm "$TMP/glance.rpm"; fi
  else
    URL=$(pick '_amd64\.AppImage$')
    [ -n "$URL" ] || fail "no Linux build in the latest release yet"
    BIN="$HOME/.local/bin"; mkdir -p "$BIN"
    say "Downloading $(basename "$URL")"
    curl -fL --progress-bar -o "$BIN/glance" "$URL"
    chmod +x "$BIN/glance"
    APPS="$HOME/.local/share/applications"; mkdir -p "$APPS"
    printf '[Desktop Entry]\nName=Glance\nComment=Keyboard focus follows the screen you look at\nExec=%s\nIcon=glance\nType=Application\nCategories=Utility;\n' "$BIN/glance" > "$APPS/glance.desktop"
    say "Installed to $BIN/glance (make sure $BIN is on your PATH)"
  fi
  say "Done. Open Glance from your app menu. The first time, it shows a short setup."
  ;;
*) fail "this script is for macOS and Linux. On Windows, see the README." ;;
esac
